import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent, AgentRun, CreateAgentInput } from "../types.js";
import type { CommitProtectedEffectResult } from "./effect-gate.js";
import { EpochGuardService, EpochGuardServiceError } from "./epochguard-service.js";
import { EpochStore } from "./epoch-store.js";
import { buildFixtureActionIntent } from "./fixtures.js";
import { ROLE_PROFILES } from "./role-profiles.js";
import {
  DualScenarioEpochGuardService,
  type DualScenarioStorePort,
  type InitializableEpochGuardRouteServicePort,
} from "./dual-scenario-service.js";
import {
  EpochSessionSchema,
  ROLES,
  RoleAgentRegistrationSchema,
  makeRoleProfileMismatchError,
  sha256Digest,
  type CommitSessionRequest,
  type CreateSessionRequest,
  type EffectRecord,
  type EpochDatabase,
  type EpochSession,
  type RefreshSessionRequest,
  type RoleAgentRegistration,
  type ScenarioId,
  type SessionDashboardSnapshot,
} from "./types.js";

const NOW = "2026-08-30T00:00:00.000Z";

function emptyDatabase(): EpochDatabase {
  return {
    schemaVersion: 1,
    snapshotRevision: 0,
    headSeq: 0,
    roleAgentRegistrations: [],
    worldCommits: [],
    resourceVersions: [],
    roleQuerySpecs: [],
    runAssignments: [],
    receipts: [],
    sessions: [],
    attempts: [],
    decisions: [],
    validations: [],
    jointValidityCertificates: [],
    noCutProofs: [],
    refreshPlans: [],
    permits: [],
    effects: [],
    diagnostics: [],
    rejectedOutputArtifacts: [],
    auditEvents: [],
  };
}

function registrations(
  registeredAt = NOW,
  suffix = "",
): RoleAgentRegistration[] {
  return ROLES.map((role) =>
    RoleAgentRegistrationSchema.parse({
      role,
      agentId: `agent_${role}${suffix}`,
      agentNameAtRegistration: ROLE_PROFILES[role].agentName,
      roleProfileVersion: ROLE_PROFILES[role].roleProfileVersion,
      agentsMdDigest: sha256Digest(`agents-md-${role}${suffix}`),
      registeredAt,
    }),
  );
}

function makeSession(
  sessionId: string,
  scenarioId: ScenarioId,
  state: EpochSession["state"] = "COMMITTED",
  stateUpdatedAt = NOW,
): EpochSession {
  const action = buildFixtureActionIntent(
    scenarioId,
    sessionId,
    `action_${sessionId}`,
  );
  return EpochSessionSchema.parse({
    sessionId,
    scenarioId,
    action,
    actionHash: action.actionHash,
    state,
    sessionRevision: 1,
    coordinationMode: "PENDING",
    frozenAssignments: {
      inventoryAgentId: "agent_inventory",
      budgetAgentId: "agent_budget",
      policyAgentId: "agent_policy",
    },
    activeDecisionCertificateIds: {
      inventory: null,
      budget: null,
      policy: null,
    },
    activeAttemptIds: {
      inventory: null,
      budget: null,
      policy: null,
    },
    activeValidationId: null,
    activeRefreshPlanId: null,
    activePermitId: null,
    stateUpdatedAt,
    createdAt: stateUpdatedAt,
  });
}

function snapshotStub(session: EpochSession): SessionDashboardSnapshot {
  return {
    sessionId: session.sessionId,
    scenarioId: session.scenarioId,
  } as unknown as SessionDashboardSnapshot;
}

class MemoryStore implements DualScenarioStorePort {
  initializeCalls = 0;

  constructor(public data: EpochDatabase = emptyDatabase()) {}

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  snapshot(): EpochDatabase {
    return structuredClone(this.data);
  }

  async mutate<T>(
    mutation: (database: EpochDatabase) => T | Promise<T>,
  ): Promise<T> {
    const next = structuredClone(this.data);
    const result = await mutation(next);
    next.snapshotRevision = this.data.snapshotRevision + 1;
    this.data = next;
    return result;
  }
}

type OperationName = "create" | "refresh" | "commit" | "reset";

class FakeScenarioService implements InitializableEpochGuardRouteServicePort {
  initializeCalls = 0;
  createCalls = 0;
  refreshCalls = 0;
  commitCalls = 0;
  resetCalls = 0;
  createState: EpochSession["state"] = "COMMITTED";
  hooks: Partial<Record<OperationName, () => Promise<void>>> = {};
  private sequence = 0;

  constructor(
    readonly label: "normal" | "impossible",
    readonly scenarioId: ScenarioId,
    readonly store: DualScenarioStorePort,
    private readonly sharedRegistrations: RoleAgentRegistration[],
    private readonly operationLog: string[] = [],
  ) {}

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
    this.operationLog.push(`initialize:${this.label}`);
    if (this.store.snapshot().roleAgentRegistrations.length === 0) {
      await this.store.mutate((database) => {
        database.roleAgentRegistrations = structuredClone(
          this.sharedRegistrations,
        );
      });
    }
  }

  async createSession(
    request: CreateSessionRequest,
  ): Promise<SessionDashboardSnapshot> {
    this.createCalls += 1;
    this.operationLog.push(`create:${this.label}:start`);
    if (request.scenarioId !== this.scenarioId) {
      throw new Error("wrong fake partition");
    }
    const session = makeSession(
      `${this.label}_session_${++this.sequence}`,
      this.scenarioId,
      this.createState,
      new Date(Date.parse(NOW) + this.sequence * 1_000).toISOString(),
    );
    await this.store.mutate((database) => database.sessions.push(session));
    await this.hooks.create?.();
    this.operationLog.push(`create:${this.label}:end`);
    return snapshotStub(session);
  }

  getSnapshot(sessionId: string): SessionDashboardSnapshot {
    const session = this.store.snapshot().sessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (session === undefined) throw new Error("fake session missing");
    return snapshotStub(session);
  }

  async refresh(
    sessionId: string,
    _request: RefreshSessionRequest,
  ): Promise<SessionDashboardSnapshot> {
    this.refreshCalls += 1;
    this.operationLog.push(`refresh:${this.label}:start`);
    await this.hooks.refresh?.();
    this.operationLog.push(`refresh:${this.label}:end`);
    return this.getSnapshot(sessionId);
  }

  async commit(
    _sessionId: string,
    _request: CommitSessionRequest,
  ): Promise<CommitProtectedEffectResult> {
    this.commitCalls += 1;
    this.operationLog.push(`commit:${this.label}:start`);
    await this.hooks.commit?.();
    this.operationLog.push(`commit:${this.label}:end`);
    return {
      status: "REJECTED",
      reasonCode: "CONSISTENT_DENY",
      message: "Fake terminal result",
      effectsInSession: 0,
      error: null,
    };
  }

  async resetDemo(): Promise<void> {
    this.resetCalls += 1;
    this.operationLog.push(`reset:${this.label}:start`);
    await this.hooks.reset?.();
    await this.store.mutate((database) => {
      const keptRegistrations = database.roleAgentRegistrations;
      Object.assign(database, emptyDatabase(), {
        roleAgentRegistrations: keptRegistrations,
      });
    });
    this.operationLog.push(`reset:${this.label}:end`);
  }

  getWorld() {
    const database = this.store.snapshot();
    return {
      snapshotRevision: database.snapshotRevision,
      headSeq: database.headSeq,
      worldCommits: database.worldCommits,
      resourceVersions: database.resourceVersions,
    };
  }

  getEffects(campaignId: string): {
    campaignId: string;
    effects: EffectRecord[];
  } {
    return {
      campaignId,
      effects: structuredClone(this.store.snapshot().effects),
    };
  }
}

function fixture(
  normalDatabase = emptyDatabase(),
  impossibleDatabase = emptyDatabase(),
) {
  const shared = registrations();
  const operationLog: string[] = [];
  const normalStore = new MemoryStore(normalDatabase);
  const impossibleStore = new MemoryStore(impossibleDatabase);
  const normalService = new FakeScenarioService(
    "normal",
    "normal-world-v1",
    normalStore,
    shared,
    operationLog,
  );
  const impossibleService = new FakeScenarioService(
    "impossible",
    "impossible-collage-v1",
    impossibleStore,
    shared,
    operationLog,
  );
  const composite = new DualScenarioEpochGuardService({
    normal: { store: normalStore, service: normalService },
    impossible: { store: impossibleStore, service: impossibleService },
  });
  return {
    composite,
    normalStore,
    impossibleStore,
    normalService,
    impossibleService,
    operationLog,
  };
}

const CREATE_REQUESTS = {
  normal: {
    scenarioId: "normal-world-v1",
    assignments: {
      inventory: "agent_inventory",
      budget: "agent_budget",
      policy: "agent_policy",
    },
  },
  impossible: {
    scenarioId: "impossible-collage-v1",
    assignments: {
      inventory: "agent_inventory",
      budget: "agent_budget",
      policy: "agent_policy",
    },
  },
} as const satisfies Record<string, CreateSessionRequest>;

function completeDatabase(
  registeredAt = NOW,
  suffix = "",
): EpochDatabase {
  return {
    ...emptyDatabase(),
    roleAgentRegistrations: registrations(registeredAt, suffix),
  };
}

function expectServiceError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(EpochGuardServiceError);
  expect((error as EpochGuardServiceError).body.error).toBe(code);
}

async function expectServiceRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code} rejection`);
  } catch (error) {
    expectServiceError(error, code);
  }
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DualScenarioEpochGuardService initialization", () => {
  it("initializes Normal first for two pristine Stores and copies all registrations", async () => {
    const context = fixture();
    await context.composite.initialize();

    expect(context.operationLog).toEqual([
      "initialize:normal",
      "initialize:impossible",
    ]);
    expect(context.normalStore.data.roleAgentRegistrations).toHaveLength(3);
    expect(context.impossibleStore.data.roleAgentRegistrations).toEqual(
      context.normalStore.data.roleAgentRegistrations,
    );
  });

  it.each([
    ["normal", completeDatabase(), emptyDatabase(), ["initialize:normal", "initialize:impossible"]],
    ["impossible", emptyDatabase(), completeDatabase(), ["initialize:impossible", "initialize:normal"]],
  ] as const)(
    "validates the complete %s Store before initializing the pristine side",
    async (_label, normalDatabase, impossibleDatabase, expectedOrder) => {
      const context = fixture(normalDatabase, impossibleDatabase);
      await context.composite.initialize();
      expect(context.operationLog).toEqual(expectedOrder);
      expect(context.normalStore.data.roleAgentRegistrations).toHaveLength(3);
      expect(context.impossibleStore.data.roleAgentRegistrations).toHaveLength(3);
    },
  );

  it("accepts dual complete identities when only registeredAt differs", async () => {
    const context = fixture(
      completeDatabase("2026-08-30T00:00:00.000Z"),
      completeDatabase("2026-08-30T01:00:00.000Z"),
    );
    await expect(context.composite.initialize()).resolves.toBeUndefined();
  });

  it("coalesces concurrent initialize calls and remains idempotent", async () => {
    const context = fixture();
    await Promise.all([
      context.composite.initialize(),
      context.composite.initialize(),
      context.composite.initialize(),
    ]);
    await context.composite.initialize();
    expect(context.normalService.initializeCalls).toBe(1);
    expect(context.impossibleService.initializeCalls).toBe(1);
    expect(context.normalStore.initializeCalls).toBe(1);
    expect(context.impossibleStore.initializeCalls).toBe(1);
  });

  it.each([
    ["one registration", () => registrations().slice(0, 1)],
    ["two registrations", () => registrations().slice(0, 2)],
    ["duplicate Role", () => [registrations()[0]!, registrations()[0]!, registrations()[2]!]],
    ["duplicate Agent", () => {
      const values = registrations();
      values[1] = { ...values[1]!, agentId: values[0]!.agentId };
      return values;
    }],
  ])("fails closed for %s", async (_label, build) => {
    const database = emptyDatabase();
    database.roleAgentRegistrations = build();
    const context = fixture(database, emptyDatabase());
    await expect(context.composite.initialize()).rejects.toThrow();
    expect(context.normalService.initializeCalls).toBe(0);
    expect(context.impossibleService.initializeCalls).toBe(0);
  });

  it("rejects a zero-registration Store that already has business data", async () => {
    const database = emptyDatabase();
    database.headSeq = 1;
    const context = fixture(database, emptyDatabase());
    await expect(context.composite.initialize()).rejects.toThrow(
      "business data without Role registrations",
    );
  });

  it.each([
    ["agentId", (registration: RoleAgentRegistration) => ({
      ...registration,
      agentId: "agent_inventory_other",
    })],
    ["agentNameAtRegistration", (registration: RoleAgentRegistration) => ({
      ...registration,
      agentNameAtRegistration: "EpochGuard Inventory Agent Other",
    })],
    ["roleProfileVersion", (registration: RoleAgentRegistration) => ({
      ...registration,
      roleProfileVersion: "epochguard-inventory-other",
    })],
    ["agentsMdDigest", (registration: RoleAgentRegistration) => ({
      ...registration,
      agentsMdDigest: sha256Digest("other-agents-md"),
    })],
  ] as const)(
    "rejects a complete identity with conflicting %s before child initialization",
    async (_field, mutateRegistration) => {
      const impossible = completeDatabase();
      impossible.roleAgentRegistrations[0] = RoleAgentRegistrationSchema.parse(
        mutateRegistration(impossible.roleAgentRegistrations[0]!),
      );
      const context = fixture(completeDatabase(), impossible);
      await expect(context.composite.initialize()).rejects.toThrow(
        "disagree on Role identities",
      );
      expect(context.normalService.initializeCalls).toBe(0);
      expect(context.impossibleService.initializeCalls).toBe(0);
    },
  );

  it("rejects wrong partitions, duplicate session IDs, and two active Sessions", async () => {
    const wrong = completeDatabase();
    wrong.sessions.push(makeSession("wrong_partition", "impossible-collage-v1"));
    await expectServiceRejection(
      fixture(wrong, completeDatabase()).composite.initialize(),
      "PROJECTION_MISMATCH",
    );

    const duplicateNormal = completeDatabase();
    const duplicateImpossible = completeDatabase();
    duplicateNormal.sessions.push(makeSession("duplicate_session", "normal-world-v1"));
    duplicateImpossible.sessions.push(
      makeSession("duplicate_session", "impossible-collage-v1"),
    );
    await expectServiceRejection(
      fixture(duplicateNormal, duplicateImpossible).composite.initialize(),
      "PROJECTION_MISMATCH",
    );

    const activeNormal = completeDatabase();
    const activeImpossible = completeDatabase();
    activeNormal.sessions.push(
      makeSession("active_normal", "normal-world-v1", "READY_AT_CURRENT_HEAD"),
    );
    activeImpossible.sessions.push(
      makeSession(
        "active_impossible",
        "impossible-collage-v1",
        "BLOCKED_NO_CUT",
      ),
    );
    await expectServiceRejection(
      fixture(activeNormal, activeImpossible).composite.initialize(),
      "PROJECTION_MISMATCH",
    );
  });

  it("creates exactly three shared Role Agents across two real EpochGuardServices", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epochguard-eg09-"));
    try {
      const normalStore = new EpochStore(path.join(directory, "normal.json"));
      const impossibleStore = new EpochStore(path.join(directory, "impossible.json"));
      const agents = new Map<string, Agent>();
      let createCount = 0;
      const agentPort = {
        getAgent: (agentId: string) => {
          const agent = agents.get(agentId);
          if (agent === undefined) throw new Error("Agent missing");
          return structuredClone(agent);
        },
        createAgent: async (input: CreateAgentInput) => {
          const id = `agent_${++createCount}`;
          const agent: Agent = {
            id,
            name: input.name,
            description: input.description ?? "",
            instructions: input.instructions ?? "",
            status: "ready",
            workspacePath: path.join(directory, id),
            codexThreadId: null,
            lastError: null,
            createdAt: NOW,
            updatedAt: NOW,
          };
          agents.set(id, agent);
          return structuredClone(agent);
        },
        sendMessage: async (): Promise<{ run: AgentRun }> => {
          throw new Error("not used during initialization");
        },
        getRun: (): AgentRun => {
          throw new Error("not used during initialization");
        },
        systemInfo: async () => ({ runtime: "test" }),
      };
      const workspacePort = {
        readAgentsMdDigest: async (agentId: string) =>
          sha256Digest(`agents-md:${agentId}`),
        writeEvidencePackAtomic: async () => ".epochguard/test.json",
      };
      const normalService = new EpochGuardService({
        store: normalStore,
        agents: agentPort,
        workspaces: workspacePort,
      });
      const impossibleService = new EpochGuardService({
        store: impossibleStore,
        agents: agentPort,
        workspaces: workspacePort,
      });
      const composite = new DualScenarioEpochGuardService({
        normal: { store: normalStore, service: normalService },
        impossible: { store: impossibleStore, service: impossibleService },
      });

      await composite.initialize();

      expect(createCount).toBe(3);
      expect(normalStore.snapshot().roleAgentRegistrations).toHaveLength(3);
      expect(impossibleStore.snapshot().roleAgentRegistrations).toEqual(
        normalStore.snapshot().roleAgentRegistrations,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("DualScenarioEpochGuardService routing and serialization", () => {
  it.each([
    ["normal then impossible", "normal", "impossible"],
    ["impossible then normal", "impossible", "normal"],
  ] as const)("routes %s in either terminal order", async (_label, first, second) => {
    const context = fixture();
    await context.composite.initialize();
    const firstSnapshot = await context.composite.createSession(
      CREATE_REQUESTS[first],
    );
    const secondSnapshot = await context.composite.createSession(
      CREATE_REQUESTS[second],
    );
    expect(firstSnapshot.scenarioId).toBe(CREATE_REQUESTS[first].scenarioId);
    expect(secondSnapshot.scenarioId).toBe(CREATE_REQUESTS[second].scenarioId);
    expect(context.normalService.createCalls).toBe(1);
    expect(context.impossibleService.createCalls).toBe(1);
  });

  it("serializes concurrent Create and rejects the second before dispatch", async () => {
    const context = fixture();
    context.normalService.createState = "READY_AT_CURRENT_HEAD";
    context.impossibleService.createState = "BLOCKED_NO_CUT";
    await context.composite.initialize();

    const results = await Promise.allSettled([
      context.composite.createSession(CREATE_REQUESTS.normal),
      context.composite.createSession(CREATE_REQUESTS.impossible),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expectServiceError(
      rejected?.status === "rejected" ? rejected.reason : null,
      "AGENTS_BUSY",
    );
    expect(context.normalService.createCalls + context.impossibleService.createCalls).toBe(1);
  });

  it.each(ROLES)(
    "returns canonical ROLE_PROFILE_MISMATCH for a wrong %s assignment before AGENTS_BUSY",
    async (role) => {
      const activeNormal = completeDatabase();
      activeNormal.sessions.push(
        makeSession("active_assignment_priority", "normal-world-v1", "COLLECTING"),
      );
      const context = fixture(activeNormal, completeDatabase());
      await context.composite.initialize();
      const requestedAgentId = "agent_wrong_" + role;

      try {
        await context.composite.createSession({
          scenarioId: "impossible-collage-v1",
          assignments: {
            ...CREATE_REQUESTS.impossible.assignments,
            [role]: requestedAgentId,
          },
        });
        throw new Error("Expected ROLE_PROFILE_MISMATCH rejection");
      } catch (error) {
        expectServiceError(error, "ROLE_PROFILE_MISMATCH");
        expect((error as EpochGuardServiceError).body).toEqual(
          makeRoleProfileMismatchError(role, requestedAgentId),
        );
      }
      expect(context.normalService.createCalls).toBe(0);
      expect(context.impossibleService.createCalls).toBe(0);
    },
  );

  it("uses frozen Role order for the first of multiple assignment mismatches", async () => {
    const activeNormal = completeDatabase();
    activeNormal.sessions.push(
      makeSession("active_assignment_order", "normal-world-v1", "DISPATCHING"),
    );
    const context = fixture(activeNormal, completeDatabase());
    await context.composite.initialize();
    const assignments = {
      inventory: "agent_wrong_inventory",
      budget: "agent_wrong_budget",
      policy: "agent_wrong_policy",
    };

    try {
      await context.composite.createSession({
        scenarioId: "normal-world-v1",
        assignments,
      });
      throw new Error("Expected deterministic ROLE_PROFILE_MISMATCH rejection");
    } catch (error) {
      expectServiceError(error, "ROLE_PROFILE_MISMATCH");
      expect((error as EpochGuardServiceError).body).toEqual(
        makeRoleProfileMismatchError(ROLES[0], assignments[ROLES[0]]),
      );
    }
    expect(context.normalService.createCalls).toBe(0);
    expect(context.impossibleService.createCalls).toBe(0);
  });

  it("admits one concurrent real Create and dispatches only its three Role Runs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epochguard-eg09-dispatch-"));
    let resolveDispatch: ((value: { run: AgentRun }) => void) | null = null;
    try {
      const normalStore = new EpochStore(path.join(directory, "normal.json"));
      const impossibleStore = new EpochStore(path.join(directory, "impossible.json"));
      const agents = new Map<string, Agent>();
      let createCount = 0;
      let dispatchCount = 0;
      const blockedDispatch = new Promise<{ run: AgentRun }>((resolve) => {
        resolveDispatch = resolve;
      });
      const agentPort = {
        getAgent: (agentId: string) => {
          const agent = agents.get(agentId);
          if (agent === undefined) throw new Error("Agent missing");
          return structuredClone(agent);
        },
        createAgent: async (input: CreateAgentInput) => {
          const id = `agent_real_${++createCount}`;
          const agent: Agent = {
            id,
            name: input.name,
            description: input.description ?? "",
            instructions: input.instructions ?? "",
            status: "ready",
            workspacePath: path.join(directory, id),
            codexThreadId: null,
            lastError: null,
            createdAt: NOW,
            updatedAt: NOW,
          };
          agents.set(id, agent);
          return structuredClone(agent);
        },
        sendMessage: (): Promise<{ run: AgentRun }> => {
          dispatchCount += 1;
          return blockedDispatch;
        },
        getRun: (): AgentRun => {
          throw new Error("A blocked dispatch must not reach polling");
        },
        systemInfo: async () => ({ runtime: "test" }),
      };
      const workspacePort = {
        readAgentsMdDigest: async (agentId: string) =>
          sha256Digest(`agents-md:${agentId}`),
        writeEvidencePackAtomic: async (
          _agentId: string,
          sessionId: string,
          role: RoleAgentRegistration["role"],
          assignmentId: string,
        ) => `.epochguard/sessions/${sessionId}/${role}/${assignmentId}.json`,
      };
      const normalService = new EpochGuardService({
        store: normalStore,
        agents: agentPort,
        workspaces: workspacePort,
      });
      const impossibleService = new EpochGuardService({
        store: impossibleStore,
        agents: agentPort,
        workspaces: workspacePort,
      });
      const composite = new DualScenarioEpochGuardService({
        normal: { store: normalStore, service: normalService },
        impossible: { store: impossibleStore, service: impossibleService },
      });
      await composite.initialize();
      const registrationsByRole = new Map(
        normalStore
          .snapshot()
          .roleAgentRegistrations.map((registration) => [
            registration.role,
            registration.agentId,
          ]),
      );
      const assignments = {
        inventory: registrationsByRole.get("inventory")!,
        budget: registrationsByRole.get("budget")!,
        policy: registrationsByRole.get("policy")!,
      };

      const results = await Promise.allSettled([
        composite.createSession({
          scenarioId: "normal-world-v1",
          assignments,
        }),
        composite.createSession({
          scenarioId: "impossible-collage-v1",
          assignments,
        }),
      ]);

      const fulfilled = results.find(
        (result): result is PromiseFulfilledResult<SessionDashboardSnapshot> =>
          result.status === "fulfilled",
      );
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (fulfilled === undefined) {
        throw new Error(
          results
            .map((result) =>
              result.status === "rejected"
                ? `${String(result.reason)} ${JSON.stringify((result.reason as { body?: unknown }).body)}`
                : result.value.scenarioId,
            )
            .join(" | "),
        );
      }
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(fulfilled.value.sessionId).toMatch(
        /^session_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expectServiceError(
        rejected?.reason,
        "AGENTS_BUSY",
      );
      await waitForCondition(() => dispatchCount === 3);
      expect(dispatchCount).toBe(3);
      const winnerStore =
        fulfilled?.value.scenarioId === "normal-world-v1"
          ? normalStore
          : impossibleStore;
      const loserStore = winnerStore === normalStore ? impossibleStore : normalStore;
      expect(winnerStore.snapshot().runAssignments).toHaveLength(3);
      expect(loserStore.snapshot().runAssignments).toHaveLength(0);

      resolveDispatch({ run: {} as AgentRun });
      resolveDispatch = null;
      await waitForCondition(() =>
        winnerStore.snapshot().sessions.some((session) =>
          ["FAILED", "INTERRUPTED"].includes(session.state),
        ),
      );
    } finally {
      resolveDispatch?.({ run: {} as AgentRun });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores GET, refresh, and commit routing from Store scans after cold start", async () => {
    const normal = completeDatabase();
    normal.sessions.push(makeSession("cold_session", "normal-world-v1"));
    const context = fixture(normal, completeDatabase());
    await context.composite.initialize();

    expect(context.composite.getSnapshot("cold_session").sessionId).toBe(
      "cold_session",
    );
    await context.composite.refresh("cold_session", {
      expectedSessionRevision: 1,
      refreshPlanId: "refresh_cold",
    });
    await context.composite.commit("cold_session", {
      expectedSessionRevision: 1,
    });
    expect(context.normalService.refreshCalls).toBe(1);
    expect(context.normalService.commitCalls).toBe(1);
    expect(context.impossibleService.refreshCalls).toBe(0);
  });

  it("routes both scenarios after rebuilding the composite from real JSON Stores", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "epochguard-eg09-cold-"));
    try {
      const normalPath = path.join(directory, "normal.json");
      const impossiblePath = path.join(directory, "impossible.json");
      const seedNormal = new EpochStore(normalPath);
      const seedImpossible = new EpochStore(impossiblePath);
      await Promise.all([seedNormal.initialize(), seedImpossible.initialize()]);
      await seedNormal.mutate((database) => {
        database.roleAgentRegistrations = registrations();
        database.sessions.push(
          makeSession("cold_json_normal", "normal-world-v1"),
        );
      });
      await seedImpossible.mutate((database) => {
        database.roleAgentRegistrations = registrations();
        database.sessions.push(
          makeSession("cold_json_impossible", "impossible-collage-v1"),
        );
      });

      const restartedNormal = new EpochStore(normalPath);
      const restartedImpossible = new EpochStore(impossiblePath);
      const operationLog: string[] = [];
      const normalService = new FakeScenarioService(
        "normal",
        "normal-world-v1",
        restartedNormal,
        registrations(),
        operationLog,
      );
      const impossibleService = new FakeScenarioService(
        "impossible",
        "impossible-collage-v1",
        restartedImpossible,
        registrations(),
        operationLog,
      );
      const restarted = new DualScenarioEpochGuardService({
        normal: { store: restartedNormal, service: normalService },
        impossible: { store: restartedImpossible, service: impossibleService },
      });
      await restarted.initialize();

      expect(restarted.getSnapshot("cold_json_normal").scenarioId).toBe(
        "normal-world-v1",
      );
      await restarted.commit("cold_json_normal", {
        expectedSessionRevision: 1,
      });
      expect(restarted.getSnapshot("cold_json_impossible").scenarioId).toBe(
        "impossible-collage-v1",
      );
      await restarted.refresh("cold_json_impossible", {
        expectedSessionRevision: 1,
        refreshPlanId: "refresh_cold_json",
      });

      expect(normalService.commitCalls).toBe(1);
      expect(normalService.refreshCalls).toBe(0);
      expect(impossibleService.refreshCalls).toBe(1);
      expect(impossibleService.commitCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns canonical SESSION_NOT_FOUND and PROJECTION_MISMATCH lookup errors", async () => {
    const context = fixture();
    await context.composite.initialize();
    expect(() => context.composite.getSnapshot("missing_session")).toThrowError(
      EpochGuardServiceError,
    );
    try {
      context.composite.getSnapshot("missing_session");
    } catch (error) {
      expectServiceError(error, "SESSION_NOT_FOUND");
    }

    context.normalStore.data.sessions.push(
      makeSession("wrong_runtime_partition", "impossible-collage-v1"),
    );
    try {
      context.composite.getSnapshot("wrong_runtime_partition");
    } catch (error) {
      expectServiceError(error, "PROJECTION_MISMATCH");
    }
  });

  it("returns canonical PROJECTION_MISMATCH for runtime duplicate IDs and two active Sessions", async () => {
    const duplicate = fixture();
    await duplicate.composite.initialize();
    duplicate.normalStore.data.sessions.push(
      makeSession("runtime_duplicate", "normal-world-v1"),
    );
    duplicate.impossibleStore.data.sessions.push(
      makeSession("runtime_duplicate", "impossible-collage-v1"),
    );
    try {
      duplicate.composite.getSnapshot("runtime_duplicate");
      throw new Error("Expected duplicate projection failure");
    } catch (error) {
      expectServiceError(error, "PROJECTION_MISMATCH");
    }

    const twoActive = fixture();
    await twoActive.composite.initialize();
    twoActive.normalStore.data.sessions.push(
      makeSession("runtime_active_normal", "normal-world-v1", "COLLECTING"),
    );
    twoActive.impossibleStore.data.sessions.push(
      makeSession(
        "runtime_active_impossible",
        "impossible-collage-v1",
        "REOBSERVING",
      ),
    );
    try {
      twoActive.composite.getSnapshot("runtime_active_normal");
      throw new Error("Expected two-active projection failure");
    } catch (error) {
      expectServiceError(error, "PROJECTION_MISMATCH");
    }
  });

  it.each(["create", "refresh", "commit"] as const)(
    "linearizes %s against reset",
    async (operation) => {
      const normal = completeDatabase();
      if (operation !== "create") {
        normal.sessions.push(makeSession("linear_session", "normal-world-v1"));
      }
      const context = fixture(normal, completeDatabase());
      await context.composite.initialize();
      const gate = deferred();
      context.normalService.hooks[operation] = () => gate.promise;

      const mutation =
        operation === "create"
          ? context.composite.createSession(CREATE_REQUESTS.normal)
          : operation === "refresh"
            ? context.composite.refresh("linear_session", {
                expectedSessionRevision: 1,
                refreshPlanId: "refresh_linear",
              })
            : context.composite.commit("linear_session", {
                expectedSessionRevision: 1,
              });
      await Promise.resolve();
      const reset = context.composite.resetDemo();
      await Promise.resolve();
      expect(context.normalService.resetCalls).toBe(0);

      gate.resolve();
      await mutation;
      await reset;
      expect(context.normalService.resetCalls).toBe(1);
      expect(context.impossibleService.resetCalls).toBe(1);
      expect(context.operationLog.indexOf("reset:normal:start")).toBeGreaterThan(
        context.operationLog.indexOf(`${operation}:normal:end`),
      );
    },
  );

  it.each(["create", "refresh", "commit"] as const)(
    "does not let %s overtake a reset-first barrier",
    async (operation) => {
      const normal = completeDatabase();
      if (operation !== "create") {
        normal.sessions.push(makeSession("reset_first_session", "normal-world-v1"));
      }
      const context = fixture(normal, completeDatabase());
      await context.composite.initialize();
      const gate = deferred();
      context.normalService.hooks.reset = () => gate.promise;

      const reset = context.composite.resetDemo();
      await waitForCondition(() => context.normalService.resetCalls === 1);
      const mutation =
        operation === "create"
          ? context.composite.createSession(CREATE_REQUESTS.normal)
          : operation === "refresh"
            ? context.composite.refresh("reset_first_session", {
                expectedSessionRevision: 1,
                refreshPlanId: "refresh_reset_first",
              })
            : context.composite.commit("reset_first_session", {
                expectedSessionRevision: 1,
              });
      let mutationSettled = false;
      void mutation.then(
        () => {
          mutationSettled = true;
        },
        () => {
          mutationSettled = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mutationSettled).toBe(false);
      expect(context.normalService.createCalls).toBe(0);
      expect(context.normalService.refreshCalls).toBe(0);
      expect(context.normalService.commitCalls).toBe(0);

      gate.resolve();
      await reset;
      if (operation === "create") {
        await expect(mutation).resolves.toMatchObject({
          scenarioId: "normal-world-v1",
        });
        expect(context.normalService.createCalls).toBe(1);
      } else {
        await expectServiceRejection(mutation, "SESSION_NOT_FOUND");
        expect(context.normalService.refreshCalls).toBe(0);
        expect(context.normalService.commitCalls).toBe(0);
      }
      expect(context.operationLog).toContain("reset:impossible:end");
      const operationStart = context.operationLog.indexOf(
        `${operation}:normal:start`,
      );
      if (operation === "create") {
        expect(operationStart).toBeGreaterThan(
          context.operationLog.indexOf("reset:impossible:end"),
        );
      } else {
        expect(operationStart).toBe(-1);
      }
    },
  );

  it("preflights both Stores before reset and preserves active data", async () => {
    const normal = completeDatabase();
    normal.sessions.push(
      makeSession("active_reset", "normal-world-v1", "READY_AT_CURRENT_HEAD"),
    );
    const context = fixture(normal, completeDatabase());
    await context.composite.initialize();
    await expect(context.composite.resetDemo()).rejects.toSatisfy((error) => {
      expectServiceError(error, "AGENTS_BUSY");
      return true;
    });
    expect(context.normalService.resetCalls).toBe(0);
    expect(context.impossibleService.resetCalls).toBe(0);
    expect(context.normalStore.data.sessions).toHaveLength(1);
  });
});

describe("DualScenarioEpochGuardService world and effect projections", () => {
  it("chooses the unique active partition", async () => {
    const impossible = completeDatabase();
    impossible.headSeq = 21;
    impossible.sessions.push(
      makeSession(
        "active_world",
        "impossible-collage-v1",
        "BLOCKED_NO_CUT",
      ),
    );
    const context = fixture(completeDatabase(), impossible);
    await context.composite.initialize();
    expect(context.composite.getWorld().headSeq).toBe(21);
  });

  it("uses latest stateUpdatedAt without an active Session and breaks ties toward Normal", async () => {
    const normal = completeDatabase();
    const impossible = completeDatabase();
    normal.headSeq = 10;
    impossible.headSeq = 21;
    normal.sessions.push(
      makeSession(
        "older_normal",
        "normal-world-v1",
        "COMMITTED",
        "2026-08-30T00:00:00.000Z",
      ),
    );
    impossible.sessions.push(
      makeSession(
        "newer_impossible",
        "impossible-collage-v1",
        "CONSISTENT_DENY",
        "2026-08-30T01:00:00.000Z",
      ),
    );
    const context = fixture(normal, impossible);
    await context.composite.initialize();
    expect(context.composite.getWorld().headSeq).toBe(21);

    context.normalStore.data.sessions[0]!.stateUpdatedAt =
      "2026-08-30T01:00:00.000Z";
    expect(context.composite.getWorld().headSeq).toBe(10);
  });

  it("uses Normal for two empty Stores", async () => {
    const normal = completeDatabase();
    normal.headSeq = 10;
    const impossible = completeDatabase();
    impossible.headSeq = 21;
    const context = fixture(normal, impossible);
    await context.composite.initialize();
    expect(context.composite.getWorld().headSeq).toBe(10);
  });

  it("aggregates deterministic effect order and rejects duplicate effect IDs", async () => {
    const normal = completeDatabase();
    const impossible = completeDatabase();
    const digest = sha256Digest("effect");
    const makeEffect = (
      effectId: string,
      sessionId: string,
      createdAt: string,
    ): EffectRecord => ({
      effectId,
      type: "PUBLISH_CAMPAIGN",
      idempotencyKey: `${sessionId}:key`,
      permitId: `permit_${effectId}`,
      sessionId,
      actionHash: digest,
      dependencySetHash: digest,
      jointValidityCertificateId: `jvc_${effectId}`,
      createdAt,
    });
    normal.effects.push(
      makeEffect("effect_a", "session_z", "2026-08-30T01:00:00.000Z"),
    );
    impossible.effects.push(
      makeEffect("effect_b", "session_a", "2026-08-30T01:00:00.000Z"),
      makeEffect("effect_earlier", "session_m", "2026-08-30T00:00:00.000Z"),
    );
    const context = fixture(normal, impossible);
    await context.composite.initialize();
    expect(
      context.composite.getEffects("campaign_42").effects.map(
        (effect) => effect.effectId,
      ),
    ).toEqual(["effect_earlier", "effect_a", "effect_b"]);

    context.impossibleStore.data.effects.push(
      makeEffect("effect_b", "session_c", "2026-08-30T02:00:00.000Z"),
    );
    expect(() => context.composite.getEffects("campaign_42")).toThrowError(
      EpochGuardServiceError,
    );
  });
});
