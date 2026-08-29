import type { AgentRun } from "../types.js";
import {
  AgentAttemptSchema,
  OpaqueIdSchema,
  ROLES,
  RunAssignmentSchema,
  RunUsageSchema,
  sha256Digest,
  type AgentAttempt,
  type FailureCode,
  type Role,
  type RunAssignment,
} from "./types.js";
import {
  roleExpectationFromAssignment,
  verifyRoleAgentProfile,
  type AgentPort,
  type RoleProfilePorts,
  type StorePort,
} from "./role-profiles.js";

type RunAdapterFailureCode = Extract<
  FailureCode,
  | "ROLE_PROFILE_MISMATCH"
  | "RUN_FAILED"
  | "RUN_TIMEOUT"
  | "BINDING_MISMATCH"
>;

export interface RunObserverClock {
  now(): string;
  monotonicMs(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface RunObserverOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  clock?: RunObserverClock;
}

export interface DispatchBindPollInput {
  assignmentId: string;
  attemptId: string;
}

export interface TerminalRunObservation {
  role: Role;
  agentId: string;
  assignmentId: string;
  runId: string;
  attempt: AgentAttempt;
  /** Untrusted model output; the downstream Normalizer must parse and bind it. */
  output: string;
}

export type JoinedRoleRunObservations = readonly [
  TerminalRunObservation,
  TerminalRunObservation,
  TerminalRunObservation,
];

export class RunAdapterError extends Error {
  readonly attempt: AgentAttempt | null;

  constructor(
    readonly code: RunAdapterFailureCode,
    message: string,
    attempt: AgentAttempt | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunAdapterError";
    this.attempt = attempt === null ? null : structuredClone(attempt);
  }
}

const systemClock: RunObserverClock = {
  now: () => new Date().toISOString(),
  monotonicMs: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

function resolvedOptions(options: RunObserverOptions): {
  pollIntervalMs: number;
  timeoutMs: number;
  clock: RunObserverClock;
} {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 200 || pollIntervalMs > 500) {
    throw new RangeError("pollIntervalMs must be between 200 and 500 milliseconds");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive");
  }
  return {
    pollIntervalMs,
    timeoutMs,
    clock: options.clock ?? systemClock,
  };
}

function requireSingle<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  label: string,
): T {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    throw new RunAdapterError(
      "BINDING_MISMATCH",
      `${label} must resolve to exactly one record`,
    );
  }
  return matches[0]!;
}

function cloneAttempt(attempt: AgentAttempt): AgentAttempt {
  return structuredClone(AgentAttemptSchema.parse(attempt));
}

function validateRunIdentity(
  run: AgentRun,
  assignment: RunAssignment,
  expectedRunId: string | null = null,
): void {
  OpaqueIdSchema.parse(run.id);
  if (
    run.agentId !== assignment.agentId ||
    (expectedRunId !== null && run.id !== expectedRunId)
  ) {
    throw new RunAdapterError(
      "BINDING_MISMATCH",
      `Run ${run.id} does not match the authoritative Agent/Run binding`,
    );
  }
}

function validTimestamp(value: string | null): boolean {
  return value === null || Number.isFinite(Date.parse(value));
}

function validateTimestampOrder(startedAt: string | null, completedAt: string | null): void {
  if (
    !validTimestamp(startedAt) ||
    !validTimestamp(completedAt) ||
    (
    startedAt !== null &&
    completedAt !== null &&
    Date.parse(startedAt) > Date.parse(completedAt))
  ) {
    throw new RunAdapterError(
      "BINDING_MISMATCH",
      "Run completion precedes Run start",
    );
  }
}

function validateDispatchResult(
  run: AgentRun,
  assignment: RunAssignment,
  prompt: string,
): void {
  validateRunIdentity(run, assignment);
  if (
    run.status !== "queued" ||
    run.prompt !== prompt ||
    run.startedAt !== null ||
    run.completedAt !== null ||
    run.threadId !== null ||
    run.output !== null ||
    run.error !== null ||
    run.usage !== null
  ) {
    throw new RunAdapterError(
      "BINDING_MISMATCH",
      "sendMessage did not return a pristine queued Run",
    );
  }
}

function attemptStatusRank(status: AgentAttempt["status"]): number {
  switch (status) {
    case "ASSIGNMENT_CREATED":
      return 0;
    case "DISPATCHING":
      return 1;
    case "QUEUED":
      return 2;
    case "RUNNING":
      return 3;
    case "COMPLETED":
    case "FAILED":
    case "INTERRUPTED":
    case "OUTPUT_REJECTED":
    case "ACCEPTED":
      return 4;
  }
}

async function transitionToDispatching(
  store: StorePort,
  input: DispatchBindPollInput,
): Promise<{ assignment: RunAssignment; attempt: AgentAttempt }> {
  return store.mutate((database) => {
    const assignment = RunAssignmentSchema.parse(
      requireSingle(
        database.runAssignments,
        (item) => item.assignmentId === input.assignmentId,
        `Assignment ${input.assignmentId}`,
      ),
    );
    const attempt = requireSingle(
      database.attempts,
      (item) => item.attemptId === input.attemptId,
      `Attempt ${input.attemptId}`,
    );
    AgentAttemptSchema.parse(attempt);
    if (
      assignment.status !== "CREATED" ||
      assignment.boundRunId !== null ||
      assignment.boundAt !== null ||
      assignment.consumedByDecisionCertificateId !== null ||
      assignment.consumedAt !== null ||
      attempt.status !== "ASSIGNMENT_CREATED" ||
      attempt.runId !== null
    ) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Assignment or Attempt has already entered dispatch",
        attempt,
      );
    }
    if (
      attempt.assignmentId !== assignment.assignmentId ||
      attempt.sessionId !== assignment.sessionId ||
      attempt.actionHash !== assignment.actionHash ||
      attempt.role !== assignment.role ||
      attempt.agentId !== assignment.agentId
    ) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Attempt context does not match Assignment context",
        attempt,
      );
    }
    attempt.status = "DISPATCHING";
    return {
      assignment: structuredClone(assignment),
      attempt: cloneAttempt(attempt),
    };
  });
}

async function bindRunOnce(
  store: StorePort,
  input: DispatchBindPollInput,
  run: AgentRun,
  boundAt: string,
): Promise<AgentAttempt> {
  return store.mutate((database) => {
    const assignment = requireSingle(
      database.runAssignments,
      (item) => item.assignmentId === input.assignmentId,
      `Assignment ${input.assignmentId}`,
    );
    const attempt = requireSingle(
      database.attempts,
      (item) => item.attemptId === input.attemptId,
      `Attempt ${input.attemptId}`,
    );
    if (
      assignment.status !== "CREATED" ||
      assignment.boundRunId !== null ||
      assignment.boundAt !== null ||
      assignment.consumedByDecisionCertificateId !== null ||
      assignment.consumedAt !== null ||
      attempt.status !== "DISPATCHING" ||
      attempt.runId !== null
    ) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Assignment can bind exactly one queued Run",
        attempt,
      );
    }
    if (
      database.runAssignments.some(
        (item) =>
          item.assignmentId !== assignment.assignmentId &&
          item.boundRunId === run.id,
      ) ||
      database.attempts.some(
        (item) => item.attemptId !== attempt.attemptId && item.runId === run.id,
      )
    ) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        `Run ${run.id} is already bound to another Assignment or Attempt`,
        attempt,
      );
    }
    assignment.boundRunId = run.id;
    assignment.boundAt = boundAt;
    assignment.status = "BOUND";
    attempt.runId = run.id;
    attempt.status = "QUEUED";
    RunAssignmentSchema.parse(assignment);
    return cloneAttempt(attempt);
  });
}

async function failAttempt(
  store: StorePort,
  input: DispatchBindPollInput,
  clock: RunObserverClock,
  status: "FAILED" | "INTERRUPTED",
  run: AgentRun | null,
): Promise<AgentAttempt> {
  return store.mutate((database) => {
    const assignment = requireSingle(
      database.runAssignments,
      (item) => item.assignmentId === input.assignmentId,
      `Assignment ${input.assignmentId}`,
    );
    const attempt = requireSingle(
      database.attempts,
      (item) => item.attemptId === input.attemptId,
      `Attempt ${input.attemptId}`,
    );
    if (attempt.status === "ACCEPTED" || assignment.status === "CONSUMED") {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "A consumed Assignment cannot be failed by the Run Observer",
        attempt,
      );
    }

    if (attempt.runId === null) {
      attempt.runStartedAt = null;
      attempt.runCompletedAt = null;
      attempt.threadId = null;
      attempt.usage = null;
      attempt.outputDigest = null;
    } else {
      if (run !== null && run.id !== attempt.runId) {
        throw new RunAdapterError(
          "BINDING_MISMATCH",
          "Failure evidence refers to a different Run",
          attempt,
        );
      }
      attempt.runStartedAt =
        run !== null && validTimestamp(run.startedAt)
          ? run.startedAt
          : attempt.runStartedAt;
      attempt.runCompletedAt =
        run !== null && validTimestamp(run.completedAt) && run.completedAt !== null
          ? run.completedAt
          : clock.now();
      attempt.threadId = null;
      const usage = run?.usage === null || run?.usage === undefined
        ? null
        : RunUsageSchema.safeParse(run.usage);
      attempt.usage = usage === null || !usage.success ? null : usage.data;
      attempt.outputDigest = null;
      validateTimestampOrder(attempt.runStartedAt, attempt.runCompletedAt);
    }
    attempt.status = status;
    if (assignment.status === "CREATED" || assignment.status === "BOUND") {
      assignment.status = "REJECTED";
    }
    RunAssignmentSchema.parse(assignment);
    return cloneAttempt(attempt);
  });
}

async function rejectCompletedOutput(
  store: StorePort,
  input: DispatchBindPollInput,
): Promise<AgentAttempt> {
  return store.mutate((database) => {
    const assignment = requireSingle(
      database.runAssignments,
      (item) => item.assignmentId === input.assignmentId,
      `Assignment ${input.assignmentId}`,
    );
    const attempt = requireSingle(
      database.attempts,
      (item) => item.attemptId === input.attemptId,
      `Attempt ${input.attemptId}`,
    );
    if (assignment.status !== "BOUND" || attempt.status !== "COMPLETED") {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Only a completed bound Run output can be rejected",
        attempt,
      );
    }
    assignment.status = "REJECTED";
    attempt.status = "OUTPUT_REJECTED";
    RunAssignmentSchema.parse(assignment);
    return cloneAttempt(attempt);
  });
}

function targetAttemptFromRun(run: AgentRun): {
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED";
  startedAt: string | null;
  completedAt: string | null;
  outputDigest: string | null;
} {
  validateTimestampOrder(run.startedAt, run.completedAt);
  switch (run.status) {
    case "queued":
      if (run.startedAt !== null || run.completedAt !== null) {
        throw new RunAdapterError(
          "BINDING_MISMATCH",
          "Queued Run contains start or completion evidence",
        );
      }
      return {
        status: "QUEUED",
        startedAt: null,
        completedAt: null,
        outputDigest: null,
      };
    case "running":
      if (run.startedAt === null || run.completedAt !== null) {
        throw new RunAdapterError(
          "BINDING_MISMATCH",
          "Running Run lacks exact start evidence",
        );
      }
      return {
        status: "RUNNING",
        startedAt: run.startedAt,
        completedAt: null,
        outputDigest: null,
      };
    case "completed":
      if (
        run.startedAt === null ||
        run.completedAt === null ||
        run.output === null
      ) {
        throw new RunAdapterError(
          "RUN_FAILED",
          "Completed Run lacks terminal output or time evidence",
        );
      }
      return {
        status: "COMPLETED",
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        outputDigest: sha256Digest(run.output),
      };
    case "failed":
      return {
        status: "FAILED",
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        outputDigest: null,
      };
    case "cancelled":
      return {
        status: "INTERRUPTED",
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        outputDigest: null,
      };
  }
}

async function mirrorRun(
  store: StorePort,
  input: DispatchBindPollInput,
  assignment: RunAssignment,
  run: AgentRun,
  clock: RunObserverClock,
): Promise<AgentAttempt> {
  validateRunIdentity(run, assignment);
  const target = targetAttemptFromRun(run);
  return store.mutate((database) => {
    const storedAssignment = requireSingle(
      database.runAssignments,
      (item) => item.assignmentId === input.assignmentId,
      `Assignment ${input.assignmentId}`,
    );
    const attempt = requireSingle(
      database.attempts,
      (item) => item.attemptId === input.attemptId,
      `Attempt ${input.attemptId}`,
    );
    if (
      storedAssignment.boundRunId !== run.id ||
      attempt.runId !== run.id ||
      (storedAssignment.status !== "BOUND" &&
        storedAssignment.status !== "REJECTED")
    ) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Observed Run is not the Assignment-bound Run",
        attempt,
      );
    }
    if (attemptStatusRank(target.status) < attemptStatusRank(attempt.status)) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Observed Run status regressed",
        attempt,
      );
    }

    attempt.status = target.status;
    attempt.runStartedAt = target.startedAt;
    attempt.runCompletedAt =
      (target.status === "FAILED" || target.status === "INTERRUPTED") &&
      target.completedAt === null
        ? clock.now()
        : target.completedAt;
    attempt.threadId = target.status === "COMPLETED" ? run.threadId : null;
    attempt.usage =
      run.usage === null ? null : RunUsageSchema.parse(run.usage);
    attempt.outputDigest = target.outputDigest;
    if (target.status === "FAILED" || target.status === "INTERRUPTED") {
      storedAssignment.status = "REJECTED";
    }
    RunAssignmentSchema.parse(storedAssignment);
    return cloneAttempt(attempt);
  });
}

export function buildAssignmentPrompt(assignment: RunAssignment): string {
  const roleName: Record<Role, string> = {
    inventory: "Inventory",
    budget: "Budget",
    policy: "Policy",
  };
  return [
    `You are the ${roleName[assignment.role]} Agent for assignment ${assignment.assignmentId}.`,
    `Read ${assignment.evidencePackRelativePath}.`,
    "Use only the immutable action and evidence in that file.",
    "Do not infer missing facts or claim a publish action.",
    "Return exactly one <EPOCH_DECISION>{...}</EPOCH_DECISION> envelope.",
  ].join("\n");
}

/**
 * Dispatches one frozen Assignment, binds exactly the Run returned by
 * AgentService, mirrors authoritative Run state, and returns untrusted output
 * only after the second on-disk Role Profile digest check succeeds.
 */
export async function dispatchBindPoll(
  input: DispatchBindPollInput,
  ports: RoleProfilePorts,
  options: RunObserverOptions = {},
): Promise<TerminalRunObservation> {
  const { pollIntervalMs, timeoutMs, clock } = resolvedOptions(options);
  const transitioned = await transitionToDispatching(ports.store, input);
  const assignment = transitioned.assignment;

  try {
    await verifyRoleAgentProfile(roleExpectationFromAssignment(assignment), ports);
  } catch (error) {
    const failed = await failAttempt(
      ports.store,
      input,
      clock,
      "FAILED",
      null,
    );
    throw new RunAdapterError(
      "ROLE_PROFILE_MISMATCH",
      "Role Profile failed the pre-dispatch verification",
      failed,
      { cause: error },
    );
  }

  let dispatchedRun: AgentRun;
  try {
    const prompt = buildAssignmentPrompt(assignment);
    const dispatched = await ports.agents.sendMessage(
      assignment.agentId,
      prompt,
    );
    dispatchedRun = structuredClone(dispatched.run);
    validateDispatchResult(dispatchedRun, assignment, prompt);
  } catch (error) {
    const failed = await failAttempt(
      ports.store,
      input,
      clock,
      "FAILED",
      null,
    );
    const code =
      error instanceof RunAdapterError && error.code === "BINDING_MISMATCH"
        ? "BINDING_MISMATCH"
        : "RUN_FAILED";
    throw new RunAdapterError(
      code,
      "Role Run could not be dispatched as a pristine queued Run",
      failed,
      { cause: error },
    );
  }

  try {
    await bindRunOnce(ports.store, input, dispatchedRun, clock.now());
  } catch (error) {
    const failed = await failAttempt(
      ports.store,
      input,
      clock,
      "FAILED",
      null,
    );
    throw new RunAdapterError(
      "BINDING_MISMATCH",
      "Assignment rejected a second or stale Run binding",
      failed,
      { cause: error },
    );
  }

  const pollingStartedAt = clock.monotonicMs();
  while (true) {
    let run: AgentRun;
    try {
      run = structuredClone(ports.agents.getRun(dispatchedRun.id));
      validateRunIdentity(run, assignment, dispatchedRun.id);
    } catch (error) {
      const failed = await failAttempt(
        ports.store,
        input,
        clock,
        "FAILED",
        dispatchedRun,
      );
      const code =
        error instanceof RunAdapterError && error.code === "BINDING_MISMATCH"
          ? "BINDING_MISMATCH"
          : "RUN_FAILED";
      throw new RunAdapterError(
        code,
        "Assignment-bound Run could not be observed",
        failed,
        { cause: error },
      );
    }

    let attempt: AgentAttempt;
    try {
      attempt = await mirrorRun(ports.store, input, assignment, run, clock);
    } catch (error) {
      const failed = await failAttempt(
        ports.store,
        input,
        clock,
        "FAILED",
        run,
      );
      const code =
        error instanceof RunAdapterError ? error.code : "RUN_FAILED";
      throw new RunAdapterError(
        code,
        "Run timeline evidence could not be mirrored",
        failed,
        { cause: error },
      );
    }

    if (attempt.status === "COMPLETED") {
      try {
        await verifyRoleAgentProfile(
          roleExpectationFromAssignment(assignment),
          ports,
        );
      } catch (error) {
        const rejected = await rejectCompletedOutput(ports.store, input);
        throw new RunAdapterError(
          "ROLE_PROFILE_MISMATCH",
          "Role Profile changed after dispatch; output was rejected",
          rejected,
          { cause: error },
        );
      }
      return {
        role: assignment.role,
        agentId: assignment.agentId,
        assignmentId: assignment.assignmentId,
        runId: attempt.runId!,
        attempt,
        output: run.output!,
      };
    }

    if (attempt.status === "FAILED" || attempt.status === "INTERRUPTED") {
      throw new RunAdapterError(
        "RUN_FAILED",
        `Role Run reached terminal status ${attempt.status}`,
        attempt,
      );
    }

    if (clock.monotonicMs() - pollingStartedAt >= timeoutMs) {
      const failed = await failAttempt(
        ports.store,
        input,
        clock,
        "FAILED",
        run,
      );
      throw new RunAdapterError(
        "RUN_TIMEOUT",
        "Role Run polling timed out",
        failed,
      );
    }
    await clock.sleep(pollIntervalMs);
  }
}

/** Fail-closed join used by EG-08 after Promise.allSettled(). */
export function joinRoleRunObservations(
  settled: readonly PromiseSettledResult<TerminalRunObservation>[],
): JoinedRoleRunObservations {
  if (settled.length !== ROLES.length || settled.some((item) => item.status === "rejected")) {
    throw new RunAdapterError(
      "RUN_FAILED",
      "All three Role Runs must complete before Decision composition",
    );
  }
  const fulfilled = settled.map(
    (item) => (item as PromiseFulfilledResult<TerminalRunObservation>).value,
  );
  const byRole = new Map<Role, TerminalRunObservation>();
  const agentIds = new Set<string>();
  const runIds = new Set<string>();
  for (const observation of fulfilled) {
    AgentAttemptSchema.parse(observation.attempt);
    if (
      observation.attempt.status !== "COMPLETED" ||
      observation.attempt.runId !== observation.runId ||
      observation.attempt.agentId !== observation.agentId ||
      observation.attempt.role !== observation.role ||
      byRole.has(observation.role) ||
      agentIds.has(observation.agentId) ||
      runIds.has(observation.runId)
    ) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Role join requires distinct Role, Agent, and authoritative Run identities",
        observation.attempt,
      );
    }
    byRole.set(observation.role, observation);
    agentIds.add(observation.agentId);
    runIds.add(observation.runId);
  }
  if (ROLES.some((role) => !byRole.has(role))) {
    throw new RunAdapterError(
      "BINDING_MISMATCH",
      "Role join is missing a required Role",
    );
  }
  return [
    byRole.get("inventory")!,
    byRole.get("budget")!,
    byRole.get("policy")!,
  ];
}

/**
 * Reports concurrency only when all three distinct authoritative Run
 * intervals share a strictly positive wall-clock intersection.
 */
export function deriveCoordinationMode(
  attempts: readonly AgentAttempt[],
): "CONCURRENT" | "SEQUENTIAL_FALLBACK" {
  if (attempts.length !== ROLES.length) return "SEQUENTIAL_FALLBACK";
  const roles = new Set<Role>();
  const agentIds = new Set<string>();
  const runIds = new Set<string>();
  const starts: number[] = [];
  const completions: number[] = [];

  for (const candidate of attempts) {
    const parsed = AgentAttemptSchema.safeParse(candidate);
    if (!parsed.success) return "SEQUENTIAL_FALLBACK";
    const attempt = parsed.data;
    if (
      !["COMPLETED", "OUTPUT_REJECTED", "ACCEPTED"].includes(attempt.status) ||
      roles.has(attempt.role) ||
      agentIds.has(attempt.agentId) ||
      attempt.runId === null ||
      runIds.has(attempt.runId) ||
      attempt.runStartedAt === null ||
      attempt.runCompletedAt === null
    ) {
      return "SEQUENTIAL_FALLBACK";
    }
    const startedAt = Date.parse(attempt.runStartedAt);
    const completedAt = Date.parse(attempt.runCompletedAt);
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      startedAt >= completedAt
    ) {
      return "SEQUENTIAL_FALLBACK";
    }
    roles.add(attempt.role);
    agentIds.add(attempt.agentId);
    runIds.add(attempt.runId);
    starts.push(startedAt);
    completions.push(completedAt);
  }

  if (ROLES.some((role) => !roles.has(role))) return "SEQUENTIAL_FALLBACK";
  return Math.max(...starts) < Math.min(...completions)
    ? "CONCURRENT"
    : "SEQUENTIAL_FALLBACK";
}

export type { AgentPort, StorePort };
