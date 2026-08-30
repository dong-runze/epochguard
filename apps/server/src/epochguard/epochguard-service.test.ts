import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentRun, CreateAgentInput } from "../types.js";
import type { EvidencePack } from "./evidence-pack-writer.js";
import { EpochStore } from "./epoch-store.js";
import {
  EpochGuardService,
  EpochGuardServiceError,
} from "./epochguard-service.js";
import {
  ROLES,
  sha256Digest,
  type CreateSessionRequest,
  type Role,
} from "./types.js";
import { WorldLedger } from "./world-ledger.js";

const NOW = "2026-08-30T00:00:00.000Z";
const STARTED = "2026-08-30T00:00:01.000Z";
const COMPLETED = "2026-08-30T00:00:02.000Z";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class TestWorkspace {
  readonly packs = new Map<string, Uint8Array>();

  async readAgentsMdDigest(agentId: string): Promise<string> {
    return sha256Digest(`AGENTS.md:${agentId}`);
  }

  async writeEvidencePackAtomic(
    _agentId: string,
    sessionId: string,
    role: Role,
    assignmentId: string,
    canonicalPack: string | Uint8Array,
  ): Promise<string> {
    const relativePath =
      `.epochguard/sessions/${sessionId}/${role}/${assignmentId}.json`;
    if (this.packs.has(relativePath)) {
      throw new Error("Evidence Pack path was reused");
    }
    const bytes =
      typeof canonicalPack === "string"
        ? Buffer.from(canonicalPack, "utf8")
        : Uint8Array.from(canonicalPack);
    this.packs.set(relativePath, bytes);
    return relativePath;
  }

  readPack(relativePath: string): EvidencePack {
    const bytes = this.packs.get(relativePath);
    if (bytes === undefined) throw new Error("Evidence Pack was not written");
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as EvidencePack;
  }
}

type StoredRun = {
  queued: AgentRun;
  completed: AgentRun;
  held: boolean;
};

type InitialFanOutBarrier = {
  failureRole: Role;
  startedRoles: Set<Role>;
  allStarted: Promise<void>;
  resolveAllStarted: () => void;
  released: Promise<void>;
  release: () => void;
};

class TestAgentRuntime {
  readonly dispatchCounts: Record<Role, number> = {
    inventory: 0,
    budget: 0,
    policy: 0,
  };

  private readonly agents = new Map<string, Agent>();
  private readonly rolesByAgent = new Map<string, Role>();
  private readonly runs = new Map<string, StoredRun>();
  private agentSequence = 0;
  private runSequence = 0;
  private holdSecondBudgetRun = false;
  private failSecondBudgetRun = false;
  private rejectSecondBudgetOutput = false;
  private allowSecondBudgetDecision = false;
  private initialFanOutBarrier: InitialFanOutBarrier | null = null;

  constructor(private readonly workspaces: TestWorkspace) {}

  async systemInfo(): Promise<Record<string, unknown>> {
    return { runtime: "Controlled EpochGuard Test Runtime" };
  }

  getAgent(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new Error("Agent not found");
    return structuredClone(agent);
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const role = this.roleFromName(input.name);
    this.agentSequence += 1;
    const agent: Agent = {
      id: `agent_${role}_${this.agentSequence}`,
      name: input.name,
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      status: "ready",
      workspacePath: `C:/epochguard-test/${role}`,
      codexThreadId: null,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.agents.set(agent.id, structuredClone(agent));
    this.rolesByAgent.set(agent.id, role);
    return structuredClone(agent);
  }

  async sendMessage(agentId: string, prompt: string): Promise<{ run: AgentRun }> {
    const role = this.rolesByAgent.get(agentId);
    if (role === undefined) throw new Error("Unknown Role Agent");
    const pathMatch = /^Read (.+)\.$/m.exec(prompt);
    if (pathMatch?.[1] === undefined) {
      throw new Error("Assignment prompt omitted its Evidence Pack path");
    }
    const pack = this.workspaces.readPack(pathMatch[1]);
    this.dispatchCounts[role] += 1;
    const initialBarrier = this.initialFanOutBarrier;
    if (initialBarrier !== null && this.dispatchCounts[role] === 1) {
      initialBarrier.startedRoles.add(role);
      if (initialBarrier.startedRoles.size === ROLES.length) {
        initialBarrier.resolveAllStarted();
      }
      await initialBarrier.released;
      if (initialBarrier.failureRole === role) {
        throw new Error(`Controlled ${role} initial dispatch failure`);
      }
    }
    this.runSequence += 1;
    const runId = `run_${role}_${this.runSequence}`;
    const queued: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      threadId: null,
      startedAt: null,
      completedAt: null,
      createdAt: NOW,
    };
    const shouldFail =
      this.failSecondBudgetRun &&
      role === "budget" &&
      this.dispatchCounts.budget === 2;
    const shouldRejectOutput =
      this.rejectSecondBudgetOutput &&
      role === "budget" &&
      this.dispatchCounts.budget === 2;
    const completed: AgentRun = {
      ...queued,
      status: shouldFail ? "failed" : "completed",
      output: shouldFail
        ? null
        : shouldRejectOutput
          ? "controlled malformed output"
          : this.renderDecision(
              pack,
              this.allowSecondBudgetDecision &&
                role === "budget" &&
                this.dispatchCounts.budget === 2
                ? "ALLOW"
                : undefined,
            ),
      error: shouldFail ? "Controlled Budget refresh failure" : null,
      usage: shouldFail ? null : { inputTokens: 20, outputTokens: 10 },
      threadId: shouldFail ? null : `thread_${role}_${this.runSequence}`,
      startedAt: STARTED,
      completedAt: COMPLETED,
    };
    this.runs.set(runId, {
      queued,
      completed,
      held:
        this.holdSecondBudgetRun &&
        role === "budget" &&
        this.dispatchCounts.budget === 2,
    });
    return { run: structuredClone(queued) };
  }

  getRun(runId: string): AgentRun {
    const stored = this.runs.get(runId);
    if (stored === undefined) throw new Error("Run not found");
    return structuredClone(stored.held ? stored.queued : stored.completed);
  }

  holdRefreshBudgetRun(): void {
    this.holdSecondBudgetRun = true;
  }

  failRefreshBudgetRun(): void {
    this.failSecondBudgetRun = true;
  }

  rejectRefreshBudgetOutput(): void {
    this.rejectSecondBudgetOutput = true;
  }

  allowRefreshBudgetDecision(): void {
    this.allowSecondBudgetDecision = true;
  }

  prepareInitialFanOutDispatchFailure(failureRole: Role): void {
    let resolveAllStarted: () => void = () => undefined;
    let release: () => void = () => undefined;
    const allStarted = new Promise<void>((resolve) => {
      resolveAllStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.initialFanOutBarrier = {
      failureRole,
      startedRoles: new Set<Role>(),
      allStarted,
      resolveAllStarted,
      released,
      release,
    };
  }

  async waitForInitialFanOutDispatches(): Promise<void> {
    if (this.initialFanOutBarrier === null) {
      throw new Error("Initial fan-out barrier was not prepared");
    }
    await this.initialFanOutBarrier.allStarted;
  }

  initialFanOutStartedRoles(): ReadonlySet<Role> {
    return new Set(this.initialFanOutBarrier?.startedRoles ?? []);
  }

  releaseInitialFanOutDispatches(): void {
    if (this.initialFanOutBarrier === null) {
      throw new Error("Initial fan-out barrier was not prepared");
    }
    this.initialFanOutBarrier.release();
  }

  runIds(): string[] {
    return [...this.runs.keys()];
  }

  releaseRefreshBudgetRun(): void {
    for (const stored of this.runs.values()) stored.held = false;
  }

  private roleFromName(name: string): Role {
    const lower = name.toLowerCase();
    const role = ROLES.find((candidate) => lower.includes(candidate));
    if (role === undefined) throw new Error("Agent name does not identify a Role");
    return role;
  }

  private renderDecision(
    pack: EvidencePack,
    forcedVerdict?: "ALLOW" | "DENY",
  ): string {
    let verdict: "ALLOW" | "DENY";
    if (forcedVerdict !== undefined) {
      verdict = forcedVerdict;
    } else {
      switch (pack.assignment.role) {
        case "inventory":
          verdict =
            pack.observation.availableUnits >= pack.action.requestedUnits
              ? "ALLOW"
              : "DENY";
          break;
        case "budget":
          verdict =
            pack.observation.remainingBudgetCents >=
            pack.action.estimatedCostCents
              ? "ALLOW"
              : "DENY";
          break;
        case "policy":
          verdict = pack.observation.permitted ? "ALLOW" : "DENY";
          break;
      }
    }
    return [
      "<EPOCH_DECISION>",
      JSON.stringify({
        schemaVersion: 1,
        sessionId: pack.assignment.sessionId,
        actionHash: pack.assignment.actionHash,
        runAssignmentId: pack.assignment.runAssignmentId,
        role: pack.assignment.role,
        receiptId: pack.observation.receiptId,
        nonce: pack.observation.nonce,
        verdict,
        reason: `${pack.assignment.role} evidence deterministically yields ${verdict}.`,
      }),
      "</EPOCH_DECISION>",
    ].join("\n");
  }
}

class FastTestClock {
  private elapsed = 0;

  now(): string {
    return NOW;
  }

  monotonicMs(): number {
    return this.elapsed;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.elapsed += milliseconds;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function createHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "epochguard-eg08-"));
  temporaryDirectories.push(directory);
  const storePath = path.join(directory, "epochguard.json");
  const store = new EpochStore(storePath);
  const workspaces = new TestWorkspace();
  const agents = new TestAgentRuntime(workspaces);
  let idSequence = 0;
  let nonceSequence = 0;
  const makeService = (targetStore = store) =>
    new EpochGuardService(
      { store: targetStore, agents, workspaces },
      {
        now: () => NOW,
        monotonicMs: () => 1,
        createId: (prefix) => `${prefix}_eg08_${++idSequence}`,
        nonceFactory: () =>
          `${(++nonceSequence).toString(36).padStart(4, "0")}${"n".repeat(28)}`,
        runObserver: {
          pollIntervalMs: 200,
          timeoutMs: 10_000_000,
          clock: new FastTestClock(),
        },
      },
    );
  const service = makeService();
  await service.initialize();
  const registrations = store.snapshot().roleAgentRegistrations;
  const requestFor = (
    scenarioId: CreateSessionRequest["scenarioId"],
  ): CreateSessionRequest => ({
    scenarioId,
    assignments: {
      inventory: registrations.find((item) => item.role === "inventory")!.agentId,
      budget: registrations.find((item) => item.role === "budget")!.agentId,
      policy: registrations.find((item) => item.role === "policy")!.agentId,
    },
  });
  const forkPersistedService = async () => {
    const forkDirectory = await mkdtemp(
      path.join(tmpdir(), "epochguard-eg08-restart-"),
    );
    temporaryDirectories.push(forkDirectory);
    const forkStorePath = path.join(forkDirectory, "epochguard.json");
    await copyFile(storePath, forkStorePath);
    const forkStore = new EpochStore(forkStorePath);
    return {
      service: makeService(forkStore),
      store: forkStore,
    };
  };
  return {
    agents,
    forkPersistedService,
    requestFor,
    restartService: makeService,
    service,
    store,
    workspaces,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for the controlled service state");
}

describe("EpochGuardService", () => {
  it("runs the Normal chain and makes concurrent/lost Commit responses exactly-once", async () => {
    const { service, store, requestFor, agents } = await createHarness();
    const ready = await service.createSession(requestFor("normal-world-v1"));

    expect(ready.sessionState).toBe("READY_AT_CURRENT_HEAD");
    expect(ready.metrics.allowDecisions).toBe(3);
    expect(ready.gate.effectsInSession).toBe(0);
    expect(agents.dispatchCounts).toEqual({ inventory: 1, budget: 1, policy: 1 });
    const issuedPermits = store
      .snapshot()
      .permits.filter((permit) => permit.sessionId === ready.sessionId);
    expect(issuedPermits).toHaveLength(1);
    expect(issuedPermits[0]).toMatchObject({
      status: "ISSUED",
      consumedAt: null,
    });

    const request = { expectedSessionRevision: ready.sessionRevision };
    const [left, right] = await Promise.all([
      service.commit(ready.sessionId, request),
      service.commit(ready.sessionId, request),
    ]);
    const lostResponseRetry = await service.commit(ready.sessionId, request);

    expect(left.status).toBe("COMMITTED");
    expect(right.status).toBe("COMMITTED");
    expect(lostResponseRetry.status).toBe("COMMITTED");
    expect(left.effect?.effectId).toBe(right.effect?.effectId);
    expect(left.effect?.effectId).toBe(lostResponseRetry.effect?.effectId);
    expect(
      [left, right].filter(
        (result) => result.status === "COMMITTED" && result.created,
      ),
    ).toHaveLength(1);
    expect(lostResponseRetry).toMatchObject({
      status: "COMMITTED",
      created: false,
    });
    const committedDatabase = store.snapshot();
    expect(committedDatabase.effects).toHaveLength(1);
    const consumedPermits = committedDatabase.permits.filter(
      (permit) => permit.sessionId === ready.sessionId,
    );
    expect(consumedPermits).toHaveLength(1);
    expect(consumedPermits[0]).toMatchObject({
      permitId: issuedPermits[0]!.permitId,
      status: "CONSUMED",
    });
    expect(consumedPermits[0]!.consumedAt).not.toBeNull();
    expect(service.getSnapshot(ready.sessionId).gate.effectsInSession).toBe(1);
  });

  it("fails a stale-head Commit as COMMIT_RACE with an exact transient diagnostic", async () => {
    const { service, store, requestFor } = await createHarness();
    const ready = await service.createSession(requestFor("normal-world-v1"));
    const ledger = new WorldLedger({ now: () => NOW });
    await store.mutate((database) => {
      ledger.commit(database, {
        changes: [
          {
            resourceId: "test:commit-race",
            value: { advanced: true },
          },
        ],
        reason: "Advance the authoritative head before controlled Commit",
        createdAt: NOW,
      });
    });

    const result = await service.commit(ready.sessionId, {
      expectedSessionRevision: ready.sessionRevision,
    });

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "COMMIT_RACE",
      effectsInSession: 0,
      error: null,
    });
    const raced = service.getSnapshot(ready.sessionId);
    expect(raced.sessionState).toBe("COMMIT_RACE");
    expect(raced.gate).toMatchObject({
      state: "LOCKED",
      reasonCode: "COMMIT_RACE",
      effectsInSession: 0,
    });
    expect(raced.latestDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "TRANSIENT_RACE",
          stage: "COMMIT",
          reasonCode: "COMMIT_RACE",
        }),
      ]),
    );
    const racedDatabase = store.snapshot();
    expect(racedDatabase.effects).toHaveLength(0);
    expect(racedDatabase.permits).toEqual([
      expect.objectContaining({ status: "REVOKED", consumedAt: null }),
    ]);
    const raceEvents = racedDatabase.auditEvents.filter(
      (event) =>
        event.sessionId === ready.sessionId &&
        event.sessionRevision === raced.sessionRevision &&
        event.type === "SESSION_STATE" &&
        event.status === "COMMIT_RACE",
    );
    const raceDiagnostics = racedDatabase.diagnostics.filter(
      (diagnostic) =>
        diagnostic.sessionId === ready.sessionId &&
        diagnostic.sessionRevision === raced.sessionRevision &&
        diagnostic.stage === "COMMIT" &&
        diagnostic.reasonCode === "COMMIT_RACE",
    );
    expect(raceEvents).toHaveLength(1);
    expect(raceDiagnostics).toHaveLength(1);
    expect(raceEvents[0]!.artifactRefs).toEqual(
      raceDiagnostics[0]!.artifactRefs,
    );
  });

  it("blocks the Impossible first cut, refreshes only Budget, and ends DENY with no Effect", async () => {
    const { service, store, requestFor, agents } = await createHarness();
    const blocked = await service.createSession(
      requestFor("impossible-collage-v1"),
    );

    expect(blocked.sessionState).toBe("BLOCKED_NO_CUT");
    expect(blocked.metrics.allowDecisions).toBe(3);
    expect(blocked.jointValidity.state).toBe("NO_CUT");
    expect(blocked.gate.effectsInSession).toBe(0);
    expect(blocked.refreshPlan?.agentIds).toEqual([
      blocked.agents.find((agent) => agent.role === "budget")!.agentId,
    ]);
    const blockedDatabase = store.snapshot();
    const blockedSession = blockedDatabase.sessions.find(
      (session) => session.sessionId === blocked.sessionId,
    )!;
    const originValidation = blockedDatabase.validations.find(
      (validation) =>
        validation.validationId === blockedSession.activeValidationId,
    )!;
    const availablePlan = blockedDatabase.refreshPlans.find(
      (plan) => plan.refreshPlanId === blocked.refreshPlan!.refreshPlanId,
    )!;
    expect(originValidation.baseSessionRevision + 1).toBe(
      availablePlan.baseSessionRevision,
    );
    expect(availablePlan.baseSessionRevision).toBe(
      blockedSession.sessionRevision,
    );

    const recovered = await service.refresh(blocked.sessionId, {
      expectedSessionRevision: blocked.sessionRevision,
      refreshPlanId: blocked.refreshPlan!.refreshPlanId,
    });

    expect(recovered.sessionState).toBe("CONSISTENT_DENY");
    expect(recovered.metrics.allowDecisions).toBe(2);
    expect(recovered.metrics.denyDecisions).toBe(1);
    expect(recovered.refreshPlan?.status).toBe("COMPLETED");
    expect(recovered.gate.effectsInSession).toBe(0);
    const recoveredDatabase = store.snapshot();
    const recoveredSession = recoveredDatabase.sessions.find(
      (session) => session.sessionId === recovered.sessionId,
    )!;
    const recoveredValidation = recoveredDatabase.validations.find(
      (validation) =>
        validation.validationId === recoveredSession.activeValidationId,
    )!;
    expect(recoveredValidation.outcome).toBe("CONSISTENT_DENY");
    expect(recoveredValidation.jointValidityCertificateId).not.toBeNull();
    expect(
      recoveredDatabase.jointValidityCertificates.some(
        (certificate) =>
          certificate.certificateId ===
          recoveredValidation.jointValidityCertificateId,
      ),
    ).toBe(true);
    expect(recoveredSession.activeRefreshPlanId).toBe(
      recovered.refreshPlan!.refreshPlanId,
    );
    expect(recoveredDatabase.permits).toHaveLength(0);
    expect(recoveredDatabase.effects).toHaveLength(0);
    expect(agents.dispatchCounts).toEqual({ inventory: 1, budget: 2, policy: 1 });
  });

  it("retains the completed selective RefreshPlan through READY and Commit", async () => {
    const { service, store, requestFor, agents } = await createHarness();
    const blocked = await service.createSession(
      requestFor("impossible-collage-v1"),
    );
    agents.allowRefreshBudgetDecision();

    const ready = await service.refresh(blocked.sessionId, {
      expectedSessionRevision: blocked.sessionRevision,
      refreshPlanId: blocked.refreshPlan!.refreshPlanId,
    });

    expect(ready.sessionState).toBe("READY_AT_CURRENT_HEAD");
    expect(ready.metrics.allowDecisions).toBe(3);
    expect(ready.refreshPlan).toMatchObject({
      refreshPlanId: blocked.refreshPlan!.refreshPlanId,
      status: "COMPLETED",
    });
    const projected = service.getSnapshot(ready.sessionId);
    expect(projected.refreshPlan).toEqual(ready.refreshPlan);
    const readyDatabase = store.snapshot();
    const readySession = readyDatabase.sessions.find(
      (session) => session.sessionId === ready.sessionId,
    )!;
    const readyValidation = readyDatabase.validations.find(
      (validation) =>
        validation.validationId === readySession.activeValidationId,
    )!;
    expect(readySession.activeRefreshPlanId).toBe(
      blocked.refreshPlan!.refreshPlanId,
    );
    expect(readyValidation.refreshPlanId).toBe(
      blocked.refreshPlan!.refreshPlanId,
    );
    expect(
      readyDatabase.refreshPlans.find(
        (plan) => plan.refreshPlanId === blocked.refreshPlan!.refreshPlanId,
      ),
    ).toMatchObject({ status: "COMPLETED" });

    const committed = await service.commit(ready.sessionId, {
      expectedSessionRevision: ready.sessionRevision,
    });
    expect(committed).toMatchObject({
      status: "COMMITTED",
      effectsInSession: 1,
    });
    const released = service.getSnapshot(ready.sessionId);
    expect(released.gate.effectsInSession).toBe(1);
    expect(store.snapshot().effects).toHaveLength(1);

    const beforeReplay = store.snapshot();
    const dispatchesBeforeReplay = structuredClone(agents.dispatchCounts);
    await expect(
      service.refresh(ready.sessionId, {
        expectedSessionRevision: released.sessionRevision,
        refreshPlanId: blocked.refreshPlan!.refreshPlanId,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      body: {
        error: "STALE_VIEW",
        sessionId: ready.sessionId,
        expectedSessionRevision: released.sessionRevision,
        actualSessionRevision: released.sessionRevision,
      },
    } satisfies Partial<EpochGuardServiceError>);
    expect(store.snapshot()).toEqual(beforeReplay);
    expect(agents.dispatchCounts).toEqual(dispatchesBeforeReplay);
  });

  it("exposes a lost Refresh as CLAIMED and rejects a duplicate without a second Run", async () => {
    const { service, store, requestFor, agents } = await createHarness();
    const blocked = await service.createSession(
      requestFor("impossible-collage-v1"),
    );
    const beforeClaim = store.snapshot();
    const initialBudgetAssignmentIds = new Set(
      beforeClaim.runAssignments
        .filter(
          (assignment) =>
            assignment.sessionId === blocked.sessionId &&
            assignment.role === "budget",
        )
        .map((assignment) => assignment.assignmentId),
    );
    const initialBudgetAttemptIds = new Set(
      beforeClaim.attempts
        .filter(
          (attempt) =>
            attempt.sessionId === blocked.sessionId && attempt.role === "budget",
        )
        .map((attempt) => attempt.attemptId),
    );
    const initialRunIds = new Set(agents.runIds());
    const request = {
      expectedSessionRevision: blocked.sessionRevision,
      refreshPlanId: blocked.refreshPlan!.refreshPlanId,
    };
    agents.holdRefreshBudgetRun();

    const first = service.refresh(blocked.sessionId, request);
    let recovered: Awaited<ReturnType<EpochGuardService["refresh"]>> | null = null;
    try {
      await waitUntil(() => {
        const database = store.snapshot();
        const plan = database.refreshPlans.find(
          (candidate) => candidate.refreshPlanId === request.refreshPlanId,
        );
        const attempt = database.attempts.find(
          (candidate) => candidate.attemptId === plan?.claimedAttemptId,
        );
        const assignment = database.runAssignments.find(
          (candidate) => candidate.assignmentId === attempt?.assignmentId,
        );
        return (
          agents.dispatchCounts.budget === 2 &&
          plan?.status === "CLAIMED" &&
          attempt?.runId !== null &&
          attempt?.runId !== undefined &&
          assignment?.boundRunId === attempt.runId
        );
      });
      const claimed = service.getSnapshot(blocked.sessionId);
      const claimedAttemptId =
        claimed.agents.find((agent) => agent.role === "budget")!.inFlightAttempt!
          .attemptId;
      const claimedDatabase = store.snapshot();
      const claimedSession = claimedDatabase.sessions.find(
        (session) => session.sessionId === blocked.sessionId,
      )!;
      const claimedPlan = claimedDatabase.refreshPlans.find(
        (plan) => plan.refreshPlanId === request.refreshPlanId,
      )!;
      const newBudgetAssignments = claimedDatabase.runAssignments.filter(
        (assignment) =>
          assignment.sessionId === blocked.sessionId &&
          assignment.role === "budget" &&
          !initialBudgetAssignmentIds.has(assignment.assignmentId),
      );
      const newBudgetAttempts = claimedDatabase.attempts.filter(
        (attempt) =>
          attempt.sessionId === blocked.sessionId &&
          attempt.role === "budget" &&
          !initialBudgetAttemptIds.has(attempt.attemptId),
      );
      const newRunIds = agents
        .runIds()
        .filter((runId) => !initialRunIds.has(runId));

      expect(newBudgetAssignments).toHaveLength(1);
      expect(newBudgetAttempts).toHaveLength(1);
      expect(newRunIds).toHaveLength(1);
      expect(new Set(agents.runIds()).size).toBe(agents.runIds().length);
      expect(newBudgetAttempts[0]).toMatchObject({
        attemptId: claimedAttemptId,
        assignmentId: newBudgetAssignments[0]!.assignmentId,
        runId: newRunIds[0],
      });
      expect(claimedPlan.claimedAttemptId).toBe(claimedAttemptId);
      expect(claimedSession.activeAttemptIds).toEqual({
        inventory: null,
        budget: claimedAttemptId,
        policy: null,
      });

      await expect(service.refresh(blocked.sessionId, request)).rejects.toMatchObject({
        statusCode: 409,
        body: {
          error: "ALREADY_REOBSERVING",
          sessionId: blocked.sessionId,
          refreshPlanId: request.refreshPlanId,
          attemptId: claimedAttemptId,
        },
      } satisfies Partial<EpochGuardServiceError>);
      expect(claimed.sessionState).toBe("REOBSERVING");
      expect(claimed.refreshPlan?.status).toBe("CLAIMED");
      expect(agents.dispatchCounts.budget).toBe(2);
      expect(
        store
          .snapshot()
          .runAssignments.filter(
            (assignment) =>
              assignment.sessionId === blocked.sessionId &&
              assignment.role === "budget" &&
              !initialBudgetAssignmentIds.has(assignment.assignmentId),
          ),
      ).toHaveLength(1);
      expect(
        agents.runIds().filter((runId) => !initialRunIds.has(runId)),
      ).toEqual(newRunIds);
    } finally {
      agents.releaseRefreshBudgetRun();
      recovered = await first;
    }
    expect(recovered?.sessionState).toBe("CONSISTENT_DENY");
    expect(agents.dispatchCounts.budget).toBe(2);
  });

  it("keeps a terminal claimed Budget refresh publicly visible after Run failure", async () => {
    const { service, store, requestFor, agents } = await createHarness();
    const blocked = await service.createSession(
      requestFor("impossible-collage-v1"),
    );
    agents.failRefreshBudgetRun();

    await expect(
      service.refresh(blocked.sessionId, {
        expectedSessionRevision: blocked.sessionRevision,
        refreshPlanId: blocked.refreshPlan!.refreshPlanId,
      }),
    ).rejects.toMatchObject({ code: "RUN_FAILED" });

    const failed = service.getSnapshot(blocked.sessionId);
    const budget = failed.agents.find((agent) => agent.role === "budget")!;
    expect(failed.sessionState).toBe("FAILED");
    expect(failed.gate.state).toBe("FAILED");
    expect(failed.gate.effectsInSession).toBe(0);
    expect(failed.refreshPlan?.status).toBe("CLAIMED");
    expect(budget.inFlightAttempt?.status).toBe("FAILED");
    expect(failed.latestDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "SYSTEM_FAILURE",
          stage: "RUN",
          reasonCode: "RUN_FAILED",
          role: "budget",
        }),
      ]),
    );
    expect(store.snapshot().effects).toHaveLength(0);
  });

  it("keeps a rejected refresh output attached to its claimed Budget Attempt", async () => {
    const { service, store, requestFor, agents } = await createHarness();
    const blocked = await service.createSession(
      requestFor("impossible-collage-v1"),
    );
    agents.rejectRefreshBudgetOutput();

    const failed = await service.refresh(blocked.sessionId, {
      expectedSessionRevision: blocked.sessionRevision,
      refreshPlanId: blocked.refreshPlan!.refreshPlanId,
    });

    const budget = failed.agents.find((agent) => agent.role === "budget")!;
    expect(failed.sessionState).toBe("FAILED");
    expect(failed.gate.state).toBe("FAILED");
    expect(failed.gate.effectsInSession).toBe(0);
    expect(failed.refreshPlan?.status).toBe("CLAIMED");
    expect(budget.inFlightAttempt?.status).toBe("OUTPUT_REJECTED");
    expect(failed.latestDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "SYSTEM_FAILURE",
          stage: "PARSE",
          reasonCode: "OUTPUT_MALFORMED",
          role: "budget",
        }),
      ]),
    );
    expect(store.snapshot().rejectedOutputArtifacts).toHaveLength(1);
    expect(store.snapshot().effects).toHaveLength(0);
  });

  it("starts all three initial dispatches before one fails and closes the Session", async () => {
    const { service, store, requestFor, agents } = await createHarness();
    agents.prepareInitialFanOutDispatchFailure("budget");

    const creating = service.createSession(requestFor("normal-world-v1"));
    await agents.waitForInitialFanOutDispatches();
    expect(agents.initialFanOutStartedRoles()).toEqual(new Set(ROLES));
    expect(agents.dispatchCounts).toEqual({
      inventory: 1,
      budget: 1,
      policy: 1,
    });
    agents.releaseInitialFanOutDispatches();

    const failed = await creating;
    expect(failed.sessionState).toBe("FAILED");
    expect(failed.gate.effectsInSession).toBe(0);
    expect(failed.latestDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "SYSTEM_FAILURE",
          stage: "DISPATCH",
          reasonCode: "RUN_FAILED",
          role: "budget",
        }),
      ]),
    );
    const database = store.snapshot();
    expect(database.sessions).toHaveLength(1);
    const session = database.sessions[0]!;
    expect(failed.sessionId).toBe(session.sessionId);
    expect(session.state).toBe("FAILED");
    expect(database.effects).toHaveLength(0);
    expect(database.permits).toHaveLength(0);
    expect(
      database.runAssignments.filter(
        (assignment) => assignment.sessionId === session.sessionId,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "inventory", status: "REJECTED" }),
        expect.objectContaining({ role: "budget", status: "REJECTED" }),
        expect.objectContaining({ role: "policy", status: "REJECTED" }),
      ]),
    );
    expect(database.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: session.sessionId,
          kind: "SYSTEM_FAILURE",
          stage: "DISPATCH",
          reasonCode: "RUN_FAILED",
          role: "budget",
          runId: null,
        }),
      ]),
    );
    expect(service.getSnapshot(session.sessionId)).toEqual(failed);
  });

  it("reserves one concurrent Create and returns AGENTS_BUSY before duplicate dispatch", async () => {
    const { service, requestFor, agents } = await createHarness();
    const request = requestFor("normal-world-v1");
    const settled = await Promise.allSettled([
      service.createSession(request),
      service.createSession(request),
    ]);

    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      statusCode: 409,
      body: { error: "AGENTS_BUSY" },
    });
    expect(agents.dispatchCounts).toEqual({ inventory: 1, budget: 1, policy: 1 });
  });

  it("recovers a persisted DISPATCHING Session as an idempotent public INTERRUPTED snapshot", async () => {
    const { service, restartService, store, requestFor } = await createHarness();
    const ready = await service.createSession(requestFor("normal-world-v1"));
    await store.mutate((database) => {
      const session = database.sessions.find(
        (candidate) => candidate.sessionId === ready.sessionId,
      )!;
      session.state = "DISPATCHING";
      session.sessionRevision += 1;
      session.stateUpdatedAt = NOW;
    });

    const restarted = restartService();
    await restarted.initialize();
    const interrupted = restarted.getSnapshot(ready.sessionId);
    expect(interrupted.sessionState).toBe("INTERRUPTED");
    expect(interrupted.gate).toMatchObject({
      state: "FAILED",
      reasonCode: "RUN_FAILED",
      effectsInSession: 0,
    });
    expect(interrupted.latestDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "SYSTEM_FAILURE",
          stage: "DISPATCH",
          reasonCode: "RUN_FAILED",
        }),
      ]),
    );
    const recoveredDatabase = store.snapshot();
    const recoveredSession = recoveredDatabase.sessions.find(
      (session) => session.sessionId === ready.sessionId,
    )!;
    expect(recoveredSession.activeAttemptIds).toEqual({
      inventory: null,
      budget: null,
      policy: null,
    });
    expect(recoveredSession.activeValidationId).toBeNull();
    expect(recoveredSession.activeRefreshPlanId).toBeNull();
    expect(recoveredSession.activePermitId).toBeNull();
    expect(
      recoveredDatabase.permits.filter(
        (permit) => permit.sessionId === ready.sessionId,
      ),
    ).toEqual([
      expect.objectContaining({ status: "REVOKED", consumedAt: null }),
    ]);
    expect(recoveredDatabase.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: ready.sessionId,
          sessionRevision: recoveredSession.sessionRevision,
          type: "SESSION_STATE",
          status: "INTERRUPTED",
        }),
      ]),
    );

    const snapshotRevision = recoveredDatabase.snapshotRevision;
    await restarted.initialize();
    expect(store.snapshot().snapshotRevision).toBe(snapshotRevision);
    expect(restarted.getSnapshot(ready.sessionId)).toEqual(interrupted);
  });

  it("preserves BLOCKED_NO_CUT across restart and can still refresh to DENY", async () => {
    const { agents, forkPersistedService, service, requestFor } =
      await createHarness();
    const blocked = await service.createSession(
      requestFor("impossible-collage-v1"),
    );
    const restarted = await forkPersistedService();
    await restarted.service.initialize();

    expect(restarted.service.getSnapshot(blocked.sessionId)).toEqual(blocked);
    const denied = await restarted.service.refresh(blocked.sessionId, {
      expectedSessionRevision: blocked.sessionRevision,
      refreshPlanId: blocked.refreshPlan!.refreshPlanId,
    });
    expect(denied.sessionState).toBe("CONSISTENT_DENY");
    expect(denied.refreshPlan?.status).toBe("COMPLETED");
    expect(denied.gate.effectsInSession).toBe(0);
    expect(restarted.store.snapshot().effects).toHaveLength(0);
    expect(restarted.store.snapshot().permits).toHaveLength(0);
    expect(agents.dispatchCounts).toEqual({
      inventory: 1,
      budget: 2,
      policy: 1,
    });
  });

  it("preserves READY_AT_CURRENT_HEAD across restart and commits exactly once", async () => {
    const { forkPersistedService, service, requestFor } = await createHarness();
    const ready = await service.createSession(requestFor("normal-world-v1"));
    const restarted = await forkPersistedService();
    await restarted.service.initialize();

    expect(restarted.service.getSnapshot(ready.sessionId)).toEqual(ready);
    const committed = await restarted.service.commit(ready.sessionId, {
      expectedSessionRevision: ready.sessionRevision,
    });
    expect(committed).toMatchObject({
      status: "COMMITTED",
      created: true,
      effectsInSession: 1,
    });
    const duplicate = await restarted.service.commit(ready.sessionId, {
      expectedSessionRevision: ready.sessionRevision,
    });
    expect(duplicate).toMatchObject({
      status: "COMMITTED",
      created: false,
      effectsInSession: 1,
    });
    expect(
      duplicate.status === "COMMITTED" ? duplicate.effect.effectId : null,
    ).toBe(committed.status === "COMMITTED" ? committed.effect.effectId : null);
    const committedDatabase = restarted.store.snapshot();
    expect(committedDatabase.effects).toHaveLength(1);
    expect(
      committedDatabase.permits.filter(
        (permit) => permit.sessionId === ready.sessionId,
      ),
    ).toEqual([
      expect.objectContaining({
        status: "CONSUMED",
        consumedAt: expect.any(String),
      }),
    ]);
  });

  it("recovers a persisted REOBSERVING claim while preserving its historical Plan and Attempt", async () => {
    const { agents, forkPersistedService, service, store, requestFor } =
      await createHarness();
    const blocked = await service.createSession(
      requestFor("impossible-collage-v1"),
    );
    agents.failRefreshBudgetRun();
    agents.holdRefreshBudgetRun();
    const refresh = service.refresh(blocked.sessionId, {
      expectedSessionRevision: blocked.sessionRevision,
      refreshPlanId: blocked.refreshPlan!.refreshPlanId,
    });
    const refreshOutcome = refresh.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let refreshFailure: unknown = null;

    try {
      await waitUntil(() => {
        const database = store.snapshot();
        const plan = database.refreshPlans.find(
          (candidate) =>
            candidate.refreshPlanId === blocked.refreshPlan!.refreshPlanId,
        );
        const attempt = database.attempts.find(
          (candidate) => candidate.attemptId === plan?.claimedAttemptId,
        );
        const assignment = database.runAssignments.find(
          (candidate) => candidate.assignmentId === attempt?.assignmentId,
        );
        return (
          plan?.status === "CLAIMED" &&
          attempt?.runId !== null &&
          attempt?.runId !== undefined &&
          assignment?.boundRunId === attempt.runId
        );
      });
      const beforeRestart = store.snapshot();
      const claimedPlan = beforeRestart.refreshPlans.find(
        (plan) => plan.refreshPlanId === blocked.refreshPlan!.refreshPlanId,
      )!;
      const claimedAttemptId = claimedPlan.claimedAttemptId!;

      const restarted = await forkPersistedService();
      await restarted.service.initialize();
      const interrupted = restarted.service.getSnapshot(blocked.sessionId);
      expect(interrupted.sessionState).toBe("INTERRUPTED");
      expect(interrupted.gate).toMatchObject({
        state: "FAILED",
        reasonCode: "RUN_FAILED",
        effectsInSession: 0,
      });
      expect(interrupted.latestDiagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "SYSTEM_FAILURE",
            stage: "DISPATCH",
            reasonCode: "RUN_FAILED",
          }),
        ]),
      );
      const recoveredDatabase = restarted.store.snapshot();
      const recoveredSession = recoveredDatabase.sessions.find(
        (session) => session.sessionId === blocked.sessionId,
      )!;
      expect(recoveredSession.activeAttemptIds).toEqual({
        inventory: null,
        budget: null,
        policy: null,
      });
      expect(recoveredSession.activeValidationId).toBeNull();
      expect(recoveredSession.activeRefreshPlanId).toBeNull();
      expect(recoveredSession.activePermitId).toBeNull();
      expect(
        recoveredDatabase.refreshPlans.find(
          (plan) => plan.refreshPlanId === claimedPlan.refreshPlanId,
        ),
      ).toMatchObject({
        status: "CLAIMED",
        claimedAttemptId,
      });
      expect(
        recoveredDatabase.attempts.some(
          (attempt) => attempt.attemptId === claimedAttemptId,
        ),
      ).toBe(true);
      expect(recoveredDatabase.effects).toHaveLength(0);
    } finally {
      agents.releaseRefreshBudgetRun();
      const outcome = await refreshOutcome;
      refreshFailure = outcome.status === "rejected" ? outcome.reason : null;
    }
    expect(refreshFailure).toMatchObject({ code: "RUN_FAILED" });
  });

  it("uses sessionRevision for CAS rather than global snapshotRevision", async () => {
    const first = await createHarness();
    const ready = await first.service.createSession(
      first.requestFor("normal-world-v1"),
    );
    const globalBefore = first.store.snapshot().snapshotRevision;
    await first.store.mutate(() => undefined);
    expect(first.store.snapshot().snapshotRevision).toBe(globalBefore + 1);
    await expect(
      first.service.commit(ready.sessionId, {
        expectedSessionRevision: ready.sessionRevision,
      }),
    ).resolves.toMatchObject({ status: "COMMITTED" });

    const second = await createHarness();
    const anotherReady = await second.service.createSession(
      second.requestFor("normal-world-v1"),
    );
    await second.store.mutate((database) => {
      database.sessions[0]!.sessionRevision += 1;
    });
    await expect(
      second.service.commit(anotherReady.sessionId, {
        expectedSessionRevision: anotherReady.sessionRevision,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      body: {
        error: "STALE_VIEW",
        expectedSessionRevision: anotherReady.sessionRevision,
        actualSessionRevision: anotherReady.sessionRevision + 1,
      },
    });
  });
});
