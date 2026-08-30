import { describe, expect, it, vi } from "vitest";
import {
  commitProtectedEffect,
  type EffectGateMutationPort,
  type EffectGatePorts,
} from "./effect-gate.js";
import {
  EpochDatabaseSchema,
  GOLDEN_ACTION_HASH,
  GOLDEN_ACTION_INPUT,
  ROLES,
  buildRoleQuerySpec,
  canonicalJson,
  sha256Digest,
  snapshotReceiptDependencySetHash,
  type EpochDatabase,
  type ObservationReceipt,
  type ResourceVersion,
} from "./types.js";

const NOW = "2026-08-29T12:00:00.000Z";
const LATER = "2026-08-29T12:00:01.000Z";
const DIGEST = sha256Digest("fixture");

class MemoryEffectStore implements EffectGateMutationPort {
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

function readyDatabase(): EpochDatabase {
  const sessionId = "session_normal";
  const action = {
    ...GOLDEN_ACTION_INPUT,
    actionId: "action_normal",
    sessionId,
    actionHash: GOLDEN_ACTION_HASH,
    idempotencyKey: `${sessionId}:${GOLDEN_ACTION_HASH}`,
  } as const;
  const decisionIds = ROLES.map((role) => `decision_${role}_1`) as [
    string,
    string,
    string,
  ];
  const receiptIds = ROLES.map((role) => `receipt_${role}_1`) as [
    string,
    string,
    string,
  ];
  const dependencySetHash = snapshotReceiptDependencySetHash(receiptIds);
  const roleQuerySpecs = ROLES.map((role) => buildRoleQuerySpec(action, role));
  const resourceVersions = roleQuerySpecs.map((spec) => {
    const value =
      spec.role === "inventory"
        ? { availableUnits: 1 }
        : spec.role === "budget"
          ? { remainingBudgetCents: 800_000 }
          : { permitted: true };
    return {
      id: `version_${spec.role}_10`,
      resourceId: `${spec.source}:${spec.entityKey}`,
      sourceRevision: 10,
      value,
      valueHash: sha256Digest(canonicalJson(value)),
      validFromSeq: 10,
      validUntilSeq: null,
    };
  });
  const receipts = roleQuerySpecs.map((spec, index) => ({
    schemaVersion: 1 as const,
    receiptId: receiptIds[index]!,
    sessionId,
    actionHash: GOLDEN_ACTION_HASH,
    agentId: `agent_${spec.role}`,
    runAssignmentId: `assignment_${spec.role}_1`,
    role: spec.role,
    source: spec.source,
    entityKey: spec.entityKey,
    queryHash: spec.queryHash,
    sourceRevision: 10,
    valueHash: resourceVersions[index]!.valueHash,
    observedAtSeq: 10,
    nonce: `nonce-${spec.role}-`.padEnd(40, "x"),
    issuer: "epochguard" as const,
    issuedAt: NOW,
  }));
  const runAssignments = roleQuerySpecs.map((spec, index) => ({
    assignmentId: `assignment_${spec.role}_1`,
    sessionId,
    actionHash: GOLDEN_ACTION_HASH,
    agentId: `agent_${spec.role}`,
    agentNameAtAssignment: `${spec.role} Agent`,
    role: spec.role,
    receiptId: receiptIds[index]!,
    queryHash: spec.queryHash,
    roleProfileVersion: `${spec.role}-v1`,
    promptTemplateVersion: "epoch-prompt-v1",
    agentsMdDigest: DIGEST,
    runtimeLabelAtDispatch: "ControlledRunner",
    evidencePackRelativePath: `.epochguard/sessions/${sessionId}/${spec.role}/assignment_${spec.role}_1.json`,
    evidencePackHash: DIGEST,
    boundRunId: `run_${spec.role}_1`,
    status: "CONSUMED" as const,
    consumedByDecisionCertificateId: decisionIds[index]!,
    createdAt: NOW,
    boundAt: NOW,
    consumedAt: LATER,
  }));
  const attempts = roleQuerySpecs.map((spec) => ({
    attemptId: `attempt_${spec.role}_1`,
    sessionId,
    actionHash: GOLDEN_ACTION_HASH,
    role: spec.role,
    agentId: `agent_${spec.role}`,
    assignmentId: `assignment_${spec.role}_1`,
    runId: `run_${spec.role}_1`,
    status: "ACCEPTED" as const,
    runStartedAt: NOW,
    runCompletedAt: LATER,
    threadId: `thread_${spec.role}_1`,
    usage: null,
    outputDigest: DIGEST,
  }));
  const decisions = roleQuerySpecs.map((spec, index) => ({
    certificateId: decisionIds[index]!,
    sessionId,
    actionHash: GOLDEN_ACTION_HASH,
    agentId: `agent_${spec.role}`,
    runAssignmentId: `assignment_${spec.role}_1`,
    runId: `run_${spec.role}_1`,
    role: spec.role,
    verdict: "ALLOW" as const,
    receiptIds: [receiptIds[index]!] as [string],
    decisionDigest: sha256Digest(`decision-${spec.role}`),
    status: "ACTIVE" as const,
    supersededByCertificateId: null,
    constructedBy: "epochguard" as const,
    createdAt: LATER,
  }));
  const database: EpochDatabase = {
    schemaVersion: 1,
    snapshotRevision: 5,
    headSeq: 10,
    roleAgentRegistrations: ROLES.map((role) => ({
      role,
      agentId: `agent_${role}`,
      agentNameAtRegistration: `${role} Agent`,
      roleProfileVersion: `${role}-v1`,
      agentsMdDigest: DIGEST,
      registeredAt: NOW,
    })),
    worldCommits: [],
    resourceVersions,
    roleQuerySpecs,
    runAssignments,
    receipts,
    sessions: [
      {
        sessionId,
        scenarioId: "normal-world-v1",
        action,
        actionHash: GOLDEN_ACTION_HASH,
        state: "READY_AT_CURRENT_HEAD",
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
        activeValidationId: "validation_normal_1",
        activeRefreshPlanId: null,
        activePermitId: "permit_normal_1",
        stateUpdatedAt: LATER,
        createdAt: NOW,
      },
    ],
    attempts,
    decisions,
    validations: [
      {
        validationId: "validation_normal_1",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        baseSessionRevision: 4,
        decisionCertificateIds: decisionIds,
        dependencySetHash,
        validatedHead: 10,
        outcome: "VALID_CURRENT_ALLOW",
        lowerBound: 10,
        upperBound: 11,
        jointValidityCertificateId: "jvc_normal_1",
        noCutProofId: null,
        refreshPlanId: null,
        verificationLatencyMs: 1,
        createdAt: LATER,
      },
    ],
    jointValidityCertificates: [
      {
        certificateId: "jvc_normal_1",
        validationId: "validation_normal_1",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        dependencySetHash,
        validatedAtHead: 10,
        selectedCutSeq: 10,
        currentHeadCovered: true,
        decisionCertificateIds: decisionIds,
        intervals: receipts.map((receipt) => ({
          receiptId: receipt.receiptId,
          source: receipt.source,
          sourceRevision: receipt.sourceRevision,
          from: 10,
          until: null,
        })),
        validatorVersion: "epochguard-jv-v1",
        createdAt: LATER,
      },
    ],
    noCutProofs: [],
    refreshPlans: [],
    permits: [
      {
        permitId: "permit_normal_1",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        dependencySetHash,
        jointValidityCertificateId: "jvc_normal_1",
        validatedHead: 10,
        idempotencyKey: `${sessionId}:${GOLDEN_ACTION_HASH}`,
        status: "ISSUED",
        issuedAt: LATER,
        consumedAt: null,
      },
    ],
    effects: [],
    diagnostics: [],
    rejectedOutputArtifacts: [],
    auditEvents: [],
  };
  return EpochDatabaseSchema.parse(database);
}

function makePorts(
  store: MemoryEffectStore,
  createEffectId = vi.fn(() => "effect_normal_1"),
): EffectGatePorts & { createEffectId: ReturnType<typeof vi.fn<() => string>> } {
  return {
    store,
    world: {
      resolveResourceVersion(
        database: Readonly<EpochDatabase>,
        receipt: Readonly<ObservationReceipt>,
      ): ResourceVersion | null {
        const version = database.resourceVersions.find(
          (candidate) =>
            candidate.resourceId === `${receipt.source}:${receipt.entityKey}` &&
            candidate.sourceRevision === receipt.sourceRevision,
        );
        if (
          version === undefined ||
          version.valueHash !== sha256Digest(canonicalJson(version.value))
        ) {
          return null;
        }
        return version;
      },
    },
    createEffectId,
    now: () => LATER,
  };
}

async function commit(
  ports: EffectGatePorts,
  expectedSessionRevision = 5,
) {
  return commitProtectedEffect(ports, {
    sessionId: "session_normal",
    request: { expectedSessionRevision },
  });
}

async function committedDatabase(): Promise<EpochDatabase> {
  const store = new MemoryEffectStore(readyDatabase());
  const result = await commit(makePorts(store));
  if (result.status !== "COMMITTED" || !result.created) {
    throw new Error("failed to create committed Effect fixture");
  }
  return store.snapshot();
}

function withCompletedRefreshPlan(database: EpochDatabase): EpochDatabase {
  const session = database.sessions[0]!;
  const validation = database.validations[0]!;
  const inventoryDecisionId = session.activeDecisionCertificateIds.inventory!;
  const currentBudgetDecisionId = session.activeDecisionCertificateIds.budget!;
  const policyDecisionId = session.activeDecisionCertificateIds.policy!;
  const currentBudgetDecision = database.decisions.find(
    (candidate) => candidate.certificateId === currentBudgetDecisionId,
  );
  if (currentBudgetDecision === undefined) {
    throw new Error("missing current Budget Decision");
  }
  const priorBudgetDecision = {
    ...structuredClone(currentBudgetDecision),
    certificateId: "decision_budget_before_refresh",
    receiptIds: ["receipt_budget_before_refresh"] as [string],
    decisionDigest: sha256Digest("decision-budget-before-refresh"),
    status: "SUPERSEDED" as const,
    supersededByCertificateId: currentBudgetDecisionId,
  };
  database.decisions.push(priorBudgetDecision);
  const priorDecisionIds = [
    inventoryDecisionId,
    priorBudgetDecision.certificateId,
    policyDecisionId,
  ] as [string, string, string];
  const priorReceiptIds = priorDecisionIds.map((decisionId) => {
    const decision = database.decisions.find(
      (candidate) => candidate.certificateId === decisionId,
    );
    if (decision === undefined) throw new Error("missing prior Decision");
    return decision.receiptIds[0];
  });
  database.refreshPlans.push({
    refreshPlanId: "refresh_normal_completed",
    sessionId: session.sessionId,
    baseSessionRevision: validation.baseSessionRevision - 1,
    validatedHead: validation.validatedHead,
    dependencySetHash: snapshotReceiptDependencySetHash(priorReceiptIds),
    activeDecisionCertificateIds: priorDecisionIds,
    agentIds: [session.frozenAssignments.budgetAgentId],
    status: "COMPLETED",
    claimedAttemptId: "attempt_budget_1",
  });
  validation.refreshPlanId = "refresh_normal_completed";
  session.activeRefreshPlanId = "refresh_normal_completed";
  return database;
}

function readyDatabaseWithCompletedRefreshPlan(): EpochDatabase {
  return withCompletedRefreshPlan(readyDatabase());
}

async function committedDatabaseWithCompletedRefreshPlan(): Promise<EpochDatabase> {
  const store = new MemoryEffectStore(readyDatabaseWithCompletedRefreshPlan());
  const result = await commit(makePorts(store));
  if (result.status !== "COMMITTED" || !result.created) {
    throw new Error("failed to create completed RefreshPlan Effect fixture");
  }
  return store.snapshot();
}

describe("Effect Gate", () => {
  it("converges concurrent and retried commits on one Effect", async () => {
    const store = new MemoryEffectStore(readyDatabase());
    const ports = makePorts(store);
    const [first, second] = await Promise.all([commit(ports), commit(ports)]);

    expect([first.status, second.status]).toEqual(["COMMITTED", "COMMITTED"]);
    if (first.status !== "COMMITTED" || second.status !== "COMMITTED") {
      throw new Error("expected committed results");
    }
    expect(first.effect.effectId).toBe(second.effect.effectId);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(ports.createEffectId).toHaveBeenCalledTimes(1);

    const database = store.snapshot();
    expect(database.effects).toHaveLength(1);
    expect(database.permits[0]).toMatchObject({
      status: "CONSUMED",
      consumedAt: LATER,
    });
    expect(database.sessions[0]).toMatchObject({
      state: "COMMITTED",
      sessionRevision: 6,
    });

    const lostResponseRetry = await commit(ports, 5);
    expect(lostResponseRetry).toMatchObject({
      status: "COMMITTED",
      created: false,
      effect: { effectId: first.effect.effectId },
      effectsInSession: 1,
    });
    expect(store.snapshot().effects).toHaveLength(1);
  });

  it("records COMMIT_RACE and releases no Effect when head advances", async () => {
    const database = readyDatabase();
    database.headSeq = 11;
    const store = new MemoryEffectStore(database);
    const result = await commit(makePorts(store));

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "COMMIT_RACE",
      effectsInSession: 0,
    });
    const snapshot = store.snapshot();
    expect(snapshot.effects).toHaveLength(0);
    expect(snapshot.permits[0]).toMatchObject({
      status: "REVOKED",
      consumedAt: null,
    });
    expect(snapshot.sessions[0]).toMatchObject({
      state: "COMMIT_RACE",
      activePermitId: null,
      sessionRevision: 6,
    });
  });

  it("rejects authoritative DENY without mutating READY/ISSUED forensic evidence", async () => {
    const database = readyDatabase();
    const budgetReceipt = database.receipts.find(
      (receipt) => receipt.role === "budget",
    )!;
    const budgetVersion = database.resourceVersions.find(
      (version) => version.resourceId === "budget:campaign_42",
    )!;
    const deniedValue = { remainingBudgetCents: 0 } as const;
    const deniedHash = sha256Digest(canonicalJson(deniedValue));
    budgetVersion.value = deniedValue;
    budgetVersion.valueHash = deniedHash;
    budgetReceipt.valueHash = deniedHash;
    const store = new MemoryEffectStore(database);
    const ports = makePorts(store);

    const result = await commit(ports);

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "DECISION_INVALID",
      effectsInSession: 0,
    });
    expect(ports.createEffectId).not.toHaveBeenCalled();
    expect(store.snapshot()).toMatchObject({
      effects: [],
      permits: [expect.objectContaining({ status: "ISSUED" })],
      sessions: [expect.objectContaining({ state: "READY_AT_CURRENT_HEAD" })],
    });
  });

  it("commits recovered ALLOW with its completed RefreshPlan and retains the pointer", async () => {
    const store = new MemoryEffectStore(readyDatabaseWithCompletedRefreshPlan());
    const result = await commit(makePorts(store));

    expect(result).toMatchObject({
      status: "COMMITTED",
      created: true,
      effectsInSession: 1,
    });
    const database = store.snapshot();
    expect(database.effects).toHaveLength(1);
    expect(database.sessions[0]).toMatchObject({
      state: "COMMITTED",
      activeRefreshPlanId: "refresh_normal_completed",
    });
    expect(database.refreshPlans).toEqual([
      expect.objectContaining({
        refreshPlanId: "refresh_normal_completed",
        status: "COMPLETED",
      }),
    ]);
  });

  it.each([
    {
      name: "ghost Plan ID",
      mutate(database: EpochDatabase) {
        database.validations[0]!.refreshPlanId = "refresh_ghost";
      },
    },
    {
      name: "wrong Plan Session",
      mutate(database: EpochDatabase) {
        database.refreshPlans[0]!.sessionId = "session_other";
      },
    },
    {
      name: "missing active Plan pointer",
      mutate(database: EpochDatabase) {
        database.sessions[0]!.activeRefreshPlanId = null;
      },
    },
    {
      name: "unrelated active Plan pointer",
      mutate(database: EpochDatabase) {
        database.sessions[0]!.activeRefreshPlanId = "refresh_unrelated";
      },
    },
    {
      name: "non-completed active Plan",
      mutate(database: EpochDatabase) {
        database.refreshPlans[0]!.status = "INVALIDATED";
      },
    },
    {
      name: "wrong Plan base revision",
      mutate(database: EpochDatabase) {
        database.refreshPlans[0]!.baseSessionRevision =
          database.validations[0]!.baseSessionRevision;
      },
    },
    {
      name: "missing claimed Attempt at completion",
      mutate(database: EpochDatabase) {
        database.refreshPlans[0]!.claimedAttemptId = null;
      },
    },
    {
      name: "wrong claimed Attempt at completion",
      mutate(database: EpochDatabase) {
        database.refreshPlans[0]!.claimedAttemptId = "attempt_inventory_1";
      },
    },
  ])("rejects READY completed RefreshPlan closure: $name", async ({ mutate }) => {
    const database = readyDatabaseWithCompletedRefreshPlan();
    mutate(database);
    const store = new MemoryEffectStore(database);
    const result = await commit(makePorts(store));

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "BINDING_MISMATCH",
      effectsInSession: 0,
    });
    expect(store.snapshot().effects).toHaveLength(0);
    expect(store.snapshot().permits[0]!.status).toBe("ISSUED");
  });

  it.each([
    {
      name: "Action",
      mutate(database: EpochDatabase) {
        database.sessions[0]!.action.estimatedCostCents += 1;
      },
      reasonCode: "ACTION_HASH_MISMATCH",
    },
    {
      name: "Permit",
      mutate(database: EpochDatabase) {
        database.permits[0]!.idempotencyKey = "wrong-scope";
      },
      reasonCode: "BINDING_MISMATCH",
    },
    {
      name: "JVC",
      mutate(database: EpochDatabase) {
        database.jointValidityCertificates[0]!.selectedCutSeq = 9;
      },
      reasonCode: "BINDING_MISMATCH",
    },
    {
      name: "dependency",
      mutate(database: EpochDatabase) {
        database.validations[0]!.dependencySetHash = sha256Digest("wrong-set");
      },
      reasonCode: "BINDING_MISMATCH",
    },
    {
      name: "READY Budget in-flight Attempt",
      mutate(database: EpochDatabase) {
        database.sessions[0]!.activeAttemptIds.budget =
          "attempt_budget_refresh_inflight";
      },
      reasonCode: "BINDING_MISMATCH",
    },
    {
      name: "READY CLAIMED RefreshPlan",
      mutate(database: EpochDatabase) {
        const session = database.sessions[0]!;
        session.activeRefreshPlanId = "refresh_normal_claimed";
        database.refreshPlans.push({
          refreshPlanId: "refresh_normal_claimed",
          sessionId: session.sessionId,
          baseSessionRevision: session.sessionRevision,
          validatedHead: database.headSeq,
          dependencySetHash: database.validations[0]!.dependencySetHash,
          activeDecisionCertificateIds: [
            session.activeDecisionCertificateIds.inventory!,
            session.activeDecisionCertificateIds.budget!,
            session.activeDecisionCertificateIds.policy!,
          ],
          agentIds: [session.frozenAssignments.budgetAgentId],
          status: "CLAIMED",
          claimedAttemptId: "attempt_budget_refresh_inflight",
        });
      },
      reasonCode: "BINDING_MISMATCH",
    },
    {
      name: "initial READY unrelated RefreshPlan pointer",
      mutate(database: EpochDatabase) {
        database.sessions[0]!.activeRefreshPlanId = "refresh_ghost";
      },
      reasonCode: "BINDING_MISMATCH",
    },
  ])("fails closed on $name mismatch", async ({ mutate, reasonCode }) => {
    const database = readyDatabase();
    mutate(database);
    const store = new MemoryEffectStore(database);
    const result = await commit(makePorts(store));

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode,
      effectsInSession: 0,
    });
    expect(store.snapshot().effects).toHaveLength(0);
    expect(store.snapshot().permits[0]?.status).toBe("ISSUED");
  });

  it.each([
    {
      name: "superseded Decision",
      mutate(database: EpochDatabase) {
        database.decisions[0]!.status = "SUPERSEDED";
        database.decisions[0]!.supersededByCertificateId = "decision_inventory_2";
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "Assignment Run",
      mutate(database: EpochDatabase) {
        database.runAssignments[0]!.boundRunId = "run_other";
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "accepted Attempt",
      mutate(database: EpochDatabase) {
        database.attempts[0]!.status = "COMPLETED";
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "accepted Attempt without output digest",
      mutate(database: EpochDatabase) {
        database.attempts[0]!.outputDigest = null;
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "Receipt query",
      mutate(database: EpochDatabase) {
        database.receipts[0]!.queryHash = sha256Digest("wrong-query");
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "persisted query projection",
      mutate(database: EpochDatabase) {
        const query = database.roleQuerySpecs.find(
          (candidate) => candidate.role === "inventory",
        );
        if (query?.role !== "inventory") throw new Error("missing inventory query");
        query.actionProjection.requestedUnits += 1;
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "Run reused across Roles",
      mutate(database: EpochDatabase) {
        const reusedRunId = database.decisions[0]!.runId;
        database.decisions[1]!.runId = reusedRunId;
        database.runAssignments[1]!.boundRunId = reusedRunId;
        database.attempts[1]!.runId = reusedRunId;
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "Attempt ID reused across Roles",
      mutate(database: EpochDatabase) {
        database.attempts[1]!.attemptId = database.attempts[0]!.attemptId;
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "shadow fourth Role Registration",
      mutate(database: EpochDatabase) {
        database.roleAgentRegistrations.push({
          ...structuredClone(database.roleAgentRegistrations[0]!),
          agentId: "agent_inventory_shadow",
        });
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "duplicate Role Registration",
      mutate(database: EpochDatabase) {
        database.roleAgentRegistrations[2]!.role = "inventory";
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "same Agent registered across Roles",
      mutate(database: EpochDatabase) {
        const sharedAgentId = "agent_inventory";
        database.roleAgentRegistrations[1]!.agentId = sharedAgentId;
        database.sessions[0]!.frozenAssignments.budgetAgentId = sharedAgentId;
        database.decisions[1]!.agentId = sharedAgentId;
        database.runAssignments[1]!.agentId = sharedAgentId;
        database.attempts[1]!.agentId = sharedAgentId;
        database.receipts[1]!.agentId = sharedAgentId;
      },
      reasonCode: "DECISION_INVALID",
    },
    {
      name: "source value hash",
      mutate(database: EpochDatabase) {
        database.resourceVersions[0]!.valueHash = sha256Digest("wrong-value");
      },
      reasonCode: "HISTORY_UNVERIFIABLE",
    },
    {
      name: "verified Resource value/hash mismatch",
      mutate(database: EpochDatabase) {
        database.resourceVersions[0]!.value = {
          role: "inventory",
          allow: false,
        };
      },
      reasonCode: "HISTORY_UNVERIFIABLE",
    },
    {
      name: "verified resolver Receipt value-hash mismatch",
      mutate(database: EpochDatabase) {
        const value = { role: "inventory", allow: false } as const;
        database.resourceVersions[0]!.value = value;
        database.resourceVersions[0]!.valueHash = sha256Digest(
          canonicalJson(value),
        );
      },
      reasonCode: "HISTORY_UNVERIFIABLE",
    },
    {
      name: "non-canonical matching Receipt/Resource hash",
      mutate(database: EpochDatabase) {
        const nonCanonicalHash = sha256Digest("not-the-canonical-value");
        database.resourceVersions[0]!.valueHash = nonCanonicalHash;
        database.receipts[0]!.valueHash = nonCanonicalHash;
      },
      reasonCode: "HISTORY_UNVERIFIABLE",
    },
  ])("revalidates $name before release", async ({ mutate, reasonCode }) => {
    const database = readyDatabase();
    mutate(database);
    const store = new MemoryEffectStore(database);
    const result = await commit(makePorts(store));

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode,
      effectsInSession: 0,
    });
    expect(store.snapshot().effects).toHaveLength(0);
  });

  it.each([
    {
      name: "Effect dependencySetHash",
      mutate(database: EpochDatabase) {
        database.effects[0]!.dependencySetHash = sha256Digest(
          "wrong-effect-dependency",
        );
      },
    },
    {
      name: "Effect permitId",
      mutate(database: EpochDatabase) {
        database.effects[0]!.permitId = "permit_other";
      },
    },
    {
      name: "Effect JVC ID",
      mutate(database: EpochDatabase) {
        database.effects[0]!.jointValidityCertificateId = "jvc_other";
      },
    },
    {
      name: "Permit status",
      mutate(database: EpochDatabase) {
        database.permits[0]!.status = "REVOKED";
      },
    },
    {
      name: "Permit dependencySetHash",
      mutate(database: EpochDatabase) {
        database.permits[0]!.dependencySetHash = sha256Digest(
          "wrong-permit-dependency",
        );
      },
    },
    {
      name: "Session state",
      mutate(database: EpochDatabase) {
        database.sessions[0]!.state = "READY_AT_CURRENT_HEAD";
      },
    },
    {
      name: "committed head rollback before Permit head",
      mutate(database: EpochDatabase) {
        database.headSeq = database.permits[0]!.validatedHead - 1;
      },
    },
  ])("rejects a tampered committed closure: $name", async ({ mutate }) => {
    const database = await committedDatabase();
    mutate(database);
    const store = new MemoryEffectStore(database);
    const ports = makePorts(store);
    const result = await commit(ports, 5);

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "BINDING_MISMATCH",
      effectsInSession: 1,
    });
    expect(ports.createEffectId).not.toHaveBeenCalled();
    expect(store.snapshot().effects).toHaveLength(1);
  });

  it.each([
    {
      name: "accepted Attempt without output digest",
      mutate(database: EpochDatabase) {
        database.attempts[0]!.outputDigest = null;
      },
    },
    {
      name: "unregistered Assignment profile version",
      mutate(database: EpochDatabase) {
        database.runAssignments[0]!.roleProfileVersion =
          "inventory-unregistered-v2";
      },
    },
    {
      name: "unregistered Assignment profile digest",
      mutate(database: EpochDatabase) {
        database.runAssignments[0]!.agentsMdDigest = sha256Digest(
          "inventory-unregistered-profile",
        );
      },
    },
    {
      name: "consistently rebound but unregistered Agent",
      mutate(database: EpochDatabase) {
        const agentId = "agent_inventory_unregistered";
        database.sessions[0]!.frozenAssignments.inventoryAgentId = agentId;
        database.decisions[0]!.agentId = agentId;
        database.runAssignments[0]!.agentId = agentId;
        database.attempts[0]!.agentId = agentId;
        database.receipts[0]!.agentId = agentId;
      },
    },
  ])("rejects a tampered committed provenance: $name", async ({ mutate }) => {
    const database = await committedDatabase();
    mutate(database);
    const store = new MemoryEffectStore(database);
    const ports = makePorts(store);
    const result = await commit(ports, 5);

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "DECISION_INVALID",
      effectsInSession: 1,
    });
    expect(ports.createEffectId).not.toHaveBeenCalled();
    expect(store.snapshot().effects).toHaveLength(1);
  });

  it("rejects an existing Effect when the resolved Resource value/hash diverges", async () => {
    const database = await committedDatabase();
    const value = {
      role: "inventory",
      allow: false,
    } as const;
    database.resourceVersions[0]!.value = value;
    database.resourceVersions[0]!.valueHash = sha256Digest(
      canonicalJson(value),
    );
    const store = new MemoryEffectStore(database);
    const ports = makePorts(store);
    const result = await commit(ports, 5);

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "HISTORY_UNVERIFIABLE",
      effectsInSession: 1,
    });
    expect(ports.createEffectId).not.toHaveBeenCalled();
    expect(store.snapshot().effects).toHaveLength(1);
  });

  it("recomputes the authoritative verdict before returning an existing Effect", async () => {
    const database = await committedDatabase();
    const budgetReceipt = database.receipts.find(
      (receipt) => receipt.role === "budget",
    )!;
    const budgetVersion = database.resourceVersions.find(
      (version) => version.resourceId === "budget:campaign_42",
    )!;
    const deniedValue = { remainingBudgetCents: 0 } as const;
    const deniedHash = sha256Digest(canonicalJson(deniedValue));
    budgetVersion.value = deniedValue;
    budgetVersion.valueHash = deniedHash;
    budgetReceipt.valueHash = deniedHash;
    const store = new MemoryEffectStore(database);
    const ports = makePorts(store);

    const result = await commit(ports, 5);

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "DECISION_INVALID",
      effectsInSession: 1,
    });
    expect(ports.createEffectId).not.toHaveBeenCalled();
    expect(store.snapshot()).toMatchObject({
      effects: [expect.objectContaining({ effectId: database.effects[0]!.effectId })],
      permits: [expect.objectContaining({ status: "CONSUMED" })],
      sessions: [expect.objectContaining({ state: "COMMITTED" })],
    });
  });

  it("returns the same Effect for a healthy completed Budget RefreshPlan", async () => {
    const database = await committedDatabaseWithCompletedRefreshPlan();
    const effectId = database.effects[0]!.effectId;
    const store = new MemoryEffectStore(database);
    const ports = makePorts(store);
    const result = await commit(ports, 5);

    expect(result).toMatchObject({
      status: "COMMITTED",
      created: false,
      effect: { effectId },
      effectsInSession: 1,
    });
    expect(ports.createEffectId).not.toHaveBeenCalled();
    expect(store.snapshot().sessions[0]!.activeRefreshPlanId).toBe(
      "refresh_normal_completed",
    );
  });

  it.each([
    {
      name: "ghost Plan ID",
      mutate(database: EpochDatabase) {
        database.validations[0]!.refreshPlanId = "refresh_ghost";
      },
    },
    {
      name: "wrong Plan Session",
      mutate(database: EpochDatabase) {
        database.refreshPlans[0]!.sessionId = "session_other";
      },
    },
    {
      name: "wrong Plan base revision",
      mutate(database: EpochDatabase) {
        database.refreshPlans[0]!.baseSessionRevision =
          database.validations[0]!.baseSessionRevision;
      },
    },
  ])("rejects an unclosed completed RefreshPlan: $name", async ({ mutate }) => {
    const database = await committedDatabaseWithCompletedRefreshPlan();
    mutate(database);
    const store = new MemoryEffectStore(database);
    const ports = makePorts(store);
    const result = await commit(ports, 5);

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "BINDING_MISMATCH",
      effectsInSession: 1,
    });
    expect(ports.createEffectId).not.toHaveBeenCalled();
    expect(store.snapshot().effects).toHaveLength(1);
  });

  it("returns the same healthy Effect before stale revision despite later head", async () => {
    const database = await committedDatabase();
    const effectId = database.effects[0]!.effectId;
    database.headSeq += 1;
    database.resourceVersions[0]!.validUntilSeq = database.headSeq;
    const store = new MemoryEffectStore(database);
    const ports = makePorts(store);
    const result = await commit(ports, 5);

    expect(result).toMatchObject({
      status: "COMMITTED",
      created: false,
      effect: { effectId },
      effectsInSession: 1,
    });
    expect(ports.createEffectId).not.toHaveBeenCalled();
    expect(store.snapshot().effects).toHaveLength(1);
  });

  it("returns the exact STALE_VIEW body without consuming the Permit", async () => {
    const store = new MemoryEffectStore(readyDatabase());
    const result = await commit(makePorts(store), 4);
    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "STALE_VIEW",
      error: {
        error: "STALE_VIEW",
        expectedSessionRevision: 4,
        actualSessionRevision: 5,
      },
    });
    expect(store.snapshot().permits[0]?.status).toBe("ISSUED");
    expect(store.snapshot().effects).toHaveLength(0);
  });
});
