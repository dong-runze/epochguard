import { describe, expect, it } from "vitest";
import type { Agent, AgentRun, CreateAgentInput } from "../types.js";
import {
  ROLE_PROFILES,
  initialAttemptForAssignment,
  type AgentPort,
  type RoleProfilePorts,
  type RunAdapterStoreState,
  type StorePort,
  type WorkspacePort,
} from "./role-profiles.js";
import {
  RunAdapterError,
  deriveCoordinationMode,
  dispatchBindPoll,
  fanOutDispatchBindPoll,
  joinRoleRunObservations,
  type RoleDispatchInputs,
  type RoleRunJoinScope,
  type RunObserverClock,
  type TerminalRunObservation,
} from "./run-observer.js";
import {
  AgentAttemptSchema,
  GOLDEN_ACTION_HASH,
  ROLES,
  RoleAgentRegistrationSchema,
  RunAssignmentSchema,
  TimestampSchema,
  sha256Digest,
  type AgentAttempt,
  type Role,
  type RunAssignment,
} from "./types.js";

const createdAt = "2026-08-29T12:00:00.000Z";
const profileDigest = sha256Digest("controlled AGENTS.md");

class FakeClock implements RunObserverClock {
  private wallMilliseconds = Date.parse(createdAt);
  private monotonicMilliseconds = 0;

  now(): string {
    return new Date(this.wallMilliseconds).toISOString();
  }

  monotonicMs(): number {
    return this.monotonicMilliseconds;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.monotonicMilliseconds += milliseconds;
    this.wallMilliseconds += milliseconds;
  }
}

class MemoryStore implements StorePort {
  readonly history: RunAdapterStoreState[] = [];
  private writerQueue: Promise<void> = Promise.resolve();

  constructor(public state: RunAdapterStoreState) {}

  snapshot(): RunAdapterStoreState {
    return structuredClone(this.state);
  }

  mutate<T>(
    mutation: (database: RunAdapterStoreState) => T | Promise<T>,
  ): Promise<T> {
    const write = this.writerQueue.then(async () => {
      const next = structuredClone(this.state);
      const result = await mutation(next);
      this.state = next;
      this.history.push(structuredClone(next));
      return result;
    });
    this.writerQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }
}

class RunHarness implements AgentPort, WorkspacePort {
  readonly sentPrompts: string[] = [];
  readonly agents = new Map<string, Agent>();
  readonly digests = new Map<string, string>();
  runSequence: Array<AgentRun | Error> = [];
  dispatchRun: AgentRun;
  onSend: (() => void | Promise<void>) | null = null;
  private lastObservedRun: AgentRun;

  constructor(agent: Agent, queuedRun: AgentRun) {
    this.agents.set(agent.id, structuredClone(agent));
    this.digests.set(agent.id, profileDigest);
    this.dispatchRun = structuredClone(queuedRun);
    this.lastObservedRun = structuredClone(queuedRun);
  }

  getAgent(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error("Agent not found");
    return structuredClone(agent);
  }

  async createAgent(_input: CreateAgentInput): Promise<Agent> {
    throw new Error("not used by Run Observer tests");
  }

  async sendMessage(agentId: string, prompt: string): Promise<{ run: AgentRun }> {
    this.sentPrompts.push(prompt);
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error("Agent not found");
    agent.status = "busy";
    await this.onSend?.();
    return { run: { ...structuredClone(this.dispatchRun), prompt } };
  }

  getRun(runId: string): AgentRun {
    if (runId !== this.dispatchRun.id) throw new Error("Run not found");
    const next = this.runSequence.shift();
    if (next instanceof Error) throw next;
    if (next) this.lastObservedRun = structuredClone(next);
    const agent = this.agents.get(this.lastObservedRun.agentId);
    if (agent) {
      agent.status =
        this.lastObservedRun.status === "queued" ||
        this.lastObservedRun.status === "running"
          ? "busy"
          : this.lastObservedRun.status === "failed"
            ? "error"
            : "ready";
    }
    return structuredClone(this.lastObservedRun);
  }

  async readAgentsMdDigest(agentId: string): Promise<string> {
    const digest = this.digests.get(agentId);
    if (!digest) throw new Error("AGENTS.md not found");
    return digest;
  }
}

function makeAgent(role: Role): Agent {
  return {
    id: `agent_${role}`,
    name: ROLE_PROFILES[role].agentName,
    description: ROLE_PROFILES[role].description,
    instructions: ROLE_PROFILES[role].instructions,
    status: "ready",
    workspacePath: `C:/controlled/agent_${role}`,
    codexThreadId: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeAssignment(
  role: Role,
  overrides: Partial<RunAssignment> = {},
): RunAssignment {
  return RunAssignmentSchema.parse({
    assignmentId: `assignment_${role}`,
    sessionId: "session_run_observer",
    actionHash: GOLDEN_ACTION_HASH,
    agentId: `agent_${role}`,
    agentNameAtAssignment: ROLE_PROFILES[role].agentName,
    role,
    receiptId: `receipt_${role}`,
    queryHash: sha256Digest(`query_${role}`),
    roleProfileVersion: ROLE_PROFILES[role].roleProfileVersion,
    promptTemplateVersion: "epoch-prompt-v1",
    agentsMdDigest: profileDigest,
    runtimeLabelAtDispatch: "ControlledRunner",
    evidencePackRelativePath:
      `.epochguard/sessions/session_run_observer/${role}/assignment_${role}.json`,
    evidencePackHash: sha256Digest(`pack_${role}`),
    boundRunId: null,
    status: "CREATED",
    consumedByDecisionCertificateId: null,
    createdAt,
    boundAt: null,
    consumedAt: null,
    ...overrides,
  });
}

function makeRun(
  role: Role,
  status: AgentRun["status"],
  overrides: Partial<AgentRun> = {},
): AgentRun {
  const startedAt =
    status === "running" || status === "completed" || status === "failed"
      ? "2026-08-29T12:00:01.000Z"
      : null;
  const completedAt =
    status === "completed" || status === "failed" || status === "cancelled"
      ? "2026-08-29T12:00:02.000Z"
      : null;
  return {
    id: `run_${role}`,
    agentId: `agent_${role}`,
    status,
    prompt: "server prompt",
    output: status === "completed" ? `output_${role}` : null,
    error: status === "failed" ? "controlled failure" : null,
    usage:
      status === "completed"
        ? { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 }
        : null,
    threadId: status === "completed" ? `thread_${role}` : null,
    startedAt,
    completedAt,
    createdAt,
    ...overrides,
  };
}

function makeHarness(role: Role = "budget"): {
  assignment: RunAssignment;
  store: MemoryStore;
  harness: RunHarness;
  ports: RoleProfilePorts;
  clock: FakeClock;
} {
  const assignment = makeAssignment(role);
  const attempt = AgentAttemptSchema.parse(
    initialAttemptForAssignment(assignment, `attempt_${role}`),
  );
  const registration = RoleAgentRegistrationSchema.parse({
    role,
    agentId: assignment.agentId,
    agentNameAtRegistration: assignment.agentNameAtAssignment,
    roleProfileVersion: assignment.roleProfileVersion,
    agentsMdDigest: assignment.agentsMdDigest,
    registeredAt: createdAt,
  });
  const store = new MemoryStore({
    roleAgentRegistrations: [registration],
    runAssignments: [assignment],
    attempts: [attempt],
  });
  const harness = new RunHarness(makeAgent(role), makeRun(role, "queued"));
  return {
    assignment,
    store,
    harness,
    ports: { agents: harness, store, workspaces: harness },
    clock: new FakeClock(),
  };
}

class FanOutHarness implements AgentPort, WorkspacePort {
  readonly agents = new Map<string, Agent>();
  readonly digests = new Map<string, string>();
  readonly sentAgentIds: string[] = [];
  readonly sequences = new Map<string, Array<AgentRun | Error>>();
  private readonly dispatchRuns = new Map<string, AgentRun>();
  private readonly sendWaiters: Array<() => void> = [];
  activeSends = 0;
  maxActiveSends = 0;

  constructor() {
    for (const role of ROLES) {
      const agent = makeAgent(role);
      const run = makeRun(role, "queued");
      this.agents.set(agent.id, agent);
      this.digests.set(agent.id, profileDigest);
      this.dispatchRuns.set(agent.id, run);
      this.sequences.set(run.id, [makeRun(role, "completed")]);
    }
  }

  getAgent(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error("Agent not found");
    return structuredClone(agent);
  }

  async createAgent(_input: CreateAgentInput): Promise<Agent> {
    throw new Error("not used by fan-out tests");
  }

  async sendMessage(agentId: string, prompt: string): Promise<{ run: AgentRun }> {
    const run = this.dispatchRuns.get(agentId);
    const agent = this.agents.get(agentId);
    if (!run || !agent) throw new Error("Agent not found");
    this.sentAgentIds.push(agentId);
    agent.status = "busy";
    this.activeSends += 1;
    this.maxActiveSends = Math.max(this.maxActiveSends, this.activeSends);
    await new Promise<void>((resolve) => {
      this.sendWaiters.push(resolve);
      if (this.sendWaiters.length === ROLES.length) {
        for (const waiter of this.sendWaiters.splice(0)) waiter();
      }
    });
    this.activeSends -= 1;
    return { run: { ...structuredClone(run), prompt } };
  }

  getRun(runId: string): AgentRun {
    const sequence = this.sequences.get(runId);
    if (!sequence) throw new Error("Run not found");
    const next = sequence.shift();
    if (!next) throw new Error("Run sequence exhausted");
    if (next instanceof Error) throw next;
    const agent = this.agents.get(next.agentId);
    if (agent) {
      agent.status =
        next.status === "queued" || next.status === "running"
          ? "busy"
          : next.status === "failed"
            ? "error"
            : "ready";
    }
    return structuredClone(next);
  }

  async readAgentsMdDigest(agentId: string): Promise<string> {
    const digest = this.digests.get(agentId);
    if (!digest) throw new Error("AGENTS.md not found");
    return digest;
  }
}

function makeFanOutFixture(): {
  store: MemoryStore;
  harness: FanOutHarness;
  ports: RoleProfilePorts;
  inputs: RoleDispatchInputs;
} {
  const assignments = ROLES.map((role) => makeAssignment(role));
  const attempts = assignments.map((assignment) =>
    initialAttemptForAssignment(assignment, `attempt_${assignment.role}`),
  );
  const registrations = assignments.map((assignment) =>
    RoleAgentRegistrationSchema.parse({
      role: assignment.role,
      agentId: assignment.agentId,
      agentNameAtRegistration: assignment.agentNameAtAssignment,
      roleProfileVersion: assignment.roleProfileVersion,
      agentsMdDigest: assignment.agentsMdDigest,
      registeredAt: createdAt,
    }),
  );
  const store = new MemoryStore({
    roleAgentRegistrations: registrations,
    runAssignments: assignments,
    attempts,
  });
  const harness = new FanOutHarness();
  return {
    store,
    harness,
    ports: { agents: harness, store, workspaces: harness },
    inputs: ROLES.map((role) => ({
      assignmentId: `assignment_${role}`,
      attemptId: `attempt_${role}`,
    })) as unknown as RoleDispatchInputs,
  };
}

function observedStatuses(store: MemoryStore, attemptId: string): string[] {
  const statuses = store.history.map(
    (state) => state.attempts.find((item) => item.attemptId === attemptId)!.status,
  );
  return statuses.filter((status, index) => status !== statuses[index - 1]);
}

function terminalAttempt(
  role: Role,
  startedAt: string,
  completedAt: string,
  overrides: Partial<AgentAttempt> = {},
): AgentAttempt {
  return AgentAttemptSchema.parse({
    attemptId: `attempt_${role}`,
    sessionId: "session_join",
    actionHash: GOLDEN_ACTION_HASH,
    role,
    agentId: `agent_${role}`,
    assignmentId: `assignment_${role}`,
    runId: `run_${role}`,
    status: "COMPLETED",
    runStartedAt: startedAt,
    runCompletedAt: completedAt,
    threadId: `thread_${role}`,
    usage: null,
    outputDigest: sha256Digest(`output_${role}`),
    ...overrides,
  });
}

function observation(attempt: AgentAttempt): TerminalRunObservation {
  return {
    role: attempt.role,
    agentId: attempt.agentId,
    assignmentId: attempt.assignmentId,
    runId: attempt.runId!,
    attempt,
    output: `output_${attempt.role}`,
  };
}

function makeJoinFixture(attempts: readonly AgentAttempt[]): {
  store: MemoryStore;
  scope: RoleRunJoinScope;
} {
  const assignments = attempts.map((attempt) =>
    makeAssignment(attempt.role, {
      assignmentId: attempt.assignmentId,
      sessionId: attempt.sessionId,
      actionHash: attempt.actionHash,
      agentId: attempt.agentId,
      agentNameAtAssignment: ROLE_PROFILES[attempt.role].agentName,
      boundRunId: attempt.runId,
      status: "BOUND",
      boundAt: createdAt,
    }),
  );
  const store = new MemoryStore({
    roleAgentRegistrations: [],
    runAssignments: assignments,
    attempts: structuredClone(attempts),
  });
  return {
    store,
    scope: {
      sessionId: attempts[0]!.sessionId,
      actionHash: attempts[0]!.actionHash,
      assignmentIds: attempts.map(
        (attempt) => attempt.assignmentId,
      ) as unknown as [string, string, string],
    },
  };
}

describe("EpochGuard Run Observer", () => {
  it("requires the Assignment and Attempt to be persisted before send", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    store.state.attempts = [];

    await expect(
      dispatchBindPoll(
        { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
        ports,
        { clock },
      ),
    ).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(harness.sentPrompts).toHaveLength(0);
  });

  it("mirrors dispatch, queued, running, and terminal Run evidence", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    harness.onSend = () => {
      expect(store.state.runAssignments[0]?.assignmentId).toBe(
        assignment.assignmentId,
      );
      expect(store.state.attempts[0]?.status).toBe("DISPATCHING");
    };
    harness.runSequence = [
      makeRun("budget", "queued"),
      makeRun("budget", "running"),
      makeRun("budget", "completed"),
    ];

    const result = await dispatchBindPoll(
      { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
      ports,
      { clock, pollIntervalMs: 200, timeoutMs: 2_000 },
    );

    expect(result.runId).toBe("run_budget");
    expect(result.attempt).toMatchObject({
      status: "COMPLETED",
      runId: "run_budget",
      runStartedAt: "2026-08-29T12:00:01.000Z",
      runCompletedAt: "2026-08-29T12:00:02.000Z",
      threadId: "thread_budget",
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 },
      outputDigest: sha256Digest("output_budget"),
    });
    expect(observedStatuses(store, "attempt_budget")).toEqual([
      "DISPATCHING",
      "QUEUED",
      "RUNNING",
      "COMPLETED",
    ]);
    expect(store.state.runAssignments[0]).toMatchObject({
      status: "BOUND",
      boundRunId: "run_budget",
    });
    expect(harness.sentPrompts[0]).toContain(
      assignment.evidencePackRelativePath,
    );
    expect(harness.sentPrompts[0]).not.toContain(assignment.receiptId);
  });

  it("fails pre-bind without dispatch when the Profile digest is stale", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    harness.digests.set(assignment.agentId, sha256Digest("stale profile"));

    await expect(
      dispatchBindPoll(
        { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
        ports,
        { clock },
      ),
    ).rejects.toMatchObject({
      code: "ROLE_PROFILE_MISMATCH",
      attempt: { status: "FAILED", runId: null, runCompletedAt: null },
    });
    expect(harness.sentPrompts).toHaveLength(0);
    expect(store.state.runAssignments[0]?.status).toBe("REJECTED");
    expect(AgentAttemptSchema.safeParse(store.state.attempts[0]).success).toBe(true);
  });

  it("binds an Assignment only once and preserves the first Run ID", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    harness.onSend = async () => {
      await store.mutate((database) => {
        const stored = database.runAssignments[0]!;
        stored.status = "BOUND";
        stored.boundRunId = "run_already_bound";
        stored.boundAt = clock.now();
      });
    };

    await expect(
      dispatchBindPoll(
        { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
        ports,
        { clock },
      ),
    ).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(store.state.runAssignments[0]).toMatchObject({
      boundRunId: "run_already_bound",
      status: "REJECTED",
    });
    expect(store.state.attempts[0]).toMatchObject({
      status: "FAILED",
      runId: null,
    });
    expect(harness.sentPrompts).toHaveLength(1);
  });

  it("rejects output when AGENTS.md changes after dispatch", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    harness.onSend = () => {
      harness.digests.set(assignment.agentId, sha256Digest("mutated after dispatch"));
    };
    harness.runSequence = [makeRun("budget", "completed")];

    await expect(
      dispatchBindPoll(
        { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
        ports,
        { clock },
      ),
    ).rejects.toMatchObject({
      code: "ROLE_PROFILE_MISMATCH",
      attempt: {
        status: "OUTPUT_REJECTED",
        runId: "run_budget",
        runStartedAt: "2026-08-29T12:00:01.000Z",
        runCompletedAt: "2026-08-29T12:00:02.000Z",
        outputDigest: sha256Digest("output_budget"),
      },
    });
    expect(store.state.runAssignments[0]?.status).toBe("REJECTED");
    expect(observedStatuses(store, "attempt_budget")).toEqual([
      "DISPATCHING",
      "QUEUED",
      "COMPLETED",
      "OUTPUT_REJECTED",
    ]);
  });

  it("never binds a model-self-reported runId", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    const forgedOutput = JSON.stringify({ runId: "run_forged_by_model" });
    harness.runSequence = [
      makeRun("budget", "completed", { output: forgedOutput }),
    ];

    const result = await dispatchBindPoll(
      { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
      ports,
      { clock },
    );
    expect(result.output).toBe(forgedOutput);
    expect(result.runId).toBe("run_budget");
    expect(store.state.runAssignments[0]?.boundRunId).toBe("run_budget");
    expect(store.state.attempts[0]?.outputDigest).toBe(
      sha256Digest(forgedOutput),
    );
  });

  it("rejects getRun evidence for any ID other than the send-bound Run", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    harness.runSequence = [
      makeRun("budget", "running"),
      makeRun("budget", "completed", { id: "run_wrong_authoritative_record" }),
    ];

    await expect(
      dispatchBindPoll(
        { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
        ports,
        { clock },
      ),
    ).rejects.toMatchObject({
      code: "BINDING_MISMATCH",
      attempt: {
        status: "RUNNING",
        runId: "run_budget",
        runStartedAt: "2026-08-29T12:00:01.000Z",
        runCompletedAt: null,
      },
    });
    expect(store.state.runAssignments[0]).toMatchObject({
      boundRunId: "run_budget",
      status: "REJECTED",
    });
    expect(harness.sentPrompts).toHaveLength(1);
  });

  it("preserves mirrored start evidence when getRun throws", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    harness.runSequence = [
      makeRun("budget", "running"),
      new Error("controlled getRun failure"),
    ];

    await expect(
      dispatchBindPoll(
        { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
        ports,
        { clock },
      ),
    ).rejects.toMatchObject({
      code: "RUN_FAILED",
      attempt: {
        status: "RUNNING",
        runStartedAt: "2026-08-29T12:00:01.000Z",
        runCompletedAt: null,
      },
    });
    expect(store.state.runAssignments[0]?.status).toBe("REJECTED");
  });

  it("mirrors queued cancellation and running failure with valid terminal timelines", async () => {
    const queued = makeHarness();
    queued.harness.runSequence = [
      makeRun("budget", "cancelled", {
        startedAt: null,
        completedAt: "2026-08-29T12:00:02.000Z",
      }),
    ];
    await expect(
      dispatchBindPoll(
        {
          assignmentId: queued.assignment.assignmentId,
          attemptId: "attempt_budget",
        },
        queued.ports,
        { clock: queued.clock },
      ),
    ).rejects.toMatchObject({
      code: "RUN_FAILED",
      attempt: {
        status: "INTERRUPTED",
        runId: "run_budget",
        runStartedAt: null,
        runCompletedAt: "2026-08-29T12:00:02.000Z",
      },
    });
    expect(AgentAttemptSchema.safeParse(queued.store.state.attempts[0]).success).toBe(
      true,
    );

    const running = makeHarness();
    running.harness.runSequence = [
      makeRun("budget", "running"),
      makeRun("budget", "failed"),
    ];
    await expect(
      dispatchBindPoll(
        {
          assignmentId: running.assignment.assignmentId,
          attemptId: "attempt_budget",
        },
        running.ports,
        { clock: running.clock },
      ),
    ).rejects.toMatchObject({
      code: "RUN_FAILED",
      attempt: {
        status: "FAILED",
        runStartedAt: "2026-08-29T12:00:01.000Z",
        runCompletedAt: "2026-08-29T12:00:02.000Z",
      },
    });
    expect(observedStatuses(running.store, "attempt_budget")).toEqual([
      "DISPATCHING",
      "QUEUED",
      "RUNNING",
      "FAILED",
    ]);
  });

  it("fails closed on queued timeout without fabricating completion evidence", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    harness.runSequence = [makeRun("budget", "queued")];

    await expect(
      dispatchBindPoll(
        { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
        ports,
        { clock, pollIntervalMs: 200, timeoutMs: 200 },
      ),
    ).rejects.toMatchObject({
      code: "RUN_TIMEOUT",
      attempt: {
        status: "QUEUED",
        runId: "run_budget",
        runStartedAt: null,
        runCompletedAt: null,
      },
    });
    expect(AgentAttemptSchema.safeParse(store.state.attempts[0]).success).toBe(true);
    expect(store.state.runAssignments[0]?.status).toBe("REJECTED");
  });

  it("fails closed on running timeout and preserves the authoritative start", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    harness.runSequence = [makeRun("budget", "running")];

    await expect(
      dispatchBindPoll(
        { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
        ports,
        { clock, pollIntervalMs: 200, timeoutMs: 200 },
      ),
    ).rejects.toMatchObject({
      code: "RUN_TIMEOUT",
      attempt: {
        status: "RUNNING",
        runStartedAt: "2026-08-29T12:00:01.000Z",
        runCompletedAt: null,
      },
    });
    expect(store.state.runAssignments[0]?.status).toBe("REJECTED");
  });

  it.each([
    ["RFC1123", "Sat, 29 Aug 2026 12:00:02 GMT"],
    ["RFC3339 without an offset", "2026-08-29T12:00:02"],
  ])(
    "rejects a Date.parse-compatible but contract-invalid %s timestamp",
    async (_label, invalidCompletedAt) => {
      expect(Number.isFinite(Date.parse(invalidCompletedAt))).toBe(true);
      expect(TimestampSchema.safeParse(invalidCompletedAt).success).toBe(false);
      const { assignment, store, harness, ports, clock } = makeHarness();
      harness.runSequence = [
        makeRun("budget", "running"),
        makeRun("budget", "failed", {
          completedAt: invalidCompletedAt,
        }),
      ];

      await expect(
        dispatchBindPoll(
          { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
          ports,
          { clock },
        ),
      ).rejects.toBeInstanceOf(RunAdapterError);
      expect(store.state.runAssignments[0]?.status).toBe("REJECTED");
      expect(store.state.attempts[0]).toMatchObject({
        status: "RUNNING",
        runStartedAt: "2026-08-29T12:00:01.000Z",
        runCompletedAt: null,
      });
      expect(AgentAttemptSchema.safeParse(store.state.attempts[0]).success).toBe(
        true,
      );
    },
  );

  it("rejects missing or reversed terminal time without corrupting known evidence", async () => {
    for (const malformedTerminal of [
      makeRun("budget", "failed", { completedAt: null }),
      makeRun("budget", "completed", {
        startedAt: "2026-08-29T12:00:03.000Z",
        completedAt: "2026-08-29T12:00:02.000Z",
      }),
    ]) {
      const { assignment, store, harness, ports, clock } = makeHarness();
      harness.runSequence = [makeRun("budget", "running"), malformedTerminal];

      await expect(
        dispatchBindPoll(
          { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
          ports,
          { clock },
        ),
      ).rejects.toMatchObject({
        name: "RunAdapterError",
        attempt: {
          status: "RUNNING",
          runStartedAt: "2026-08-29T12:00:01.000Z",
          runCompletedAt: null,
        },
      });
      expect(store.state.runAssignments[0]?.status).toBe("REJECTED");
      expect(AgentAttemptSchema.safeParse(store.state.attempts[0]).success).toBe(
        true,
      );
    }
  });

  it("rejects an attempt to rewrite an already observed start timestamp", async () => {
    const { assignment, store, harness, ports, clock } = makeHarness();
    harness.runSequence = [
      makeRun("budget", "running"),
      makeRun("budget", "running", {
        startedAt: "2026-08-29T12:00:01.500Z",
      }),
    ];

    await expect(
      dispatchBindPoll(
        { assignmentId: assignment.assignmentId, attemptId: "attempt_budget" },
        ports,
        { clock },
      ),
    ).rejects.toMatchObject({
      code: "BINDING_MISMATCH",
      attempt: {
        status: "RUNNING",
        runStartedAt: "2026-08-29T12:00:01.000Z",
        runCompletedAt: null,
      },
    });
    expect(store.state.runAssignments[0]?.status).toBe("REJECTED");
  });
});

describe("EpochGuard Role Run join and coordination evidence", () => {
  const overlap = {
    inventory: terminalAttempt(
      "inventory",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:10.000Z",
    ),
    budget: terminalAttempt(
      "budget",
      "2026-08-29T12:00:02.000Z",
      "2026-08-29T12:00:12.000Z",
    ),
    policy: terminalAttempt(
      "policy",
      "2026-08-29T12:00:04.000Z",
      "2026-08-29T12:00:14.000Z",
    ),
  };

  it("fans out three dispatches concurrently without Store lost updates", async () => {
    const { store, harness, ports, inputs } = makeFanOutFixture();
    const joined = await fanOutDispatchBindPoll(inputs, ports, {
      clock: new FakeClock(),
    });

    expect(harness.sentAgentIds).toHaveLength(3);
    expect(harness.maxActiveSends).toBe(3);
    expect(joined.map((item) => item.role)).toEqual(ROLES);
    expect(store.state.runAssignments.map((item) => item.status)).toEqual([
      "BOUND",
      "BOUND",
      "BOUND",
    ]);
    expect(store.state.attempts.map((item) => item.status)).toEqual([
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
    ]);
    for (const role of ROLES) {
      expect(observedStatuses(store, `attempt_${role}`).slice(-3)).toEqual([
        "DISPATCHING",
        "QUEUED",
        "COMPLETED",
      ]);
    }
  });

  it("rejects all unconsumed siblings after one fan-out Run fails", async () => {
    const { store, harness, ports, inputs } = makeFanOutFixture();
    harness.sequences.set("run_budget", [makeRun("budget", "failed")]);

    await expect(
      fanOutDispatchBindPoll(inputs, ports, { clock: new FakeClock() }),
    ).rejects.toMatchObject({ code: "RUN_FAILED" });
    expect(store.state.runAssignments.map((item) => item.status)).toEqual([
      "REJECTED",
      "REJECTED",
      "REJECTED",
    ]);
    expect(store.state.attempts.map((item) => item.status)).toEqual([
      "COMPLETED",
      "FAILED",
      "COMPLETED",
    ]);
  });

  it("joins only matching, distinct Role, Agent, Run, and output evidence", async () => {
    const attempts = Object.values(overlap);
    const { store, scope } = makeJoinFixture(attempts);
    const joined = await joinRoleRunObservations(
      [
        { status: "fulfilled", value: observation(overlap.policy) },
        { status: "fulfilled", value: observation(overlap.inventory) },
        { status: "fulfilled", value: observation(overlap.budget) },
      ],
      store,
      scope,
    );
    expect(joined.map((item) => item.role)).toEqual([
      "inventory",
      "budget",
      "policy",
    ]);
    expect(new Set(joined.map((item) => item.agentId)).size).toBe(3);
    expect(new Set(joined.map((item) => item.runId)).size).toBe(3);

    const duplicateRun = observation({
      ...overlap.policy,
      runId: overlap.budget.runId,
    });
    const duplicateFixture = makeJoinFixture([
      overlap.inventory,
      overlap.budget,
      duplicateRun.attempt,
    ]);
    await expect(
      joinRoleRunObservations(
        [
          { status: "fulfilled", value: observation(overlap.inventory) },
          { status: "fulfilled", value: observation(overlap.budget) },
          { status: "fulfilled", value: duplicateRun },
        ],
        duplicateFixture.store,
        duplicateFixture.scope,
      ),
    ).rejects.toBeInstanceOf(RunAdapterError);
  });

  it("fails the join closed and rejects siblings without rewriting Attempts", async () => {
    const { store, scope } = makeJoinFixture(Object.values(overlap));
    const attemptsBefore = structuredClone(store.state.attempts);
    await expect(
      joinRoleRunObservations(
        [
          { status: "fulfilled", value: observation(overlap.inventory) },
          { status: "rejected", reason: new Error("budget failed") },
          { status: "fulfilled", value: observation(overlap.policy) },
        ],
        store,
        scope,
      ),
    ).rejects.toMatchObject({ code: "RUN_FAILED" });
    expect(store.state.runAssignments.map((item) => item.status)).toEqual([
      "REJECTED",
      "REJECTED",
      "REJECTED",
    ]);
    expect(store.state.attempts).toEqual(attemptsBefore);
  });

  it("preserves a consumed sibling while rejecting every unconsumed sibling", async () => {
    const { store, scope } = makeJoinFixture(Object.values(overlap));
    const consumed = store.state.runAssignments[0]!;
    consumed.status = "CONSUMED";
    consumed.consumedByDecisionCertificateId = "decision_inventory";
    consumed.consumedAt = "2026-08-29T12:00:11.000Z";

    await expect(
      joinRoleRunObservations(
        [
          { status: "fulfilled", value: observation(overlap.inventory) },
          { status: "rejected", reason: new Error("budget failed") },
          { status: "fulfilled", value: observation(overlap.policy) },
        ],
        store,
        scope,
      ),
    ).rejects.toMatchObject({ code: "RUN_FAILED" });
    expect(store.state.runAssignments.map((item) => item.status)).toEqual([
      "CONSUMED",
      "REJECTED",
      "REJECTED",
    ]);
  });

  it("rejects Assignment/output mismatches and all sibling Assignments", async () => {
    for (const mutate of [
      (candidate: TerminalRunObservation) => ({
        ...candidate,
        assignmentId: overlap.budget.assignmentId,
      }),
      (candidate: TerminalRunObservation) => ({
        ...candidate,
        output: "tampered output",
      }),
    ]) {
      const { store, scope } = makeJoinFixture(Object.values(overlap));
      const badPolicy = mutate(observation(overlap.policy));
      await expect(
        joinRoleRunObservations(
          [
            { status: "fulfilled", value: observation(overlap.inventory) },
            { status: "fulfilled", value: observation(overlap.budget) },
            { status: "fulfilled", value: badPolicy },
          ],
          store,
          scope,
        ),
      ).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
      expect(store.state.runAssignments.map((item) => item.status)).toEqual([
        "REJECTED",
        "REJECTED",
        "REJECTED",
      ]);
    }
  });

  it("rejects observations mixed from another Session or Action", async () => {
    for (const attemptOverride of [
      { sessionId: "session_other" },
      { actionHash: sha256Digest("other action") },
    ]) {
      const { store, scope } = makeJoinFixture(Object.values(overlap));
      const mixedAttempt = AgentAttemptSchema.parse({
        ...overlap.policy,
        ...attemptOverride,
      });
      await expect(
        joinRoleRunObservations(
          [
            { status: "fulfilled", value: observation(overlap.inventory) },
            { status: "fulfilled", value: observation(overlap.budget) },
            { status: "fulfilled", value: observation(mixedAttempt) },
          ],
          store,
          scope,
        ),
      ).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
      expect(store.state.runAssignments.map((item) => item.status)).toEqual([
        "REJECTED",
        "REJECTED",
        "REJECTED",
      ]);
    }
  });

  it("reports CONCURRENT only for a real positive three-way overlap", () => {
    expect(deriveCoordinationMode(Object.values(overlap))).toBe("CONCURRENT");

    const touchingOnly = [
      terminalAttempt(
        "inventory",
        "2026-08-29T12:00:00.000Z",
        "2026-08-29T12:00:10.000Z",
      ),
      terminalAttempt(
        "budget",
        "2026-08-29T12:00:05.000Z",
        "2026-08-29T12:00:15.000Z",
      ),
      terminalAttempt(
        "policy",
        "2026-08-29T12:00:10.000Z",
        "2026-08-29T12:00:20.000Z",
      ),
    ];
    expect(deriveCoordinationMode(touchingOnly)).toBe("SEQUENTIAL_FALLBACK");

    const missingTime: AgentAttempt = {
      ...overlap.policy,
      status: "QUEUED",
      runStartedAt: null,
      runCompletedAt: null,
      threadId: null,
      usage: null,
      outputDigest: null,
    };
    expect(
      deriveCoordinationMode([overlap.inventory, overlap.budget, missingTime]),
    ).toBe("SEQUENTIAL_FALLBACK");
  });
});
