import { describe, expect, it, vi } from "vitest";
import {
  buildRefreshPlan,
  claimRefreshPlan,
  refreshSet,
  type ClaimRefreshPlanResult,
  type RefreshClaimArtifactContext,
  type RefreshMutationPort,
} from "./refresh-planner.js";
import {
  GOLDEN_ACTION_HASH,
  GOLDEN_ACTION_INPUT,
  buildRoleQuerySpec,
  sha256Digest,
  type AgentAttempt,
  type EpochDatabase,
  type EpochSession,
  type RefreshPlan,
  type RunAssignment,
  type ValidationRecord,
} from "./types.js";

const NOW = "2026-08-29T12:00:00.000Z";
const DIGEST = sha256Digest("fixture");

class MemoryRefreshStore implements RefreshMutationPort {
  private queue: Promise<void> = Promise.resolve();

  constructor(private database: EpochDatabase) {}

  snapshot(): EpochDatabase {
    return structuredClone(this.database);
  }

  async mutate<T>(
    mutation: (database: EpochDatabase) => T | Promise<T>,
  ): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.database);
      result = await mutation(next);
      this.database = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }
}

function emptyDatabase(): EpochDatabase {
  return {
    schemaVersion: 1,
    snapshotRevision: 0,
    headSeq: 21,
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

function blockedFixture(): {
  database: EpochDatabase;
  session: EpochSession;
  validation: ValidationRecord;
  plan: RefreshPlan;
} {
  const decisionIds = [
    "decision_inventory_1",
    "decision_budget_1",
    "decision_policy_1",
  ] as const;
  const session: EpochSession = {
    sessionId: "session_impossible",
    scenarioId: "impossible-collage-v1",
    action: {
      ...GOLDEN_ACTION_INPUT,
      actionId: "action_impossible",
      sessionId: "session_impossible",
      actionHash: GOLDEN_ACTION_HASH,
      idempotencyKey: `session_impossible:${GOLDEN_ACTION_HASH}`,
    },
    actionHash: GOLDEN_ACTION_HASH,
    state: "BLOCKED_NO_CUT",
    sessionRevision: 5,
    coordinationMode: "CONCURRENT",
    frozenAssignments: {
      inventoryAgentId: "agent_inventory",
      budgetAgentId: "agent_budget",
      policyAgentId: "agent_policy",
    },
    activeDecisionCertificateIds: {
      inventory: decisionIds[0],
      budget: decisionIds[1],
      policy: decisionIds[2],
    },
    activeAttemptIds: { inventory: null, budget: null, policy: null },
    activeValidationId: "validation_impossible_1",
    activeRefreshPlanId: null,
    activePermitId: null,
    stateUpdatedAt: NOW,
    createdAt: NOW,
  };
  const validation: ValidationRecord = {
    validationId: "validation_impossible_1",
    sessionId: session.sessionId,
    actionHash: session.actionHash,
    baseSessionRevision: 4,
    decisionCertificateIds: [...decisionIds],
    dependencySetHash: sha256Digest("three-active-receipts"),
    validatedHead: 21,
    outcome: "NO_VALID_OBSERVED_WORLD_CUT",
    lowerBound: 21,
    upperBound: 20,
    jointValidityCertificateId: null,
    noCutProofId: "proof_impossible_1",
    refreshPlanId: null,
    verificationLatencyMs: 1,
    createdAt: NOW,
  };
  const plan = buildRefreshPlan({
    refreshPlanId: "refresh_impossible_1",
    session,
    validation,
    evidence: [
      {
        role: "inventory",
        agentId: "agent_inventory",
        from: 18,
        until: null,
      },
      {
        role: "budget",
        agentId: "agent_budget",
        from: 19,
        until: 20,
      },
      {
        role: "policy",
        agentId: "agent_policy",
        from: 21,
        until: null,
      },
    ],
  });
  session.activeRefreshPlanId = plan.refreshPlanId;
  validation.refreshPlanId = plan.refreshPlanId;
  const database = emptyDatabase();
  database.sessions.push(session);
  database.validations.push(validation);
  database.refreshPlans.push(plan);
  return { database, session, validation, plan };
}

function createArtifacts(
  context: RefreshClaimArtifactContext,
): { assignment: RunAssignment; attempt: AgentAttempt } {
  const assignmentId = `assignment_${context.role}_refresh_1`;
  const attemptId = `attempt_${context.role}_refresh_1`;
  return {
    assignment: {
      assignmentId,
      sessionId: context.session.sessionId,
      actionHash: context.session.actionHash,
      agentId: context.agentId,
      agentNameAtAssignment: "Budget Agent",
      role: context.role,
      receiptId: `receipt_${context.role}_refresh_1`,
      queryHash: buildRoleQuerySpec(context.session.action, context.role).queryHash,
      roleProfileVersion: `${context.role}-v1`,
      promptTemplateVersion: "epoch-prompt-v1",
      agentsMdDigest: DIGEST,
      runtimeLabelAtDispatch: "ControlledRunner",
      evidencePackRelativePath: `.epochguard/sessions/${context.session.sessionId}/${context.role}/${assignmentId}.json`,
      evidencePackHash: DIGEST,
      boundRunId: null,
      status: "CREATED",
      consumedByDecisionCertificateId: null,
      createdAt: NOW,
      boundAt: null,
      consumedAt: null,
    },
    attempt: {
      attemptId,
      sessionId: context.session.sessionId,
      actionHash: context.session.actionHash,
      role: context.role,
      agentId: context.agentId,
      assignmentId,
      runId: null,
      status: "ASSIGNMENT_CREATED",
      runStartedAt: null,
      runCompletedAt: null,
      threadId: null,
      usage: null,
      outputDigest: null,
    },
  };
}

describe("Refresh Planner", () => {
  it("computes the minimal failure-fixture set and freezes every CAS binding", () => {
    const fixture = blockedFixture();
    expect(
      refreshSet(21, [
        {
          role: "inventory",
          agentId: "agent_inventory",
          from: 18,
          until: null,
        },
        {
          role: "budget",
          agentId: "agent_budget",
          from: 19,
          until: 20,
        },
        {
          role: "policy",
          agentId: "agent_policy",
          from: 21,
          until: null,
        },
      ]),
    ).toEqual(["agent_budget"]);
    expect(fixture.plan).toMatchObject({
      baseSessionRevision: 5,
      validatedHead: 21,
      dependencySetHash: fixture.validation.dependencySetHash,
      activeDecisionCertificateIds: fixture.validation.decisionCertificateIds,
      agentIds: ["agent_budget"],
      status: "AVAILABLE",
      claimedAttemptId: null,
    });
  });

  it("fails closed instead of inventing non-Budget or multi-owner P0 semantics", () => {
    const fixture = blockedFixture();
    const session = structuredClone(fixture.session);
    const validation = structuredClone(fixture.validation);
    session.activeRefreshPlanId = null;
    validation.refreshPlanId = null;

    expect(() =>
      buildRefreshPlan({
        refreshPlanId: "refresh_multi_owner",
        session,
        validation,
        evidence: [
          {
            role: "inventory",
            agentId: "agent_inventory",
            from: 18,
            until: null,
          },
          {
            role: "budget",
            agentId: "agent_budget",
            from: 19,
            until: 20,
          },
          {
            role: "policy",
            agentId: "agent_policy",
            from: 22,
            until: null,
          },
        ],
      }),
    ).toThrow(/P0 supports exactly one Budget refresh owner.*contract upgrade/);

    expect(() =>
      buildRefreshPlan({
        refreshPlanId: "refresh_inventory_only",
        session,
        validation,
        evidence: [
          {
            role: "inventory",
            agentId: "agent_inventory",
            from: 18,
            until: 20,
          },
          {
            role: "budget",
            agentId: "agent_budget",
            from: 19,
            until: null,
          },
          {
            role: "policy",
            agentId: "agent_policy",
            from: 21,
            until: null,
          },
        ],
      }),
    ).toThrow(/P0 supports exactly one Budget refresh owner.*contract upgrade/);
  });

  it("refuses a persisted non-Budget Plan without creating dispatch artifacts", async () => {
    const fixture = blockedFixture();
    fixture.database.refreshPlans[0]!.agentIds = ["agent_inventory"];
    const store = new MemoryRefreshStore(fixture.database);
    const artifactFactory = vi.fn(createArtifacts);

    await expect(
      claimRefreshPlan(store, {
        sessionId: fixture.session.sessionId,
        request: {
          expectedSessionRevision: fixture.session.sessionRevision,
          refreshPlanId: fixture.plan.refreshPlanId,
        },
        now: NOW,
        createArtifacts: artifactFactory,
      }),
    ).rejects.toThrow(/P0 supports exactly one Budget refresh owner/);
    expect(artifactFactory).not.toHaveBeenCalled();
    expect(store.snapshot().runAssignments).toHaveLength(0);
    expect(store.snapshot().attempts).toHaveLength(0);
  });

  it("lets two requests create exactly one Assignment, Attempt, and mock Run", async () => {
    const fixture = blockedFixture();
    const store = new MemoryRefreshStore(fixture.database);
    const artifactFactory = vi.fn(createArtifacts);
    const mockRuns: Array<{ runId: string; attemptId: string }> = [];

    const request = async (): Promise<ClaimRefreshPlanResult> => {
      const result = await claimRefreshPlan(store, {
        sessionId: fixture.session.sessionId,
        request: {
          expectedSessionRevision: fixture.session.sessionRevision,
          refreshPlanId: fixture.plan.refreshPlanId,
        },
        now: NOW,
        createArtifacts: artifactFactory,
      });
      if (result.status === "CLAIMED") {
        mockRuns.push({
          runId: `run_for_${result.attempt.attemptId}`,
          attemptId: result.attempt.attemptId,
        });
      }
      return result;
    };

    const results = await Promise.all([request(), request()]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "ALREADY_REOBSERVING",
      "CLAIMED",
    ]);
    const claimed = results.find((result) => result.status === "CLAIMED");
    const duplicate = results.find(
      (result) => result.status === "ALREADY_REOBSERVING",
    );
    expect(claimed).toMatchObject({
      role: "budget",
      agentId: "agent_budget",
    });
    expect(duplicate).toMatchObject({
      error: {
        error: "ALREADY_REOBSERVING",
        refreshPlanId: fixture.plan.refreshPlanId,
        attemptId: "attempt_budget_refresh_1",
      },
    });
    expect(artifactFactory).toHaveBeenCalledTimes(1);
    expect(mockRuns).toHaveLength(1);

    const database = store.snapshot();
    expect(database.runAssignments).toHaveLength(1);
    expect(database.attempts).toHaveLength(1);
    expect(database.refreshPlans[0]).toMatchObject({
      status: "CLAIMED",
      claimedAttemptId: "attempt_budget_refresh_1",
    });
    expect(database.sessions[0]).toMatchObject({
      state: "REOBSERVING",
      sessionRevision: 6,
      activeAttemptIds: { budget: "attempt_budget_refresh_1" },
    });
  });

  it("fails closed on a second RefreshPlan because P0 allows one round", async () => {
    const fixture = blockedFixture();
    fixture.database.refreshPlans.unshift({
      ...structuredClone(fixture.plan),
      refreshPlanId: "refresh_impossible_old",
      status: "INVALIDATED",
      claimedAttemptId: null,
    });
    const store = new MemoryRefreshStore(fixture.database);
    const artifactFactory = vi.fn(createArtifacts);

    await expect(
      claimRefreshPlan(store, {
        sessionId: fixture.session.sessionId,
        request: {
          expectedSessionRevision: fixture.session.sessionRevision,
          refreshPlanId: fixture.plan.refreshPlanId,
        },
        now: NOW,
        createArtifacts: artifactFactory,
      }),
    ).rejects.toThrow(/only one explicit Budget RefreshPlan per Session/);
    expect(artifactFactory).not.toHaveBeenCalled();
    expect(store.snapshot().runAssignments).toHaveLength(0);
    expect(store.snapshot().attempts).toHaveLength(0);
  });

  it.each([
    {
      name: "World head",
      mutate(database: EpochDatabase) {
        database.headSeq = 22;
      },
    },
    {
      name: "base Session revision",
      mutate(database: EpochDatabase) {
        database.sessions[0]!.sessionRevision += 1;
      },
    },
    {
      name: "dependency set",
      mutate(database: EpochDatabase) {
        database.validations[0]!.dependencySetHash = sha256Digest("changed-set");
      },
    },
    {
      name: "active Decision pointer",
      mutate(database: EpochDatabase) {
        database.sessions[0]!.activeDecisionCertificateIds.budget =
          "decision_budget_2";
      },
    },
  ])("invalidates a frozen plan when $name changes", async ({ mutate }) => {
    const fixture = blockedFixture();
    mutate(fixture.database);
    const expectedRevision = fixture.database.sessions[0]!.sessionRevision;
    const store = new MemoryRefreshStore(fixture.database);
    const result = await claimRefreshPlan(store, {
      sessionId: fixture.session.sessionId,
      request: {
        expectedSessionRevision: expectedRevision,
        refreshPlanId: fixture.plan.refreshPlanId,
      },
      now: NOW,
      createArtifacts,
    });

    expect(result).toEqual({
      status: "INVALIDATED",
      reasonCode: "UNSTABLE_WORLD",
      refreshPlanId: fixture.plan.refreshPlanId,
      actualSessionRevision: expectedRevision + 1,
    });
    const database = store.snapshot();
    expect(database.refreshPlans[0]?.status).toBe("INVALIDATED");
    expect(database.sessions[0]).toMatchObject({
      state: "UNSTABLE_WORLD",
      activeRefreshPlanId: null,
      sessionRevision: expectedRevision + 1,
    });
    expect(database.runAssignments).toHaveLength(0);
    expect(database.attempts).toHaveLength(0);
  });

  it("returns the frozen STALE_VIEW body without claiming", async () => {
    const fixture = blockedFixture();
    const store = new MemoryRefreshStore(fixture.database);
    const result = await claimRefreshPlan(store, {
      sessionId: fixture.session.sessionId,
      request: {
        expectedSessionRevision: 4,
        refreshPlanId: fixture.plan.refreshPlanId,
      },
      now: NOW,
      createArtifacts,
    });

    expect(result).toMatchObject({
      status: "STALE_VIEW",
      error: {
        error: "STALE_VIEW",
        expectedSessionRevision: 4,
        actualSessionRevision: 5,
      },
    });
    expect(store.snapshot().refreshPlans[0]?.status).toBe("AVAILABLE");
  });
});
