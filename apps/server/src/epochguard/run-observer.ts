import type { AgentRun } from "../types.js";
import {
  AgentAttemptSchema,
  OpaqueIdSchema,
  ROLES,
  RunAssignmentSchema,
  RunUsageSchema,
  TimestampSchema,
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
  type RunAdapterStoreState,
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

export type RoleDispatchInputs = readonly [
  DispatchBindPollInput,
  DispatchBindPollInput,
  DispatchBindPollInput,
];

export interface RoleRunJoinScope {
  sessionId: string;
  actionHash: string;
  assignmentIds: readonly [string, string, string];
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
  return value === null || TimestampSchema.safeParse(value).success;
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

    AgentAttemptSchema.parse(attempt);
    if (attempt.runId === null) {
      attempt.status = status;
    } else if (run !== null && run.id === attempt.runId) {
      const incomingStartedAt =
        run.startedAt !== null && validTimestamp(run.startedAt)
          ? run.startedAt
          : null;
      const incomingCompletedAt =
        run.completedAt !== null && validTimestamp(run.completedAt)
          ? run.completedAt
          : null;
      const startedAtConflicts =
        attempt.runStartedAt !== null &&
        incomingStartedAt !== null &&
        attempt.runStartedAt !== incomingStartedAt;
      const completedAtConflicts =
        attempt.runCompletedAt !== null &&
        incomingCompletedAt !== null &&
        attempt.runCompletedAt !== incomingCompletedAt;
      const candidateStartedAt = attempt.runStartedAt ?? incomingStartedAt;
      const candidateCompletedAt = attempt.runCompletedAt ?? incomingCompletedAt;
      const candidateIsOrdered =
        candidateStartedAt === null ||
        candidateCompletedAt === null ||
        Date.parse(candidateStartedAt) <= Date.parse(candidateCompletedAt);

      if (!startedAtConflicts && !completedAtConflicts && candidateIsOrdered) {
        if (attempt.runStartedAt === null && incomingStartedAt !== null) {
          attempt.runStartedAt = incomingStartedAt;
          if (attempt.status === "QUEUED") attempt.status = "RUNNING";
        }
        if (attempt.runCompletedAt === null && incomingCompletedAt !== null) {
          attempt.runCompletedAt = incomingCompletedAt;
        }
      }

      // A bound Attempt becomes terminal only when the authoritative Run
      // supplied a real completion timestamp. Timeouts and observer failures
      // preserve QUEUED/RUNNING evidence rather than inventing completion.
      if (attempt.runCompletedAt !== null) {
        attempt.status = status;
        const usage =
          run.usage === null ? null : RunUsageSchema.safeParse(run.usage);
        if (usage !== null && usage.success) attempt.usage = usage.data;
      }
    }
    assignment.status = "REJECTED";
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
      if (run.completedAt === null) {
        throw new RunAdapterError(
          "RUN_FAILED",
          "Failed Run lacks authoritative completion evidence",
        );
      }
      return {
        status: "FAILED",
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        outputDigest: null,
      };
    case "cancelled":
      if (run.completedAt === null) {
        throw new RunAdapterError(
          "RUN_FAILED",
          "Cancelled Run lacks authoritative completion evidence",
        );
      }
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

    if (
      attemptStatusRank(attempt.status) === 4 &&
      attempt.status !== target.status
    ) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Observed Run terminal status changed",
        attempt,
      );
    }
    if (
      attempt.runStartedAt !== null &&
      target.startedAt !== null &&
      attempt.runStartedAt !== target.startedAt
    ) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Observed Run start timestamp changed",
        attempt,
      );
    }
    if (
      attempt.runCompletedAt !== null &&
      target.completedAt !== null &&
      attempt.runCompletedAt !== target.completedAt
    ) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Observed Run completion timestamp changed",
        attempt,
      );
    }

    attempt.status = target.status;
    attempt.runStartedAt ??= target.startedAt;
    attempt.runCompletedAt ??= target.completedAt;
    validateTimestampOrder(attempt.runStartedAt, attempt.runCompletedAt);
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
        "FAILED",
        null,
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
      attempt = await mirrorRun(ports.store, input, assignment, run);
    } catch (error) {
      const failed = await failAttempt(
        ports.store,
        input,
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

function roleRunJoinScope(
  inputs: RoleDispatchInputs,
  store: StorePort,
): RoleRunJoinScope {
  const assignmentIds = inputs.map((input) => input.assignmentId);
  const attemptIds = inputs.map((input) => input.attemptId);
  if (
    new Set(assignmentIds).size !== ROLES.length ||
    new Set(attemptIds).size !== ROLES.length
  ) {
    throw new RunAdapterError(
      "BINDING_MISMATCH",
      "Role fan-out requires three distinct Assignment and Attempt IDs",
    );
  }

  const database = store.snapshot();
  const assignments = inputs.map((input) =>
    RunAssignmentSchema.parse(
      requireSingle(
        database.runAssignments,
        (item) => item.assignmentId === input.assignmentId,
        `Assignment ${input.assignmentId}`,
      ),
    ),
  );
  const first = assignments[0]!;
  const roles = new Set<Role>();
  for (let index = 0; index < assignments.length; index += 1) {
    const assignment = assignments[index]!;
    const input = inputs[index]!;
    const attempt = AgentAttemptSchema.parse(
      requireSingle(
        database.attempts,
        (item) => item.attemptId === input.attemptId,
        `Attempt ${input.attemptId}`,
      ),
    );
    if (
      assignment.sessionId !== first.sessionId ||
      assignment.actionHash !== first.actionHash ||
      attempt.assignmentId !== assignment.assignmentId ||
      attempt.sessionId !== assignment.sessionId ||
      attempt.actionHash !== assignment.actionHash ||
      attempt.role !== assignment.role ||
      attempt.agentId !== assignment.agentId ||
      roles.has(assignment.role)
    ) {
      throw new RunAdapterError(
        "BINDING_MISMATCH",
        "Role fan-out cannot mix Session, Action, Role, Assignment, or Agent bindings",
        attempt,
      );
    }
    roles.add(assignment.role);
  }
  if (ROLES.some((role) => !roles.has(role))) {
    throw new RunAdapterError(
      "BINDING_MISMATCH",
      "Role fan-out is missing a required Role",
    );
  }
  return {
    sessionId: first.sessionId,
    actionHash: first.actionHash,
    assignmentIds: assignmentIds as [string, string, string],
  };
}

/** Creates all three dispatch promises before awaiting their fail-closed join. */
export async function fanOutDispatchBindPoll(
  inputs: RoleDispatchInputs,
  ports: RoleProfilePorts,
  options: RunObserverOptions = {},
): Promise<JoinedRoleRunObservations> {
  const scope = roleRunJoinScope(inputs, ports.store);
  const settled = await Promise.allSettled(
    inputs.map((input) => dispatchBindPoll(input, ports, options)),
  );
  return joinRoleRunObservations(settled, ports.store, scope);
}

type JoinMutationOutcome =
  | { ok: true; value: JoinedRoleRunObservations }
  | {
      ok: false;
      code: RunAdapterFailureCode;
      message: string;
      attempt: AgentAttempt | null;
      rejectedProvenanceIndex: number | null;
    };

function rejectedJoinOutcome(
  database: RunAdapterStoreState,
  scope: RoleRunJoinScope,
  code: RunAdapterFailureCode,
  message: string,
  attempt: AgentAttempt | null = null,
  rejectedProvenanceIndex: number | null = null,
): JoinMutationOutcome {
  const siblingIds = new Set(scope.assignmentIds);
  for (const assignment of database.runAssignments) {
    if (
      siblingIds.has(assignment.assignmentId) &&
      assignment.sessionId === scope.sessionId &&
      assignment.actionHash === scope.actionHash &&
      assignment.status !== "CONSUMED"
    ) {
      assignment.status = "REJECTED";
    }
  }
  return {
    ok: false,
    code,
    message,
    attempt,
    rejectedProvenanceIndex,
  };
}

const terminalAttemptStatuses = new Set<AgentAttempt["status"]>([
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "OUTPUT_REJECTED",
  "ACCEPTED",
]);

function firstTerminalRejectionIndex(
  settled: readonly PromiseSettledResult<TerminalRunObservation>[],
  database: RunAdapterStoreState,
  scope: RoleRunJoinScope,
): number | null {
  if (settled.length !== ROLES.length) return null;
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index]!;
    if (result.status !== "rejected" || !(result.reason instanceof RunAdapterError)) {
      continue;
    }
    const parsedAttempt = AgentAttemptSchema.safeParse(result.reason.attempt);
    if (
      !parsedAttempt.success ||
      !terminalAttemptStatuses.has(parsedAttempt.data.status) ||
      parsedAttempt.data.runId === null ||
      parsedAttempt.data.runCompletedAt === null ||
      parsedAttempt.data.assignmentId !== scope.assignmentIds[index]
    ) {
      continue;
    }
    const attempt = parsedAttempt.data;
    const storedAttempts = database.attempts.filter(
      (item) => item.attemptId === attempt.attemptId,
    );
    const storedAttempt =
      storedAttempts.length === 1
        ? AgentAttemptSchema.safeParse(storedAttempts[0])
        : null;
    const assignments = database.runAssignments.filter(
      (item) => item.assignmentId === attempt.assignmentId,
    );
    const assignment =
      assignments.length === 1
        ? RunAssignmentSchema.safeParse(assignments[0])
        : null;
    if (
      storedAttempt !== null &&
      storedAttempt.success &&
      JSON.stringify(storedAttempt.data) === JSON.stringify(attempt) &&
      assignment !== null &&
      assignment.success &&
      assignment.data.sessionId === scope.sessionId &&
      assignment.data.actionHash === scope.actionHash &&
      assignment.data.sessionId === attempt.sessionId &&
      assignment.data.actionHash === attempt.actionHash &&
      assignment.data.role === attempt.role &&
      assignment.data.agentId === attempt.agentId &&
      assignment.data.boundRunId === attempt.runId &&
      assignment.data.status !== "CONSUMED"
    ) {
      return index;
    }
  }
  return null;
}

/**
 * Atomically validates the three observations or rejects every unconsumed
 * sibling Assignment. Attempt records are never rewritten by the join.
 */
export async function joinRoleRunObservations(
  settled: readonly PromiseSettledResult<TerminalRunObservation>[],
  store: StorePort,
  scope: RoleRunJoinScope,
): Promise<JoinedRoleRunObservations> {
  const outcome = await store.mutate((database): JoinMutationOutcome => {
    if (
      settled.length !== ROLES.length ||
      settled.some((item) => item.status === "rejected")
    ) {
      const rejectedProvenanceIndex = firstTerminalRejectionIndex(
        settled,
        database,
        scope,
      );
      return rejectedJoinOutcome(
        database,
        scope,
        "RUN_FAILED",
        "All three Role Runs must complete before Decision composition",
        null,
        rejectedProvenanceIndex,
      );
    }
    if (
      scope.assignmentIds.length !== ROLES.length ||
      new Set(scope.assignmentIds).size !== ROLES.length
    ) {
      return rejectedJoinOutcome(
        database,
        scope,
        "BINDING_MISMATCH",
        "Role join scope must contain three distinct sibling Assignments",
      );
    }

    const storedAssignments = new Map<string, RunAssignment>();
    for (const assignmentId of scope.assignmentIds) {
      const matches = database.runAssignments.filter(
        (item) => item.assignmentId === assignmentId,
      );
      const parsed =
        matches.length === 1
          ? RunAssignmentSchema.safeParse(matches[0])
          : null;
      if (
        parsed === null ||
        !parsed.success ||
        parsed.data.sessionId !== scope.sessionId ||
        parsed.data.actionHash !== scope.actionHash
      ) {
        return rejectedJoinOutcome(
          database,
          scope,
          "BINDING_MISMATCH",
          "Role join scope does not resolve to one Session and Action",
        );
      }
      storedAssignments.set(assignmentId, parsed.data);
    }

    const fulfilled = settled.map(
      (item) => (item as PromiseFulfilledResult<TerminalRunObservation>).value,
    );
    const byRole = new Map<Role, TerminalRunObservation>();
    const agentIds = new Set<string>();
    const runIds = new Set<string>();
    for (const observation of fulfilled) {
      const parsedAttempt = AgentAttemptSchema.safeParse(observation.attempt);
      if (!parsedAttempt.success) {
        return rejectedJoinOutcome(
          database,
          scope,
          "BINDING_MISMATCH",
          "Role join received a malformed Attempt",
        );
      }
      const attempt = parsedAttempt.data;
      const assignment = storedAssignments.get(observation.assignmentId);
      const storedAttempts = database.attempts.filter(
        (item) => item.attemptId === attempt.attemptId,
      );
      const storedAttempt =
        storedAttempts.length === 1
          ? AgentAttemptSchema.safeParse(storedAttempts[0])
          : null;
      const outputDigestMatches =
        typeof observation.output === "string" &&
        sha256Digest(observation.output) === attempt.outputDigest;
      if (
        attempt.status !== "COMPLETED" ||
        attempt.sessionId !== scope.sessionId ||
        attempt.actionHash !== scope.actionHash ||
        observation.assignmentId !== attempt.assignmentId ||
        assignment === undefined ||
        assignment.assignmentId !== attempt.assignmentId ||
        assignment.sessionId !== attempt.sessionId ||
        assignment.actionHash !== attempt.actionHash ||
        assignment.role !== attempt.role ||
        assignment.agentId !== attempt.agentId ||
        assignment.status !== "BOUND" ||
        assignment.boundRunId !== observation.runId ||
        assignment.consumedByDecisionCertificateId !== null ||
        assignment.consumedAt !== null ||
        storedAttempt === null ||
        !storedAttempt.success ||
        JSON.stringify(storedAttempt.data) !== JSON.stringify(attempt) ||
        attempt.runId !== observation.runId ||
        attempt.agentId !== observation.agentId ||
        attempt.role !== observation.role ||
        !outputDigestMatches ||
        byRole.has(observation.role) ||
        agentIds.has(observation.agentId) ||
        runIds.has(observation.runId)
      ) {
        return rejectedJoinOutcome(
          database,
          scope,
          "BINDING_MISMATCH",
          "Role join requires matching Session, Action, Assignment, Attempt, output, Agent, and Run evidence",
          attempt,
        );
      }
      byRole.set(observation.role, observation);
      agentIds.add(observation.agentId);
      runIds.add(observation.runId);
    }
    if (ROLES.some((role) => !byRole.has(role))) {
      return rejectedJoinOutcome(
        database,
        scope,
        "BINDING_MISMATCH",
        "Role join is missing a required Role",
      );
    }
    return {
      ok: true,
      value: [
        byRole.get("inventory")!,
        byRole.get("budget")!,
        byRole.get("policy")!,
      ],
    };
  });

  if (!outcome.ok) {
    if (outcome.rejectedProvenanceIndex !== null) {
      const rejected = settled[outcome.rejectedProvenanceIndex];
      if (
        rejected?.status === "rejected" &&
        rejected.reason instanceof RunAdapterError
      ) {
        throw rejected.reason;
      }
    }
    throw new RunAdapterError(
      outcome.code,
      outcome.message,
      outcome.attempt,
    );
  }
  return outcome.value;
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
