import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as webContracts from "../../../web/src/epochguard/contracts.js";
import {
  AGENTS_BUSY_MESSAGE,
  ALREADY_REOBSERVING_MESSAGE,
  API_ERROR_STATUS,
  AgentDecisionEnvelopeSchema,
  AUTHORITATIVE_SNAPSHOT_PROJECTION_RULES,
  ARTIFACT_REF_KINDS,
  ARTIFACT_REF_TARGETS,
  ActionIntentSchema,
  AgentAttemptSchema,
  ApiErrorBodySchema,
  ArtifactRefSchema,
  CommitSessionRequestSchema,
  CONTRACT_DIGEST,
  CONTRACT_DIGEST_ALGORITHM,
  CONTRACT_DIGEST_PLACEHOLDER,
  CONTRACT_MANIFEST,
  CONTRACT_SCHEMA_REGISTRY,
  CONTRACT_SEMANTIC_INVARIANTS,
  CONTRACT_VERSION,
  CreateSessionRequestSchema,
  EpochDatabaseSchema,
  FAILURE_CODES,
  GOLDEN_ACTION_CANONICAL,
  GOLDEN_ACTION_HASH,
  GOLDEN_ACTION_INPUT,
  GOLDEN_FIXTURE_MANIFEST,
  GOLDEN_QUERY_HASHES,
  GOLDEN_SNAPSHOT_HASHES,
  IMPOSSIBLE_GOLDEN_SNAPSHOT,
  MISSING_ACTION_FIELDS_MESSAGE,
  NORMAL_READY_GOLDEN_SNAPSHOT,
  NORMAL_RELEASED_GOLDEN_SNAPSHOT,
  PROJECTION_MISMATCH_MESSAGE,
  RECOVERED_GOLDEN_SNAPSHOT,
  REFRESH_PLAN_REASON_CODES,
  RejectedOutputArtifactSchema,
  RefreshSessionRequestSchema,
  ROLES,
  SESSION_NOT_FOUND_MESSAGE,
  SHARED_CONTRACT_SCHEMA_NAMES,
  STALE_VIEW_MESSAGE,
  SafetyDiagnosticSchema,
  ScenarioFixtureManifestEntrySchema,
  SessionDashboardSnapshotSchema,
  SNAPSHOT_UNIVERSAL_SAFETY_RULES,
  UNSUPPORTED_SCHEMA_MESSAGE,
  actionHash,
  buildContractDigestDocument,
  buildRoleQuerySpec,
  canonicalJson,
  canonicalizeAction,
  canonicalizeRoleQuery,
  computeContractDigest,
  decodeSessionDashboardSnapshot,
  makeAgentsBusyError,
  makeAlreadyReobservingError,
  makeMissingActionFieldsError,
  makeProjectionMismatchError,
  makeSessionNotFoundError,
  makeStaleViewError,
  makeUnsupportedSchemaError,
  normalizeContractDigestReferences,
  sha256Digest,
} from "./types.js";

function mutableClone<T>(value: T): any {
  return structuredClone(value) as any;
}

function localPropertySchema(schema: any, propertyName: string): any {
  const property = schema.properties[propertyName];
  if (typeof property?.$ref !== "string") return property;
  const definitionName = property.$ref.split("/").at(-1);
  return schema.$defs[definitionName];
}

function expectSnapshotRejected(candidate: unknown): void {
  let serverResult: ReturnType<
    typeof SessionDashboardSnapshotSchema.safeParse
  > | null = null;
  let webResult: ReturnType<
    typeof webContracts.safeDecodeSessionDashboardSnapshot
  > | null = null;
  expect(() => {
    serverResult = SessionDashboardSnapshotSchema.safeParse(candidate);
  }).not.toThrow();
  expect(() => {
    webResult = webContracts.safeDecodeSessionDashboardSnapshot(candidate);
  }).not.toThrow();
  expect(serverResult?.success).toBe(false);
  expect(webResult?.success).toBe(false);
}

function expectSnapshotAccepted(candidate: unknown): void {
  const serverResult = SessionDashboardSnapshotSchema.safeParse(candidate);
  const webResult = webContracts.safeDecodeSessionDashboardSnapshot(candidate);
  expect(serverResult.success).toBe(true);
  expect(webResult.success).toBe(true);
  if (!serverResult.success || !webResult.success) return;
  expect(webResult.data).toEqual(serverResult.data);
  expect(serverResult.data).toEqual(candidate);
}

function makeEqualBoundaryNoCutSnapshot(): any {
  const snapshot = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
  const policyReceipt = snapshot.agents[2].activeDecision.receipt;
  policyReceipt.sourceRevision = 20;
  policyReceipt.observedAtSeq = 20;
  policyReceipt.validFromSeq = 20;
  snapshot.jointValidity.lowerBound = 20;
  snapshot.jointValidity.upperBound = 20;
  snapshot.jointValidity.noCutProof.lowerBound = 20;
  snapshot.jointValidity.noCutProof.upperBound = 20;
  snapshot.jointValidity.noCutProof.witness[1].from = 20;
  return snapshot;
}

function makeHistoricalStaleSnapshot(): any {
  const snapshot = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
  snapshot.sessionState = "HISTORICAL_STALE";
  snapshot.worldHead = 12;
  snapshot.gate = {
    state: "LOCKED",
    reasonCode: "HISTORICAL_BUT_STALE_NOW",
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  };
  snapshot.agents[1].activeDecision.receipt.validUntilSeq = 11;
  snapshot.agents[1].activeDecision.evidenceState = "INVALID_AT_HEAD";
  snapshot.jointValidity = {
    state: "HISTORICAL_STALE",
    lowerBound: 10,
    upperBound: 11,
    currentHeadCovered: false,
    noCutProof: null,
  };
  snapshot.refreshPlan = {
    refreshPlanId: "refresh_historical_1",
    status: "AVAILABLE",
    agentIds: ["agent_budget"],
    reasonCode: "HISTORICAL_BUT_STALE_NOW",
  };
  snapshot.metrics.rerunsAvoided = 2;
  snapshot.availableActions = ["REOBSERVE_INVALID"];
  return snapshot;
}

function makeInitialConsistentDenySnapshot(): any {
  const snapshot = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
  snapshot.sessionState = "CONSISTENT_DENY";
  snapshot.gate = {
    state: "LOCKED",
    reasonCode: "CONSISTENT_DENY",
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  };
  snapshot.agents[1].activeDecision.verdict = "DENY";
  snapshot.metrics.allowDecisions = 2;
  snapshot.metrics.denyDecisions = 1;
  snapshot.availableActions = [];
  return snapshot;
}

function makeRefreshReadySnapshot(): any {
  const snapshot = mutableClone(RECOVERED_GOLDEN_SNAPSHOT);
  snapshot.sessionState = "READY_AT_CURRENT_HEAD";
  snapshot.gate = {
    state: "READY",
    reasonCode: null,
    effectsInSession: 0,
    permitId: "permit_refresh_1",
    effectId: null,
  };
  snapshot.agents[1].activeDecision.verdict = "ALLOW";
  snapshot.metrics.allowDecisions = 3;
  snapshot.metrics.denyDecisions = 0;
  snapshot.availableActions = ["COMMIT"];
  return snapshot;
}

function makeRefreshInProgressSnapshot(): any {
  const snapshot = makeEqualBoundaryNoCutSnapshot();
  snapshot.sessionState = "REOBSERVING";
  snapshot.refreshPlan.status = "CLAIMED";
  snapshot.availableActions = [];
  snapshot.agents[1].runCount = 2;
  snapshot.agents[1].inFlightAttempt = {
    attemptId: "attempt_budget_2",
    assignmentId: "assignment_budget_2",
    runId: "run_budget_2",
    status: "RUNNING",
    runStartedAt: "2026-08-29T12:00:01.000Z",
    runCompletedAt: null,
  };
  snapshot.metrics.reobservedAgents = 1;
  return snapshot;
}

function makeTwoOwnerRefreshInProgressSnapshot(): any {
  const snapshot = makeRefreshInProgressSnapshot();
  snapshot.refreshPlan.agentIds = ["agent_budget", "agent_policy"];
  snapshot.metrics.rerunsAvoided = 1;
  snapshot.agents[2].runCount = 2;
  snapshot.agents[2].activeDecision.evidenceState = "INVALID_AT_HEAD";
  snapshot.agents[2].activeDecision.receipt.validUntilSeq = 21;
  snapshot.jointValidity.noCutProof.witness[1].until = 21;
  snapshot.agents[2].inFlightAttempt = {
    attemptId: "attempt_policy_2",
    assignmentId: "assignment_policy_2",
    runId: "run_policy_2",
    status: "RUNNING",
    runStartedAt: "2026-08-29T12:00:01.000Z",
    runCompletedAt: null,
  };
  snapshot.metrics.reobservedAgents = 2;
  return snapshot;
}

function makeHistoricalRefreshInProgressSnapshot(): any {
  const snapshot = makeHistoricalStaleSnapshot();
  snapshot.sessionState = "REOBSERVING";
  snapshot.refreshPlan.status = "CLAIMED";
  snapshot.availableActions = [];
  snapshot.agents[1].runCount = 2;
  snapshot.agents[1].inFlightAttempt = {
    attemptId: "attempt_budget_historical_2",
    assignmentId: "assignment_budget_historical_2",
    runId: "run_budget_historical_2",
    status: "RUNNING",
    runStartedAt: "2026-08-29T12:00:01.000Z",
    runCompletedAt: null,
  };
  snapshot.metrics.reobservedAgents = 1;
  return snapshot;
}

function makeCanonicalTieNoCutSnapshot(): any {
  const snapshot = makeEqualBoundaryNoCutSnapshot();
  const inventoryReceipt = snapshot.agents[0].activeDecision.receipt;
  const policyReceipt = snapshot.agents[2].activeDecision.receipt;
  inventoryReceipt.sourceRevision = 20;
  inventoryReceipt.observedAtSeq = 20;
  inventoryReceipt.validFromSeq = 20;
  inventoryReceipt.receiptId = "receipt_z_inventory_tie";
  policyReceipt.receiptId = "receipt_a_policy_tie";
  snapshot.jointValidity.noCutProof.dependencySetHash = sha256Digest(
    canonicalJson(
      snapshot.agents
        .map((agent: any) => agent.activeDecision.receipt.receiptId)
        .sort(),
    ),
  );
  snapshot.jointValidity.noCutProof.witness[1] = {
    role: "policy",
    receiptId: policyReceipt.receiptId,
    from: 20,
    until: null,
  };
  return snapshot;
}

function replaceActiveDecisionWithCurrent(
  snapshot: any,
  agentIndex: number,
): void {
  const agent = snapshot.agents[agentIndex];
  const role = agent.role;
  agent.activeDecision.certificateId = `decision_${role}_2`;
  agent.activeDecision.runId = `run_${role}_2`;
  agent.activeDecision.evidenceState = "CURRENT";
  agent.activeDecision.receipt = {
    receiptId: `receipt_${role}_2`,
    sourceRevision: snapshot.worldHead,
    observedAtSeq: snapshot.worldHead,
    validFromSeq: snapshot.worldHead,
    validUntilSeq: null,
  };
  agent.activeDecision.runtimeProof.assignmentId = `assignment_${role}_2`;
  agent.activeDecision.runtimeProof.evidencePackRelativePath =
    `.epochguard/sessions/session_golden/${role}/assignment_${role}_2.json`;
  agent.activeDecision.runtimeProof.runStartedAt =
    "2026-08-29T12:00:01.000Z";
  agent.activeDecision.runtimeProof.runCompletedAt =
    "2026-08-29T12:00:02.000Z";
  agent.inFlightAttempt = null;
  agent.runCount = 2;
}

function makePartialCollectingSnapshot(): any {
  const snapshot = makeTwoOwnerRefreshInProgressSnapshot();
  snapshot.sessionState = "COLLECTING";
  snapshot.gate = {
    state: "WAITING",
    reasonCode: null,
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  };
  replaceActiveDecisionWithCurrent(snapshot, 1);
  snapshot.jointValidity = {
    state: "PENDING",
    lowerBound: null,
    upperBound: null,
    currentHeadCovered: null,
    noCutProof: null,
  };
  snapshot.availableActions = [];
  return snapshot;
}

function makeReversePartialCollectingSnapshot(): any {
  const snapshot = makeTwoOwnerRefreshInProgressSnapshot();
  snapshot.sessionState = "COLLECTING";
  snapshot.gate = {
    state: "WAITING",
    reasonCode: null,
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  };
  replaceActiveDecisionWithCurrent(snapshot, 2);
  snapshot.jointValidity = {
    state: "PENDING",
    lowerBound: null,
    upperBound: null,
    currentHeadCovered: null,
    noCutProof: null,
  };
  snapshot.availableActions = [];
  return snapshot;
}

function makeThreeOwnerRefreshInProgressSnapshot(): any {
  const snapshot = makeTwoOwnerRefreshInProgressSnapshot();
  snapshot.refreshPlan.agentIds = [
    "agent_inventory",
    "agent_budget",
    "agent_policy",
  ];
  snapshot.metrics.rerunsAvoided = 0;
  snapshot.agents[0].runCount = 2;
  snapshot.agents[0].activeDecision.evidenceState = "INVALID_AT_HEAD";
  snapshot.agents[0].activeDecision.receipt.validUntilSeq = snapshot.worldHead;
  snapshot.agents[0].inFlightAttempt = {
    attemptId: "attempt_inventory_2",
    assignmentId: "assignment_inventory_2",
    runId: "run_inventory_2",
    status: "RUNNING",
    runStartedAt: "2026-08-29T12:00:01.000Z",
    runCompletedAt: null,
  };
  snapshot.metrics.reobservedAgents = 3;
  return snapshot;
}

function makeRefreshValidatingSnapshot(): any {
  const snapshot = mutableClone(RECOVERED_GOLDEN_SNAPSHOT);
  snapshot.sessionState = "VALIDATING";
  snapshot.gate = {
    state: "CHECKING",
    reasonCode: null,
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  };
  snapshot.jointValidity = {
    state: "PENDING",
    lowerBound: null,
    upperBound: null,
    currentHeadCovered: null,
    noCutProof: null,
  };
  snapshot.availableActions = [];
  return snapshot;
}

function makeInitialValidatingSnapshot(): any {
  const snapshot = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
  snapshot.sessionState = "VALIDATING";
  snapshot.gate = {
    state: "CHECKING",
    reasonCode: null,
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  };
  snapshot.jointValidity = {
    state: "PENDING",
    lowerBound: null,
    upperBound: null,
    currentHeadCovered: null,
    noCutProof: null,
  };
  snapshot.availableActions = [];
  return snapshot;
}

function makeInitialImpossibleValidatingSnapshot(): any {
  const snapshot = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
  snapshot.sessionState = "VALIDATING";
  snapshot.gate = {
    state: "CHECKING",
    reasonCode: null,
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  };
  snapshot.jointValidity = {
    state: "PENDING",
    lowerBound: null,
    upperBound: null,
    currentHeadCovered: null,
    noCutProof: null,
  };
  snapshot.refreshPlan = null;
  snapshot.metrics.rerunsAvoided = 0;
  snapshot.availableActions = [];
  return snapshot;
}

function makeTerminalClaimedSnapshot(
  sessionState: "FAILED" | "INTERRUPTED" = "FAILED",
  attemptStatus: "FAILED" | "INTERRUPTED" | "OUTPUT_REJECTED" = "FAILED",
): any {
  const snapshot = makeRefreshInProgressSnapshot();
  snapshot.sessionState = sessionState;
  snapshot.gate.reasonCode = "RUN_FAILED";
  snapshot.agents[1].inFlightAttempt.status = attemptStatus;
  snapshot.agents[1].inFlightAttempt.runCompletedAt =
    "2026-08-29T12:00:02.000Z";
  return snapshot;
}

function makePersistedAttempt(status: string): any {
  return {
    attemptId: `attempt_${status.toLowerCase()}`,
    sessionId: "session_attempt_timeline",
    actionHash: GOLDEN_ACTION_HASH,
    role: "budget",
    agentId: "agent_budget",
    assignmentId: `assignment_${status.toLowerCase()}`,
    runId: null,
    status,
    runStartedAt: null,
    runCompletedAt: null,
    threadId: null,
    usage: null,
    outputDigest: null,
  };
}

describe("EpochGuard frozen contract", () => {
  it("freezes v6 over complete JSON Schemas, invariants, fixtures, and Snapshots", () => {
    expect(CONTRACT_VERSION).toBe("epochguard-contract-v6");
    expect(CONTRACT_DIGEST).toBe(
      "sha256:5bdce49d3daa3764bbc67dcafb26c231b328d92b184e59e56d01a90eddc59dbf",
    );
    expect(computeContractDigest()).toBe(CONTRACT_DIGEST);
    expect(computeContractDigest(CONTRACT_MANIFEST)).toBe(CONTRACT_DIGEST);

    const document = buildContractDigestDocument() as any;
    expect(document.algorithm).toEqual(CONTRACT_DIGEST_ALGORITHM);
    expect(
      localPropertySchema(document.schemas.AgentAttempt, "threadId").anyOf,
    ).toEqual(
      expect.arrayContaining([{ type: "null" }]),
    );
    expect(document.schemas.CreateSessionRequest.additionalProperties).toBe(false);
    expect(document.schemas.RejectedOutputArtifact).toBeDefined();
    expect(document.schemas.RefreshPlanReasonCode.enum).toEqual(
      REFRESH_PLAN_REASON_CODES,
    );
    expect(CONTRACT_SEMANTIC_INVARIANTS).toHaveLength(32);
    expect(document.semanticInvariants).toEqual(CONTRACT_SEMANTIC_INVARIANTS);
    expect(document.authoritativeSnapshotProjectionRules).toEqual(
      AUTHORITATIVE_SNAPSHOT_PROJECTION_RULES,
    );
    expect(document.snapshotUniversalSafetyRules).toEqual(
      SNAPSHOT_UNIVERSAL_SAFETY_RULES,
    );
    expect(document.fixtures).toEqual(GOLDEN_FIXTURE_MANIFEST);
    expect(document.goldenSnapshots.normalReady.contractDigest).toBe(
      CONTRACT_DIGEST_PLACEHOLDER,
    );
    expect(Object.keys(document.goldenSnapshotHashes).sort()).toEqual([
      "impossible",
      "normalReady",
      "normalReleased",
      "recovered",
    ]);
  });

  it("changes digest for nested nullability, command DTO, enum/invariant, or fixture mutations", () => {
    const nestedNullability = mutableClone(CONTRACT_MANIFEST);
    localPropertySchema(
      nestedNullability.schemas.AgentAttempt,
      "threadId",
    ).anyOf.pop();
    const commandDto = mutableClone(CONTRACT_MANIFEST);
    commandDto.schemas.CreateSessionRequest.$defs.__schema1.required.pop();
    const enumValue = mutableClone(CONTRACT_MANIFEST);
    enumValue.schemas.FailureCode.enum[0] = "UNFROZEN_CODE";
    const invariant = mutableClone(CONTRACT_MANIFEST);
    invariant.semanticInvariants[0] = "Action hash is not checked";
    const projectionRule = mutableClone(CONTRACT_MANIFEST);
    projectionRule.authoritativeSnapshotProjectionRules.COMMITTED.effect =
      "FORBIDDEN";
    const safetyRule = mutableClone(CONTRACT_MANIFEST);
    safetyRule.snapshotUniversalSafetyRules.receiptTemporal.pop();
    const fixture = mutableClone(CONTRACT_MANIFEST);
    fixture.fixtures[0].expected.initialEffectsInSession = 1;

    for (const tampered of [
      nestedNullability,
      commandDto,
      enumValue,
      invariant,
      projectionRule,
      safetyRule,
      fixture,
    ]) {
      expect(computeContractDigest(tampered)).not.toBe(CONTRACT_DIGEST);
    }
  });

  it("keeps every shared Server/Web JSON Schema structurally identical", () => {
    for (const name of SHARED_CONTRACT_SCHEMA_NAMES) {
      const serverSchema = normalizeContractDigestReferences(
        z.toJSONSchema(CONTRACT_SCHEMA_REGISTRY[name], {
          target: "draft-2020-12",
          reused: "ref",
        }) as never,
      );
      const webSchema = normalizeContractDigestReferences(
        z.toJSONSchema(webContracts.WEB_CONTRACT_SCHEMA_REGISTRY[name], {
          target: "draft-2020-12",
          reused: "ref",
        }) as never,
      );
      expect(webSchema, name).toEqual(serverSchema);
    }
    expect(webContracts.CONTRACT_SEMANTIC_INVARIANTS).toEqual(
      CONTRACT_SEMANTIC_INVARIANTS,
    );
    expect(webContracts.AUTHORITATIVE_SNAPSHOT_PROJECTION_RULES).toEqual(
      AUTHORITATIVE_SNAPSHOT_PROJECTION_RULES,
    );
    expect(webContracts.SNAPSHOT_UNIVERSAL_SAFETY_RULES).toEqual(
      SNAPSHOT_UNIVERSAL_SAFETY_RULES,
    );
  });

  it("matches the Action and Role Query canonical golden vectors", () => {
    expect(canonicalizeAction(GOLDEN_ACTION_INPUT)).toBe(GOLDEN_ACTION_CANONICAL);
    expect(actionHash(GOLDEN_ACTION_INPUT)).toBe(GOLDEN_ACTION_HASH);
    for (const role of ROLES) {
      const spec = buildRoleQuerySpec(GOLDEN_ACTION_INPUT, role);
      expect(spec.queryHash).toBe(GOLDEN_QUERY_HASHES[role]);
      expect(spec.actionHash).toBe(GOLDEN_ACTION_HASH);
      expect(spec.role).toBe(role);
      expect(spec.source).toBe(role);
      expect(sha256Digest(canonicalizeRoleQuery(spec))).toBe(spec.queryHash);
    }
    expect(
      actionHash({ ...GOLDEN_ACTION_INPUT, estimatedCostCents: 500_001 }),
    ).not.toBe(GOLDEN_ACTION_HASH);
    expect(
      buildRoleQuerySpec(
        { ...GOLDEN_ACTION_INPUT, requestedUnits: 2 },
        "inventory",
      ).queryHash,
    ).not.toBe(GOLDEN_QUERY_HASHES.inventory);
  });

  it("returns success=false without throwing for every malformed Snapshot Action", () => {
    const malformedActions = [
      { campaignId: "" },
      { requestedUnits: 0 },
      { requestedUnits: -1 },
      { estimatedCostCents: -1 },
    ];

    for (const mutation of malformedActions) {
      const candidate = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
      Object.assign(candidate.action, mutation);
      let serverResult: ReturnType<
        typeof SessionDashboardSnapshotSchema.safeParse
      > | null = null;
      let webResult: ReturnType<
        typeof webContracts.safeDecodeSessionDashboardSnapshot
      > | null = null;
      expect(() => {
        serverResult = SessionDashboardSnapshotSchema.safeParse(candidate);
      }).not.toThrow();
      expect(() => {
        webResult = webContracts.safeDecodeSessionDashboardSnapshot(candidate);
      }).not.toThrow();
      expect(serverResult?.success, JSON.stringify(mutation)).toBe(false);
      expect(webResult?.success, JSON.stringify(mutation)).toBe(false);
    }
  });

  it("binds persisted and dashboard Attempt status to exact Run timeline evidence", () => {
    const started = "2026-08-29T12:00:01.000Z";
    const completed = "2026-08-29T12:00:02.000Z";
    const persistedPositives = [
      makePersistedAttempt("ASSIGNMENT_CREATED"),
      makePersistedAttempt("DISPATCHING"),
      { ...makePersistedAttempt("QUEUED"), runId: "run_queued" },
      {
        ...makePersistedAttempt("RUNNING"),
        runId: "run_running",
        runStartedAt: started,
      },
      ...["COMPLETED", "OUTPUT_REJECTED", "ACCEPTED"].map((status) => ({
        ...makePersistedAttempt(status),
        runId: `run_${status.toLowerCase()}`,
        runStartedAt: started,
        runCompletedAt: completed,
      })),
      makePersistedAttempt("FAILED"),
      {
        ...makePersistedAttempt("FAILED"),
        runId: "run_failed_queued",
        runCompletedAt: completed,
      },
      {
        ...makePersistedAttempt("FAILED"),
        runId: "run_failed_running",
        runStartedAt: started,
        runCompletedAt: completed,
      },
      makePersistedAttempt("INTERRUPTED"),
      {
        ...makePersistedAttempt("INTERRUPTED"),
        runId: "run_interrupted_restart",
        runCompletedAt: completed,
      },
      {
        ...makePersistedAttempt("INTERRUPTED"),
        runId: "run_interrupted_running",
        runStartedAt: started,
        runCompletedAt: completed,
      },
    ];
    for (const attempt of persistedPositives) {
      expect(AgentAttemptSchema.safeParse(attempt).success, attempt.status).toBe(
        true,
      );
    }

    const persistedNegatives = [
      { ...makePersistedAttempt("ASSIGNMENT_CREATED"), runId: "run_too_early" },
      { ...makePersistedAttempt("DISPATCHING"), runStartedAt: started },
      makePersistedAttempt("QUEUED"),
      {
        ...makePersistedAttempt("QUEUED"),
        runId: "run_queued_completed",
        runCompletedAt: completed,
      },
      { ...makePersistedAttempt("RUNNING"), runId: "run_no_start" },
      {
        ...makePersistedAttempt("RUNNING"),
        runId: "run_running_completed",
        runStartedAt: started,
        runCompletedAt: completed,
      },
      {
        ...makePersistedAttempt("COMPLETED"),
        runId: "run_completed_no_start",
        runCompletedAt: completed,
      },
      {
        ...makePersistedAttempt("OUTPUT_REJECTED"),
        runId: "run_rejected_no_completion",
        runStartedAt: started,
      },
      { ...makePersistedAttempt("FAILED"), runCompletedAt: completed },
      {
        ...makePersistedAttempt("INTERRUPTED"),
        runId: "run_interrupted_without_completion",
        runStartedAt: started,
      },
      {
        ...makePersistedAttempt("ACCEPTED"),
        runId: "run_reversed",
        runStartedAt: completed,
        runCompletedAt: started,
      },
    ];
    for (const attempt of persistedNegatives) {
      expect(AgentAttemptSchema.safeParse(attempt).success, attempt.status).toBe(
        false,
      );
    }

    const activeTimelinePositives = [
      {
        status: "ASSIGNMENT_CREATED",
        runId: null,
        runStartedAt: null,
        runCompletedAt: null,
      },
      {
        status: "DISPATCHING",
        runId: null,
        runStartedAt: null,
        runCompletedAt: null,
      },
      {
        status: "QUEUED",
        runId: "run_budget_2",
        runStartedAt: null,
        runCompletedAt: null,
      },
      {
        status: "RUNNING",
        runId: "run_budget_2",
        runStartedAt: started,
        runCompletedAt: null,
      },
    ];
    for (const timeline of activeTimelinePositives) {
      const snapshot = makeRefreshInProgressSnapshot();
      Object.assign(snapshot.agents[1].inFlightAttempt, timeline);
      expectSnapshotAccepted(snapshot);
    }

    const preBindTerminal = makeTerminalClaimedSnapshot();
    Object.assign(preBindTerminal.agents[1].inFlightAttempt, {
      runId: null,
      runStartedAt: null,
      runCompletedAt: null,
    });
    const queuedCancelInterrupted = makeTerminalClaimedSnapshot(
      "INTERRUPTED",
      "INTERRUPTED",
    );
    Object.assign(queuedCancelInterrupted.agents[1].inFlightAttempt, {
      runId: "run_budget_2",
      runStartedAt: null,
      runCompletedAt: completed,
    });
    const runningTerminal = makeTerminalClaimedSnapshot();
    const rejectedTerminal = makeTerminalClaimedSnapshot(
      "FAILED",
      "OUTPUT_REJECTED",
    );
    for (const snapshot of [
      preBindTerminal,
      queuedCancelInterrupted,
      runningTerminal,
      rejectedTerminal,
    ]) {
      expectSnapshotAccepted(snapshot);
    }

    const dashboardTimelineNegatives = [
      {
        status: "ASSIGNMENT_CREATED",
        runId: "run_budget_2",
        runStartedAt: null,
        runCompletedAt: null,
      },
      {
        status: "QUEUED",
        runId: null,
        runStartedAt: null,
        runCompletedAt: null,
      },
      {
        status: "RUNNING",
        runId: "run_budget_2",
        runStartedAt: null,
        runCompletedAt: null,
      },
      {
        status: "RUNNING",
        runId: "run_budget_2",
        runStartedAt: completed,
        runCompletedAt: started,
      },
    ].map((timeline) => {
      const snapshot = makeRefreshInProgressSnapshot();
      Object.assign(snapshot.agents[1].inFlightAttempt, timeline);
      return snapshot;
    });
    const invalidTerminalTimeline = makeTerminalClaimedSnapshot();
    Object.assign(invalidTerminalTimeline.agents[1].inFlightAttempt, {
      runId: null,
      runStartedAt: null,
      runCompletedAt: completed,
    });
    for (const snapshot of [
      ...dashboardTimelineNegatives,
      invalidTerminalTimeline,
    ]) {
      expectSnapshotRejected(snapshot);
    }
  });

  it("keeps ActionIntent strict and exactly-once scoped to Session + Action", () => {
    const action = {
      ...GOLDEN_ACTION_INPUT,
      actionId: "action_1",
      sessionId: "session_1",
      actionHash: GOLDEN_ACTION_HASH,
      idempotencyKey: `session_1:${GOLDEN_ACTION_HASH}`,
    };
    expect(ActionIntentSchema.parse(action)).toEqual(action);
    expect(
      ActionIntentSchema.safeParse({ ...action, browserSuppliedHead: 21 }).success,
    ).toBe(false);
    expect(
      ActionIntentSchema.safeParse({
        ...action,
        actionHash: `sha256:${"f".repeat(64)}`,
      }).success,
    ).toBe(false);
    expect(
      ActionIntentSchema.safeParse({ ...action, idempotencyKey: "cross-session" })
        .success,
    ).toBe(false);
  });

  it("freezes exact conflict, 422, 404, Schema, and projection error bodies", () => {
    const stale = makeStaleViewError("session_1", 4, 5);
    expect(stale).toEqual({
      error: "STALE_VIEW",
      message: STALE_VIEW_MESSAGE,
      sessionId: "session_1",
      expectedSessionRevision: 4,
      actualSessionRevision: 5,
    });
    const reobserving = makeAlreadyReobservingError(
      "session_1",
      "refresh_1",
      "attempt_1",
    );
    expect(reobserving).toEqual({
      error: "ALREADY_REOBSERVING",
      message: ALREADY_REOBSERVING_MESSAGE,
      sessionId: "session_1",
      refreshPlanId: "refresh_1",
      attemptId: "attempt_1",
    });
    const assignments = {
      inventory: "agent_inventory",
      budget: "agent_budget",
      policy: "agent_policy",
    };
    const busy = makeAgentsBusyError("session_active", assignments);
    expect(busy).toEqual({
      error: "AGENTS_BUSY",
      message: AGENTS_BUSY_MESSAGE,
      activeSessionId: "session_active",
      assignments,
    });
    const missing = makeMissingActionFieldsError([
      "campaignId",
      "estimatedCostCents",
    ]);
    expect(missing).toEqual({
      error: "MISSING_ACTION_FIELDS",
      message: MISSING_ACTION_FIELDS_MESSAGE,
      missingFields: ["campaignId", "estimatedCostCents"],
    });
    const notFound = makeSessionNotFoundError("session_missing");
    expect(notFound).toEqual({
      error: "SESSION_NOT_FOUND",
      message: SESSION_NOT_FOUND_MESSAGE,
      sessionId: "session_missing",
    });
    const unsupported = makeUnsupportedSchemaError(2, "epochguard-contract-v1");
    expect(unsupported).toEqual({
      error: "UNSUPPORTED_SCHEMA",
      message: UNSUPPORTED_SCHEMA_MESSAGE,
      expectedSchemaVersion: 1,
      expectedContractVersion: CONTRACT_VERSION,
      receivedSchemaVersion: 2,
      receivedContractVersion: "epochguard-contract-v1",
    });
    const projection = makeProjectionMismatchError("session_1", 8);
    expect(projection).toEqual({
      error: "PROJECTION_MISMATCH",
      message: PROJECTION_MISMATCH_MESSAGE,
      sessionId: "session_1",
      snapshotRevision: 8,
    });
    expect(API_ERROR_STATUS).toEqual({
      STALE_VIEW: 409,
      ALREADY_REOBSERVING: 409,
      AGENTS_BUSY: 409,
      MISSING_ACTION_FIELDS: 422,
      SESSION_NOT_FOUND: 404,
      UNSUPPORTED_SCHEMA: 422,
      PROJECTION_MISMATCH: 500,
    });
    for (const body of [
      stale,
      reobserving,
      busy,
      missing,
      notFound,
      unsupported,
      projection,
    ]) {
      expect(ApiErrorBodySchema.parse(body)).toEqual(body);
      expect(webContracts.ApiErrorBodySchema.parse(body)).toEqual(body);
    }
  });

  it("keeps command DTOs narrow and rejects browser trusted fields", () => {
    const assignments = {
      inventory: "agent_inventory",
      budget: "agent_budget",
      policy: "agent_policy",
    };
    expect(
      CreateSessionRequestSchema.parse({
        scenarioId: "normal-world-v1",
        assignments,
      }),
    ).toEqual({ scenarioId: "normal-world-v1", assignments });
    expect(
      CreateSessionRequestSchema.safeParse({
        scenarioId: "normal-world-v1",
        assignments: { ...assignments, policy: "agent_budget" },
      }).success,
    ).toBe(false);
    expect(
      RefreshSessionRequestSchema.safeParse({
        expectedSessionRevision: 2,
        refreshPlanId: "refresh_1",
        agentId: "agent_budget",
      }).success,
    ).toBe(false);
    expect(
      CommitSessionRequestSchema.safeParse({
        expectedSessionRevision: 3,
        head: 21,
        permitId: "permit_1",
      }).success,
    ).toBe(false);
  });

  it("encodes all valid and invalid 16 KiB rejected-output combinations", () => {
    const base = {
      artifactId: "artifact_1",
      sessionId: "session_1",
      attemptId: "attempt_1",
      originalDigest: `sha256:${"1".repeat(64)}`,
      redactionVersion: "epoch-redact-v1",
      createdAt: "2026-08-29T12:00:00.000Z",
    } as const;
    const sanitizedContent = "redacted output";
    const parseRejected = {
      ...base,
      reason: "PARSE_REJECTED",
      originalByteLength: 16 * 1_024,
      sanitizedContent,
      sanitizedContentDigest: sha256Digest(sanitizedContent),
      truncated: false,
    } as const;
    const tooLarge = {
      ...base,
      reason: "OUTPUT_TOO_LARGE",
      originalByteLength: 16 * 1_024 + 1,
      sanitizedContent: null,
      sanitizedContentDigest: null,
      truncated: true,
    } as const;
    expect(RejectedOutputArtifactSchema.parse(parseRejected)).toEqual(parseRejected);
    expect(RejectedOutputArtifactSchema.parse(tooLarge)).toEqual(tooLarge);
    const emptyOutput = {
      ...parseRejected,
      originalByteLength: 0,
      sanitizedContent: "",
      sanitizedContentDigest: sha256Digest(""),
    } as const;
    const fullyRedactedOutput = {
      ...emptyOutput,
      originalByteLength: 128,
    } as const;
    expect(RejectedOutputArtifactSchema.parse(emptyOutput)).toEqual(emptyOutput);
    expect(RejectedOutputArtifactSchema.parse(fullyRedactedOutput)).toEqual(
      fullyRedactedOutput,
    );

    for (const artifact of [
      { ...parseRejected, originalByteLength: 16 * 1_024 + 1 },
      { ...parseRejected, sanitizedContent: null },
      { ...parseRejected, sanitizedContentDigest: null },
      { ...parseRejected, sanitizedContentDigest: `sha256:${"f".repeat(64)}` },
      { ...parseRejected, truncated: true },
      { ...tooLarge, originalByteLength: 16 * 1_024 },
      { ...tooLarge, sanitizedContent: "partial" },
      { ...tooLarge, sanitizedContentDigest: sha256Digest("partial") },
      { ...tooLarge, truncated: false },
    ]) {
      expect(RejectedOutputArtifactSchema.safeParse(artifact).success).toBe(false);
    }
  });

  it("closes FailureCode and ArtifactRef identity domains on both sides", () => {
    expect(new Set(FAILURE_CODES).size).toBe(FAILURE_CODES.length);
    expect(new Set(ARTIFACT_REF_KINDS).size).toBe(ARTIFACT_REF_KINDS.length);
    expect(Object.keys(ARTIFACT_REF_TARGETS).sort()).toEqual(
      [...ARTIFACT_REF_KINDS].sort(),
    );
    for (const kind of ARTIFACT_REF_KINDS) {
      const id = kind === "ENVELOPE_DIGEST" ? GOLDEN_ACTION_HASH : "artifact_1";
      expect(ArtifactRefSchema.parse({ kind, id })).toEqual({ kind, id });
      expect(webContracts.ArtifactRefSchema.parse({ kind, id })).toEqual({
        kind,
        id,
      });
    }
    for (const ref of [
      { kind: "ENVELOPE_DIGEST", id: "artifact_1" },
      { kind: "RUN", id: "C:\\secret\\run.json" },
      { kind: "RUN", id: "/tmp/run.json" },
      { kind: "RUN", id: "arbitrary text" },
      { kind: "ABSOLUTE_PATH", id: "artifact_1" },
    ]) {
      expect(ArtifactRefSchema.safeParse(ref).success).toBe(false);
      expect(webContracts.ArtifactRefSchema.safeParse(ref).success).toBe(false);
    }

    const diagnostic = {
      diagnosticId: "diagnostic_1",
      sessionId: "session_1",
      actionHash: GOLDEN_ACTION_HASH,
      sessionRevision: 1,
      fixtureRef: "fixture_normal_world_v1",
      kind: "SYSTEM_FAILURE",
      stage: "RUN",
      reasonCode: "RUN_FAILED",
      role: "budget",
      attemptId: "attempt_1",
      assignmentId: "assignment_1",
      runId: "run_1",
      artifactRefs: [{ kind: "RUN", id: "run_1" }],
      causedByDiagnosticIds: [],
      expected: { status: "completed" },
      actual: { status: "failed" },
      rejectedOutputArtifactId: null,
      auditSeq: 1,
      recommendedAction: "NEW_SESSION",
    };
    expect(SafetyDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
    expect(
      SafetyDiagnosticSchema.safeParse({ ...diagnostic, stage: "UNKNOWN" }).success,
    ).toBe(false);

    const envelope = {
      schemaVersion: 1,
      sessionId: "session_1",
      actionHash: GOLDEN_ACTION_HASH,
      runAssignmentId: "assignment_1",
      role: "budget",
      receiptId: "receipt_1",
      nonce: "n".repeat(32),
      verdict: "ALLOW",
      reason: "The fixed budget covers the requested spend.",
    };
    expect(AgentDecisionEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      AgentDecisionEnvelopeSchema.safeParse({ ...envelope, runId: "untrusted" })
        .success,
    ).toBe(false);
  });

  it("parses READY/RELEASED Normal and Impossible/Recovered goldens", () => {
    for (const fixture of GOLDEN_FIXTURE_MANIFEST) {
      expect(ScenarioFixtureManifestEntrySchema.safeParse(fixture).success).toBe(
        true,
      );
    }
    const snapshots = {
      normalReady: NORMAL_READY_GOLDEN_SNAPSHOT,
      normalReleased: NORMAL_RELEASED_GOLDEN_SNAPSHOT,
      impossible: IMPOSSIBLE_GOLDEN_SNAPSHOT,
      recovered: RECOVERED_GOLDEN_SNAPSHOT,
    } as const;
    const manifestHashes = (CONTRACT_MANIFEST as any).goldenSnapshotHashes;
    const rebuiltHashes = (buildContractDigestDocument() as any)
      .goldenSnapshotHashes;
    for (const [name, snapshot] of Object.entries(snapshots)) {
      expect(SessionDashboardSnapshotSchema.parse(snapshot), name).toEqual(snapshot);
      expect(webContracts.decodeSessionDashboardSnapshot(snapshot), name).toEqual(
        snapshot,
      );
      const normalizedSnapshot = normalizeContractDigestReferences(snapshot);
      const independentlyComputedHash = sha256Digest(
        canonicalJson(normalizedSnapshot),
      );
      const frozenHash =
        GOLDEN_SNAPSHOT_HASHES[name as keyof typeof GOLDEN_SNAPSHOT_HASHES];
      expect(frozenHash, name).toBe(independentlyComputedHash);
      expect(manifestHashes[name], name).toBe(frozenHash);
      expect(rebuiltHashes[name], name).toBe(frozenHash);
    }
    expect(decodeSessionDashboardSnapshot(NORMAL_READY_GOLDEN_SNAPSHOT)).toEqual(
      NORMAL_READY_GOLDEN_SNAPSHOT,
    );
  });

  it("accepts the frozen five-state positive projections and L==U No-Cut", () => {
    const equalBoundaryNoCut = makeEqualBoundaryNoCutSnapshot();
    const historical = makeHistoricalStaleSnapshot();
    const initialDeny = makeInitialConsistentDenySnapshot();

    for (const snapshot of [
      equalBoundaryNoCut,
      historical,
      initialDeny,
      NORMAL_READY_GOLDEN_SNAPSHOT,
      NORMAL_RELEASED_GOLDEN_SNAPSHOT,
    ]) {
      expectSnapshotAccepted(snapshot);
    }
    expect(equalBoundaryNoCut.jointValidity).toMatchObject({
      state: "NO_CUT",
      lowerBound: 20,
      upperBound: 20,
    });
    expect(initialDeny.refreshPlan).toBeNull();
    expect(historical.refreshPlan).toMatchObject({
      status: "AVAILABLE",
      agentIds: ["agent_budget"],
    });
  });

  it("rejects impossible Receipt observation times and invalid half-open intervals", () => {
    const observedAfterHead = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    observedAfterHead.agents[0].activeDecision.receipt.sourceRevision = 11;
    observedAfterHead.agents[0].activeDecision.receipt.observedAtSeq = 11;

    const observedBeforeValidity = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    observedBeforeValidity.agents[0].activeDecision.receipt.sourceRevision = 9;
    observedBeforeValidity.agents[0].activeDecision.receipt.observedAtSeq = 9;

    const emptyReceiptInterval = makeEqualBoundaryNoCutSnapshot();
    const emptyReceipt = emptyReceiptInterval.agents[1].activeDecision.receipt;
    emptyReceipt.sourceRevision = 20;
    emptyReceipt.observedAtSeq = 20;
    emptyReceipt.validFromSeq = 20;
    emptyReceipt.validUntilSeq = 20;
    emptyReceiptInterval.jointValidity.noCutProof.witness[0].from = 20;

    const reversedReceiptInterval = mutableClone(emptyReceiptInterval);
    reversedReceiptInterval.agents[1].activeDecision.receipt.validUntilSeq = 19;
    reversedReceiptInterval.jointValidity.upperBound = 19;
    reversedReceiptInterval.jointValidity.noCutProof.upperBound = 19;
    reversedReceiptInterval.jointValidity.noCutProof.witness[0].until = 19;

    const futureClosedReceipt = makeInitialImpossibleValidatingSnapshot();
    futureClosedReceipt.agents[1].activeDecision.receipt.validUntilSeq =
      futureClosedReceipt.worldHead + 1;
    futureClosedReceipt.agents[1].activeDecision.evidenceState = "CURRENT";

    for (const candidate of [
      observedAfterHead,
      observedBeforeValidity,
      emptyReceiptInterval,
      reversedReceiptInterval,
      futureClosedReceipt,
    ]) {
      expectSnapshotRejected(candidate);
    }
    expectSnapshotAccepted(makeEqualBoundaryNoCutSnapshot());

    const finiteExactlyAtHead = makeInitialImpossibleValidatingSnapshot();
    finiteExactlyAtHead.agents[1].activeDecision.receipt.validUntilSeq =
      finiteExactlyAtHead.worldHead;
    expectSnapshotAccepted(finiteExactlyAtHead);
    expectSnapshotAccepted(makeInitialValidatingSnapshot());
  });

  it("rejects reused Decision and in-flight IDs within each identity namespace", () => {
    const duplicateCertificate = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    duplicateCertificate.agents[1].activeDecision.certificateId =
      duplicateCertificate.agents[0].activeDecision.certificateId;
    const duplicateActiveRun = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    duplicateActiveRun.agents[1].activeDecision.runId =
      duplicateActiveRun.agents[0].activeDecision.runId;
    const duplicateReceipt = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    duplicateReceipt.agents[1].activeDecision.receipt.receiptId =
      duplicateReceipt.agents[0].activeDecision.receipt.receiptId;
    const duplicateActiveAssignment = mutableClone(
      NORMAL_READY_GOLDEN_SNAPSHOT,
    );
    duplicateActiveAssignment.agents[1].activeDecision.runtimeProof.assignmentId =
      duplicateActiveAssignment.agents[0].activeDecision.runtimeProof.assignmentId;

    const twoOwnerRefresh = makeTwoOwnerRefreshInProgressSnapshot();
    expectSnapshotAccepted(twoOwnerRefresh);
    const duplicateAttempt = mutableClone(twoOwnerRefresh);
    duplicateAttempt.agents[2].inFlightAttempt.attemptId =
      duplicateAttempt.agents[1].inFlightAttempt.attemptId;
    const duplicateInFlightAssignment = mutableClone(twoOwnerRefresh);
    duplicateInFlightAssignment.agents[2].inFlightAttempt.assignmentId =
      duplicateInFlightAssignment.agents[1].inFlightAttempt.assignmentId;
    const duplicateInFlightRun = mutableClone(twoOwnerRefresh);
    duplicateInFlightRun.agents[2].inFlightAttempt.runId =
      duplicateInFlightRun.agents[1].inFlightAttempt.runId;
    const assignmentReusedFromAnotherActiveAgent = mutableClone(twoOwnerRefresh);
    assignmentReusedFromAnotherActiveAgent.agents[2].inFlightAttempt.assignmentId =
      assignmentReusedFromAnotherActiveAgent.agents[0].activeDecision.runtimeProof.assignmentId;
    const runReusedFromAnotherActiveAgent = mutableClone(twoOwnerRefresh);
    runReusedFromAnotherActiveAgent.agents[2].inFlightAttempt.runId =
      runReusedFromAnotherActiveAgent.agents[0].activeDecision.runId;

    for (const candidate of [
      duplicateCertificate,
      duplicateActiveRun,
      duplicateReceipt,
      duplicateActiveAssignment,
      duplicateAttempt,
      duplicateInFlightAssignment,
      duplicateInFlightRun,
      assignmentReusedFromAnotherActiveAgent,
      runReusedFromAnotherActiveAgent,
    ]) {
      expectSnapshotRejected(candidate);
    }
  });

  it("binds CLAIMED refresh Plans only to active owner Attempts in refresh states", () => {
    const validRefresh = makeRefreshInProgressSnapshot();
    expectSnapshotAccepted(validRefresh);

    const noInFlightOwner = makeRefreshInProgressSnapshot();
    noInFlightOwner.agents[1].inFlightAttempt = null;
    noInFlightOwner.agents[1].runCount = 1;
    noInFlightOwner.metrics.reobservedAgents = 0;

    const wrongPlanOwner = makeRefreshInProgressSnapshot();
    wrongPlanOwner.refreshPlan.agentIds = ["agent_policy"];

    const nonOwnerInFlight = makeTwoOwnerRefreshInProgressSnapshot();
    nonOwnerInFlight.refreshPlan.agentIds = ["agent_budget"];
    nonOwnerInFlight.metrics.rerunsAvoided = 2;

    const reusedOwnerAssignment = makeRefreshInProgressSnapshot();
    reusedOwnerAssignment.agents[1].inFlightAttempt.assignmentId =
      reusedOwnerAssignment.agents[1].activeDecision.runtimeProof.assignmentId;

    const understatedRunCount = makeRefreshInProgressSnapshot();
    understatedRunCount.agents[1].runCount = 1;
    understatedRunCount.metrics.reobservedAgents = 0;

    const terminalClaimedAttempt = makeRefreshInProgressSnapshot();
    terminalClaimedAttempt.agents[1].inFlightAttempt.status = "COMPLETED";
    terminalClaimedAttempt.agents[1].inFlightAttempt.runCompletedAt =
      "2026-08-29T12:00:02.000Z";

    const movedOwnerAndAttempt = makeRefreshInProgressSnapshot();
    movedOwnerAndAttempt.refreshPlan.agentIds = ["agent_policy"];
    movedOwnerAndAttempt.agents[1].inFlightAttempt = null;
    movedOwnerAndAttempt.agents[1].runCount = 1;
    movedOwnerAndAttempt.agents[2].runCount = 2;
    movedOwnerAndAttempt.agents[2].inFlightAttempt = {
      attemptId: "attempt_policy_2",
      assignmentId: "assignment_policy_2",
      runId: "run_policy_2",
      status: "RUNNING",
      runStartedAt: "2026-08-29T12:00:01.000Z",
      runCompletedAt: null,
    };
    movedOwnerAndAttempt.metrics.reobservedAgents = 1;

    const ownerWithoutOldDecision = makeRefreshInProgressSnapshot();
    ownerWithoutOldDecision.agents[1].activeDecision = null;
    ownerWithoutOldDecision.metrics.activeDecisions = 2;
    ownerWithoutOldDecision.metrics.allowDecisions = 2;
    ownerWithoutOldDecision.jointValidity = {
      state: "PENDING",
      lowerBound: null,
      upperBound: null,
      currentHeadCovered: null,
      noCutProof: null,
    };

    const reusedOwnerRun = makeRefreshInProgressSnapshot();
    reusedOwnerRun.agents[1].inFlightAttempt.runId =
      reusedOwnerRun.agents[1].activeDecision.runId;

    const unsupportedPlanReason = makeRefreshInProgressSnapshot();
    unsupportedPlanReason.refreshPlan.reasonCode = "RUN_FAILED";
    const swappedNoCutReason = makeRefreshInProgressSnapshot();
    swappedNoCutReason.refreshPlan.reasonCode = "HISTORICAL_BUT_STALE_NOW";
    const swappedHistoricalReason = makeHistoricalRefreshInProgressSnapshot();
    swappedHistoricalReason.refreshPlan.reasonCode =
      "NO_VALID_OBSERVED_WORLD_CUT";

    const dispatchingClaimedWithoutAttempt = makeRefreshInProgressSnapshot();
    dispatchingClaimedWithoutAttempt.sessionState = "DISPATCHING";
    dispatchingClaimedWithoutAttempt.agents[1].inFlightAttempt = null;
    dispatchingClaimedWithoutAttempt.agents[1].runCount = 1;
    dispatchingClaimedWithoutAttempt.metrics.reobservedAgents = 0;

    const reobservingCompletedOldProof = makeRefreshInProgressSnapshot();
    reobservingCompletedOldProof.refreshPlan.status = "COMPLETED";
    reobservingCompletedOldProof.agents[1].inFlightAttempt = null;

    const validatingClaimed = makeRefreshValidatingSnapshot();
    validatingClaimed.refreshPlan.status = "CLAIMED";

    const collectingClaimedWithoutRemainingOwner =
      makeRefreshValidatingSnapshot();
    collectingClaimedWithoutRemainingOwner.sessionState = "COLLECTING";
    collectingClaimedWithoutRemainingOwner.gate.state = "WAITING";
    collectingClaimedWithoutRemainingOwner.refreshPlan.status = "CLAIMED";

    for (const candidate of [
      noInFlightOwner,
      wrongPlanOwner,
      nonOwnerInFlight,
      reusedOwnerAssignment,
      understatedRunCount,
      terminalClaimedAttempt,
      movedOwnerAndAttempt,
      ownerWithoutOldDecision,
      reusedOwnerRun,
      unsupportedPlanReason,
      swappedNoCutReason,
      swappedHistoricalReason,
      dispatchingClaimedWithoutAttempt,
      reobservingCompletedOldProof,
      validatingClaimed,
      collectingClaimedWithoutRemainingOwner,
    ]) {
      expectSnapshotRejected(candidate);
    }

    const failedTerminalProjection = makeRefreshInProgressSnapshot();
    failedTerminalProjection.sessionState = "FAILED";
    failedTerminalProjection.gate.reasonCode = "RUN_FAILED";
    failedTerminalProjection.agents[1].inFlightAttempt.status = "FAILED";
    failedTerminalProjection.agents[1].inFlightAttempt.runCompletedAt =
      "2026-08-29T12:00:02.000Z";
    expectSnapshotAccepted(failedTerminalProjection);

    const interruptedTerminalProjection = mutableClone(
      failedTerminalProjection,
    );
    interruptedTerminalProjection.sessionState = "INTERRUPTED";
    interruptedTerminalProjection.agents[1].inFlightAttempt.status =
      "INTERRUPTED";
    expectSnapshotAccepted(interruptedTerminalProjection);
  });

  it("binds every No-Cut proof to the exact sorted active Receipt set", () => {
    const receiptIds = IMPOSSIBLE_GOLDEN_SNAPSHOT.agents
      .map((agent) => agent.activeDecision.receipt.receiptId)
      .sort();
    const independentlyComputedDependencySetHash = sha256Digest(
      canonicalJson(receiptIds),
    );
    expect(
      IMPOSSIBLE_GOLDEN_SNAPSHOT.jointValidity.noCutProof.dependencySetHash,
    ).toBe(independentlyComputedDependencySetHash);
    expect(
      makeEqualBoundaryNoCutSnapshot().jointValidity.noCutProof
        .dependencySetHash,
    ).toBe(independentlyComputedDependencySetHash);

    const wrongDependencySetHash = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    wrongDependencySetHash.jointValidity.noCutProof.dependencySetHash =
      `sha256:${"f".repeat(64)}`;
    expectSnapshotRejected(wrongDependencySetHash);

    const canonicalTie = makeCanonicalTieNoCutSnapshot();
    expectSnapshotAccepted(canonicalTie);
    expect(canonicalTie.jointValidity.noCutProof.witness).toMatchObject([
      { role: "budget", receiptId: "receipt_budget_1", until: 20 },
      { role: "policy", receiptId: "receipt_a_policy_tie", from: 20 },
    ]);
    expect(
      canonicalTie.agents.findIndex(
        (agent: any) => agent.role === "policy",
      ),
    ).toBeGreaterThan(
      canonicalTie.agents.findIndex(
        (agent: any) => agent.role === "inventory",
      ),
    );

    const nonCanonicalTie = mutableClone(canonicalTie);
    const inventoryReceipt = nonCanonicalTie.agents[0].activeDecision.receipt;
    nonCanonicalTie.jointValidity.noCutProof.witness[1] = {
      role: "inventory",
      receiptId: inventoryReceipt.receiptId,
      from: inventoryReceipt.validFromSeq,
      until: inventoryReceipt.validUntilSeq,
    };
    expectSnapshotRejected(nonCanonicalTie);

    const earliestEndTie = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    earliestEndTie.agents[0].activeDecision.receipt.validUntilSeq = 20;
    earliestEndTie.agents[0].activeDecision.evidenceState = "INVALID_AT_HEAD";
    earliestEndTie.agents[0].activeDecision.receipt.receiptId =
      "receipt_z_inventory_end_tie";
    earliestEndTie.agents[1].activeDecision.receipt.receiptId =
      "receipt_a_budget_end_tie";
    earliestEndTie.jointValidity.noCutProof.dependencySetHash = sha256Digest(
      canonicalJson(
        earliestEndTie.agents
          .map((agent: any) => agent.activeDecision.receipt.receiptId)
          .sort(),
      ),
    );
    earliestEndTie.jointValidity.noCutProof.witness[0].receiptId =
      "receipt_a_budget_end_tie";
    earliestEndTie.refreshPlan.agentIds = ["agent_inventory", "agent_budget"];
    earliestEndTie.metrics.rerunsAvoided = 1;
    expectSnapshotAccepted(earliestEndTie);
    expect(
      earliestEndTie.agents.findIndex(
        (agent: any) => agent.role === "budget",
      ),
    ).toBeGreaterThan(
      earliestEndTie.agents.findIndex(
        (agent: any) => agent.role === "inventory",
      ),
    );

    const nonCanonicalEarliestEnd = mutableClone(earliestEndTie);
    const earliestInventoryReceipt =
      nonCanonicalEarliestEnd.agents[0].activeDecision.receipt;
    nonCanonicalEarliestEnd.jointValidity.noCutProof.witness[0] = {
      role: "inventory",
      receiptId: earliestInventoryReceipt.receiptId,
      from: earliestInventoryReceipt.validFromSeq,
      until: earliestInventoryReceipt.validUntilSeq,
    };
    expectSnapshotRejected(nonCanonicalEarliestEnd);
  });

  it("accepts the v6 refresh lifecycle through partial collection, validation, and commit", () => {
    const reobserving = makeRefreshInProgressSnapshot();
    const twoOwnerReobserving = makeTwoOwnerRefreshInProgressSnapshot();
    const historicalReobserving = makeHistoricalRefreshInProgressSnapshot();
    const collecting = mutableClone(reobserving);
    collecting.sessionState = "COLLECTING";
    collecting.gate.state = "WAITING";
    const partialCollecting = makePartialCollectingSnapshot();
    const reversePartialCollecting = makeReversePartialCollectingSnapshot();
    const threeOwnerCollecting = makeThreeOwnerRefreshInProgressSnapshot();
    threeOwnerCollecting.sessionState = "COLLECTING";
    threeOwnerCollecting.gate.state = "WAITING";
    const threeOwnerOneCompleted = mutableClone(threeOwnerCollecting);
    replaceActiveDecisionWithCurrent(threeOwnerOneCompleted, 1);
    threeOwnerOneCompleted.gate.reasonCode = null;
    threeOwnerOneCompleted.jointValidity = {
      state: "PENDING",
      lowerBound: null,
      upperBound: null,
      currentHeadCovered: null,
      noCutProof: null,
    };
    const threeOwnerTwoCompleted = mutableClone(threeOwnerOneCompleted);
    replaceActiveDecisionWithCurrent(threeOwnerTwoCompleted, 2);
    const validating = makeRefreshValidatingSnapshot();
    const initialValidating = makeInitialValidatingSnapshot();
    const initialImpossibleValidating = makeInitialImpossibleValidatingSnapshot();
    const initialCollecting = makeInitialImpossibleValidatingSnapshot();
    initialCollecting.sessionState = "COLLECTING";
    initialCollecting.gate.state = "WAITING";

    const ready = makeRefreshReadySnapshot();
    const committing = mutableClone(ready);
    committing.sessionState = "COMMITTING";
    committing.gate.state = "CHECKING";
    committing.availableActions = [];
    const committed = mutableClone(ready);
    committed.sessionState = "COMMITTED";
    committed.gate = {
      state: "RELEASED",
      reasonCode: null,
      effectsInSession: 1,
      permitId: "permit_refresh_1",
      effectId: "effect_refresh_1",
    };
    committed.availableActions = [];

    const commitRacePending = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    commitRacePending.sessionState = "COMMIT_RACE";
    commitRacePending.gate = {
      state: "LOCKED",
      reasonCode: "COMMIT_RACE",
      effectsInSession: 0,
      permitId: null,
      effectId: null,
    };
    commitRacePending.jointValidity = {
      state: "PENDING",
      lowerBound: null,
      upperBound: null,
      currentHeadCovered: null,
      noCutProof: null,
    };
    commitRacePending.availableActions = [];
    const failedLockedWithoutInventedReason = mutableClone(commitRacePending);
    failedLockedWithoutInventedReason.sessionState = "FAILED";
    failedLockedWithoutInventedReason.gate.reasonCode = null;
    const interruptedWithoutDedicatedReason = mutableClone(commitRacePending);
    interruptedWithoutDedicatedReason.sessionState = "INTERRUPTED";
    interruptedWithoutDedicatedReason.gate.reasonCode = null;

    for (const snapshot of [
      reobserving,
      twoOwnerReobserving,
      historicalReobserving,
      collecting,
      partialCollecting,
      reversePartialCollecting,
      threeOwnerCollecting,
      threeOwnerOneCompleted,
      threeOwnerTwoCompleted,
      validating,
      initialValidating,
      initialImpossibleValidating,
      initialCollecting,
      ready,
      committing,
      committed,
      commitRacePending,
      failedLockedWithoutInventedReason,
      interruptedWithoutDedicatedReason,
    ]) {
      expectSnapshotAccepted(snapshot);
    }
    expect(
      ready.agents.map((agent: any) => agent.activeDecision.evidenceState),
    ).toEqual(["RETAINED", "CURRENT", "RETAINED"]);
    expect(ready.refreshPlan).toMatchObject({
      status: "COMPLETED",
      agentIds: ["agent_budget"],
    });
    expect(ready.availableActions).toEqual(["COMMIT"]);
    expect(partialCollecting).toMatchObject({
      sessionState: "COLLECTING",
      jointValidity: { state: "PENDING" },
      refreshPlan: {
        status: "CLAIMED",
        agentIds: ["agent_budget", "agent_policy"],
      },
    });
    expect(partialCollecting.agents[1]).toMatchObject({
      agentId: "agent_budget",
      runCount: 2,
      inFlightAttempt: null,
      activeDecision: { evidenceState: "CURRENT", runId: "run_budget_2" },
    });
    expect(partialCollecting.agents[2]).toMatchObject({
      agentId: "agent_policy",
      inFlightAttempt: { status: "RUNNING" },
      activeDecision: { evidenceState: "INVALID_AT_HEAD" },
    });
    expect(validating).toMatchObject({
      sessionState: "VALIDATING",
      gate: { state: "CHECKING", reasonCode: null },
      jointValidity: { state: "PENDING" },
      refreshPlan: { status: "COMPLETED" },
      availableActions: [],
    });
    expect(validating.agents.every((agent: any) => agent.inFlightAttempt === null)).toBe(
      true,
    );
    expect(initialValidating.refreshPlan).toBeNull();
    expect(initialImpossibleValidating).toMatchObject({
      sessionState: "VALIDATING",
      refreshPlan: null,
      jointValidity: { state: "PENDING" },
    });
    expect(committing.gate.effectsInSession).toBe(0);
    expect(committed.gate.effectsInSession).toBe(1);
  });

  it("rejects all audited VALIDATING and partial-COLLECTING fail-open projections", () => {
    const validatingWrongGate = makeInitialValidatingSnapshot();
    validatingWrongGate.gate.state = "WAITING";

    const validatingValidCurrent = makeInitialValidatingSnapshot();
    validatingValidCurrent.jointValidity = mutableClone(
      NORMAL_READY_GOLDEN_SNAPSHOT.jointValidity,
    );

    const validatingWithAttempt = makeRefreshValidatingSnapshot();
    validatingWithAttempt.agents[1].inFlightAttempt = {
      attemptId: "attempt_budget_3",
      assignmentId: "assignment_budget_3",
      runId: "run_budget_3",
      status: "RUNNING",
      runStartedAt: "2026-08-29T12:00:03.000Z",
      runCompletedAt: null,
    };

    const validatingWithTwoDecisions = makeInitialValidatingSnapshot();
    validatingWithTwoDecisions.agents[2].activeDecision = null;
    validatingWithTwoDecisions.metrics.activeDecisions = 2;
    validatingWithTwoDecisions.metrics.allowDecisions = 2;

    const reobservedInitialWithoutPlan = makeInitialValidatingSnapshot();
    reobservedInitialWithoutPlan.agents[1].runCount = 2;
    reobservedInitialWithoutPlan.metrics.reobservedAgents = 1;

    const deletedCompletedPlan = makeRefreshValidatingSnapshot();
    deletedCompletedPlan.refreshPlan = null;
    deletedCompletedPlan.metrics.rerunsAvoided = 0;

    const refreshedOwnerNotCurrent = makeRefreshValidatingSnapshot();
    refreshedOwnerNotCurrent.agents[1].activeDecision.evidenceState = "RETAINED";

    const collectingPlanDeleted = makePartialCollectingSnapshot();
    collectingPlanDeleted.refreshPlan = null;
    collectingPlanDeleted.metrics.rerunsAvoided = 0;

    const collectingCompletedOwnerDropped = makePartialCollectingSnapshot();
    collectingCompletedOwnerDropped.refreshPlan.agentIds = ["agent_policy"];
    collectingCompletedOwnerDropped.metrics.rerunsAvoided = 2;

    const collectingStaleProofAfterCompletion = makePartialCollectingSnapshot();
    const partialReceiptIds = collectingStaleProofAfterCompletion.agents
      .map((agent: any) => agent.activeDecision.receipt.receiptId)
      .sort();
    collectingStaleProofAfterCompletion.gate.reasonCode =
      "NO_VALID_OBSERVED_WORLD_CUT";
    collectingStaleProofAfterCompletion.jointValidity = {
      state: "NO_CUT",
      lowerBound: 21,
      upperBound: 21,
      currentHeadCovered: false,
      noCutProof: {
        proofId: "proof_partial_stale",
        dependencySetHash: sha256Digest(canonicalJson(partialReceiptIds)),
        lowerBound: 21,
        upperBound: 21,
        witness: [
          {
            role: "policy",
            receiptId: "receipt_policy_1",
            from: 20,
            until: 21,
          },
          {
            role: "budget",
            receiptId: "receipt_budget_2",
            from: 21,
            until: null,
          },
        ],
      },
    };

    const collectingCompletedPlan = makePartialCollectingSnapshot();
    collectingCompletedPlan.refreshPlan.status = "COMPLETED";

    for (const candidate of [
      validatingWrongGate,
      validatingValidCurrent,
      validatingWithAttempt,
      validatingWithTwoDecisions,
      reobservedInitialWithoutPlan,
      deletedCompletedPlan,
      refreshedOwnerNotCurrent,
      collectingPlanDeleted,
      collectingCompletedOwnerDropped,
      collectingStaleProofAfterCompletion,
      collectingCompletedPlan,
    ]) {
      expectSnapshotRejected(candidate);
    }
  });

  it("constrains CLAIMED terminal provenance while preserving partial failure projections", () => {
    const failedRunning = makeTerminalClaimedSnapshot();
    const interruptedQueued = makeTerminalClaimedSnapshot(
      "INTERRUPTED",
      "INTERRUPTED",
    );
    interruptedQueued.agents[1].inFlightAttempt.runStartedAt = null;
    const partialTerminal = makePartialCollectingSnapshot();
    partialTerminal.sessionState = "FAILED";
    partialTerminal.gate.reasonCode = "RUN_FAILED";
    partialTerminal.agents[2].inFlightAttempt.status = "INTERRUPTED";
    partialTerminal.agents[2].inFlightAttempt.runCompletedAt =
      "2026-08-29T12:00:02.000Z";

    const interruptedAfterValidation = makeRefreshValidatingSnapshot();
    interruptedAfterValidation.sessionState = "INTERRUPTED";
    interruptedAfterValidation.gate = {
      state: "LOCKED",
      reasonCode: null,
      effectsInSession: 0,
      permitId: null,
      effectId: null,
    };

    for (const snapshot of [
      failedRunning,
      interruptedQueued,
      partialTerminal,
      interruptedAfterValidation,
    ]) {
      expectSnapshotAccepted(snapshot);
    }

    const terminalRunning = makeTerminalClaimedSnapshot();
    terminalRunning.agents[1].inFlightAttempt.status = "RUNNING";
    terminalRunning.agents[1].inFlightAttempt.runCompletedAt = null;
    const terminalQueued = makeTerminalClaimedSnapshot();
    Object.assign(terminalQueued.agents[1].inFlightAttempt, {
      status: "QUEUED",
      runStartedAt: null,
      runCompletedAt: null,
    });
    const terminalCompleted = makeTerminalClaimedSnapshot();
    terminalCompleted.agents[1].inFlightAttempt.status = "COMPLETED";
    const terminalNoAttempt = makeTerminalClaimedSnapshot();
    terminalNoAttempt.agents[1].inFlightAttempt = null;
    const terminalWrongOwner = makeTerminalClaimedSnapshot();
    terminalWrongOwner.refreshPlan.agentIds = ["agent_policy"];
    const terminalDeletedOldDecision = makeTerminalClaimedSnapshot();
    terminalDeletedOldDecision.agents[1].activeDecision = null;
    terminalDeletedOldDecision.metrics.activeDecisions = 2;
    terminalDeletedOldDecision.metrics.allowDecisions = 2;
    terminalDeletedOldDecision.jointValidity = {
      state: "PENDING",
      lowerBound: null,
      upperBound: null,
      currentHeadCovered: null,
      noCutProof: null,
    };
    const terminalReusedAssignment = makeTerminalClaimedSnapshot();
    terminalReusedAssignment.agents[1].inFlightAttempt.assignmentId =
      terminalReusedAssignment.agents[1].activeDecision.runtimeProof.assignmentId;
    const terminalReusedRun = makeTerminalClaimedSnapshot();
    terminalReusedRun.agents[1].inFlightAttempt.runId =
      terminalReusedRun.agents[1].activeDecision.runId;

    for (const candidate of [
      terminalRunning,
      terminalQueued,
      terminalCompleted,
      terminalNoAttempt,
      terminalWrongOwner,
      terminalDeletedOldDecision,
      terminalReusedAssignment,
      terminalReusedRun,
    ]) {
      expectSnapshotRejected(candidate);
    }
  });

  it("routes AVAILABLE, CLAIMED, and COMPLETED RefreshPlan states closed", () => {
    const completedPreRefreshStates = [
      "CREATED",
      "DISPATCHING",
      "REOBSERVING",
      "COLLECTING",
      "BLOCKED_NO_CUT",
      "HISTORICAL_STALE",
      "UNSTABLE_WORLD",
    ];
    for (const sessionState of completedPreRefreshStates) {
      const candidate = makeRefreshValidatingSnapshot();
      candidate.sessionState = sessionState;
      expectSnapshotRejected(candidate);
    }

    const availableOutsideBlocked = makeRefreshValidatingSnapshot();
    availableOutsideBlocked.refreshPlan.status = "AVAILABLE";
    expectSnapshotRejected(availableOutsideBlocked);
    const claimedDispatching = makeRefreshInProgressSnapshot();
    claimedDispatching.sessionState = "DISPATCHING";
    expectSnapshotRejected(claimedDispatching);
  });

  it("rejects every audited five-state and universal-safety counterexample on both decoders", () => {
    const coherentButNotNoCut = makeEqualBoundaryNoCutSnapshot();
    const policyReceipt = coherentButNotNoCut.agents[2].activeDecision.receipt;
    policyReceipt.sourceRevision = 19;
    policyReceipt.observedAtSeq = 19;
    policyReceipt.validFromSeq = 19;
    coherentButNotNoCut.jointValidity.lowerBound = 19;
    coherentButNotNoCut.jointValidity.noCutProof.lowerBound = 19;
    coherentButNotNoCut.jointValidity.noCutProof.witness[1].from = 19;

    const releasedWithDeny = mutableClone(NORMAL_RELEASED_GOLDEN_SNAPSHOT);
    releasedWithDeny.agents[1].activeDecision.verdict = "DENY";
    releasedWithDeny.metrics.allowDecisions = 2;
    releasedWithDeny.metrics.denyDecisions = 1;
    const readyInvalidEvidence = makeRefreshReadySnapshot();
    readyInvalidEvidence.agents[0].activeDecision.evidenceState =
      "INVALID_AT_HEAD";
    const releasedInvalidEvidence = mutableClone(NORMAL_RELEASED_GOLDEN_SNAPSHOT);
    releasedInvalidEvidence.agents[0].activeDecision.evidenceState =
      "INVALID_AT_HEAD";
    const lockedWithPermit = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    lockedWithPermit.gate.permitId = "permit_illegal";
    const noCutWithoutPlan = makeEqualBoundaryNoCutSnapshot();
    noCutWithoutPlan.refreshPlan = null;
    noCutWithoutPlan.metrics.rerunsAvoided = 0;
    noCutWithoutPlan.availableActions = [];
    const readyWithReason = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    readyWithReason.gate.reasonCode = "CONSISTENT_DENY";
    const releasedWithReason = mutableClone(NORMAL_RELEASED_GOLDEN_SNAPSHOT);
    releasedWithReason.gate.reasonCode = "CONSISTENT_DENY";
    const readyWithWaitingGate = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    readyWithWaitingGate.gate.state = "WAITING";
    readyWithWaitingGate.gate.permitId = null;

    const consistentAllAllow = makeInitialConsistentDenySnapshot();
    consistentAllAllow.agents[1].activeDecision.verdict = "ALLOW";
    consistentAllAllow.metrics.allowDecisions = 3;
    consistentAllAllow.metrics.denyDecisions = 0;
    const consistentNullReason = makeInitialConsistentDenySnapshot();
    consistentNullReason.gate.reasonCode = null;
    const consistentWrongReason = makeInitialConsistentDenySnapshot();
    consistentWrongReason.gate.reasonCode = "RUN_FAILED";
    const consistentProjectionWrongState = makeInitialConsistentDenySnapshot();
    consistentProjectionWrongState.sessionState = "FAILED";
    const blockedNullReason = makeEqualBoundaryNoCutSnapshot();
    blockedNullReason.gate.reasonCode = null;
    const blockedWrongReason = makeEqualBoundaryNoCutSnapshot();
    blockedWrongReason.gate.reasonCode = "HISTORICAL_BUT_STALE_NOW";

    const failedWaiting = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    failedWaiting.sessionState = "FAILED";
    failedWaiting.gate = {
      state: "WAITING",
      reasonCode: null,
      effectsInSession: 0,
      permitId: null,
      effectId: null,
    };
    failedWaiting.jointValidity = {
      state: "PENDING",
      lowerBound: null,
      upperBound: null,
      currentHeadCovered: null,
      noCutProof: null,
    };
    failedWaiting.availableActions = [];

    const claimedStillBlocked = makeEqualBoundaryNoCutSnapshot();
    claimedStillBlocked.refreshPlan.status = "CLAIMED";
    claimedStillBlocked.availableActions = [];
    const historicalWrongOwner = makeHistoricalStaleSnapshot();
    historicalWrongOwner.refreshPlan.agentIds = ["agent_policy"];
    const refreshedReadyAsAvailable = makeRefreshReadySnapshot();
    refreshedReadyAsAvailable.refreshPlan.status = "AVAILABLE";
    const refreshedReadyAsClaimed = makeRefreshReadySnapshot();
    refreshedReadyAsClaimed.refreshPlan.status = "CLAIMED";
    refreshedReadyAsClaimed.availableActions = [];
    const refreshedReadyWrongOwner = makeRefreshReadySnapshot();
    refreshedReadyWrongOwner.refreshPlan.agentIds = ["agent_policy"];

    const inFlightAttempt = makeRefreshInProgressSnapshot().agents[1]
      .inFlightAttempt;
    const readyWithInFlight = makeRefreshReadySnapshot();
    readyWithInFlight.agents[1].inFlightAttempt = mutableClone(inFlightAttempt);
    const releasedWithInFlight = makeRefreshReadySnapshot();
    releasedWithInFlight.sessionState = "COMMITTED";
    releasedWithInFlight.gate = {
      state: "RELEASED",
      reasonCode: null,
      effectsInSession: 1,
      permitId: "permit_refresh_1",
      effectId: "effect_refresh_1",
    };
    releasedWithInFlight.availableActions = [];
    releasedWithInFlight.agents[1].inFlightAttempt = mutableClone(inFlightAttempt);

    for (const candidate of [
      coherentButNotNoCut,
      releasedWithDeny,
      readyInvalidEvidence,
      releasedInvalidEvidence,
      lockedWithPermit,
      noCutWithoutPlan,
      readyWithReason,
      releasedWithReason,
      readyWithWaitingGate,
      consistentAllAllow,
      consistentNullReason,
      consistentWrongReason,
      consistentProjectionWrongState,
      blockedNullReason,
      blockedWrongReason,
      failedWaiting,
      claimedStillBlocked,
      historicalWrongOwner,
      refreshedReadyAsAvailable,
      refreshedReadyAsClaimed,
      refreshedReadyWrongOwner,
      readyWithInFlight,
      releasedWithInFlight,
    ]) {
      expectSnapshotRejected(candidate);
    }
  });

  it("freezes READY -> COMMIT -> RELEASED as Normal's only 0 -> 1 transition", () => {
    expect(GOLDEN_FIXTURE_MANIFEST[0].expected.initialEffectsInSession).toBe(0);
    expect(NORMAL_READY_GOLDEN_SNAPSHOT).toMatchObject({
      sessionState: "READY_AT_CURRENT_HEAD",
      gate: { state: "READY", effectsInSession: 0, effectId: null },
      jointValidity: { state: "VALID_CURRENT", currentHeadCovered: true },
      availableActions: ["COMMIT"],
    });
    expect(NORMAL_RELEASED_GOLDEN_SNAPSHOT).toMatchObject({
      sessionState: "COMMITTED",
      gate: { state: "RELEASED", effectsInSession: 1 },
      availableActions: [],
    });
    expect(IMPOSSIBLE_GOLDEN_SNAPSHOT.gate.effectsInSession).toBe(0);
    expect(RECOVERED_GOLDEN_SNAPSHOT.gate.effectsInSession).toBe(0);
  });

  it("fails closed on Effect, proof, owner, hash, metric, and action contradictions", () => {
    const releasedNoEffect = mutableClone(NORMAL_RELEASED_GOLDEN_SNAPSHOT);
    releasedNoEffect.gate.effectsInSession = 0;
    const releasedNoPermit = mutableClone(NORMAL_RELEASED_GOLDEN_SNAPSHOT);
    releasedNoPermit.gate.permitId = null;
    const releasedNoEffectId = mutableClone(NORMAL_RELEASED_GOLDEN_SNAPSHOT);
    releasedNoEffectId.gate.effectId = null;
    const releasedWithMutation = mutableClone(NORMAL_RELEASED_GOLDEN_SNAPSHOT);
    releasedWithMutation.availableActions = ["COMMIT"];
    const readyWithEffect = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    readyWithEffect.gate.effectsInSession = 1;
    readyWithEffect.gate.effectId = "effect_illegal";

    const noCutWithoutProof = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    noCutWithoutProof.jointValidity.noCutProof = null;
    const noCutMismatchedBounds = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    noCutMismatchedBounds.jointValidity.noCutProof.lowerBound = 20;
    const noCutNonContradictory = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    noCutNonContradictory.jointValidity.lowerBound = 20;
    noCutNonContradictory.jointValidity.noCutProof.lowerBound = 20;
    const noCutWrongWitness = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    noCutWrongWitness.jointValidity.noCutProof.witness[0].receiptId =
      "receipt_inventory_1";
    const noCutWrongOwner = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    noCutWrongOwner.refreshPlan.agentIds = ["agent_policy"];

    const validWrongBounds = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    validWrongBounds.jointValidity.upperBound = 12;
    const validNotCovered = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    validNotCovered.jointValidity.currentHeadCovered = false;
    const validWithProof = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    validWithProof.jointValidity.noCutProof = mutableClone(
      IMPOSSIBLE_GOLDEN_SNAPSHOT.jointValidity.noCutProof,
    );
    const wrongActionHash = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    wrongActionHash.actionHash = `sha256:${"f".repeat(64)}`;
    const wrongDecisionMetrics = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    wrongDecisionMetrics.metrics.activeDecisions = 2;
    const wrongRunMetrics = mutableClone(RECOVERED_GOLDEN_SNAPSHOT);
    wrongRunMetrics.metrics.reobservedAgents = 0;
    const readyWithoutCommit = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    readyWithoutCommit.availableActions = [];
    const noCutWithCommit = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    noCutWithCommit.availableActions = ["COMMIT"];

    for (const candidate of [
      releasedNoEffect,
      releasedNoPermit,
      releasedNoEffectId,
      releasedWithMutation,
      readyWithEffect,
      noCutWithoutProof,
      noCutMismatchedBounds,
      noCutNonContradictory,
      noCutWrongWitness,
      noCutWrongOwner,
      validWrongBounds,
      validNotCovered,
      validWithProof,
      wrongActionHash,
      wrongDecisionMetrics,
      wrongRunMetrics,
      readyWithoutCommit,
      noCutWithCommit,
    ]) {
      expectSnapshotRejected(candidate);
    }
  });

  it("rejects unknown Schema/enum, extra fields, role reorder, and unsafe ArtifactRefs", () => {
    const roleOrder = mutableClone(NORMAL_READY_GOLDEN_SNAPSHOT);
    [roleOrder.agents[0], roleOrder.agents[1]] = [
      roleOrder.agents[1],
      roleOrder.agents[0],
    ];
    const unsafePath = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    unsafePath.latestDiagnostics[0].relevantIds[0] = {
      kind: "RUN",
      id: "C:\\external\\run.json",
    };
    const unsafeEnvelopeId = mutableClone(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    unsafeEnvelopeId.latestDiagnostics[0].relevantIds[0] = {
      kind: "ENVELOPE_DIGEST",
      id: "arbitrary text",
    };
    for (const candidate of [
      { ...NORMAL_READY_GOLDEN_SNAPSHOT, schemaVersion: 2 },
      {
        ...NORMAL_READY_GOLDEN_SNAPSHOT,
        contractDigest: `sha256:${"f".repeat(64)}`,
      },
      { ...NORMAL_READY_GOLDEN_SNAPSHOT, sessionState: "MYSTERY" },
      { ...NORMAL_READY_GOLDEN_SNAPSHOT, secret: "must not pass" },
      roleOrder,
      unsafePath,
      unsafeEnvelopeId,
    ]) {
      expectSnapshotRejected(candidate);
    }
  });

  it("accepts an empty database only with every frozen collection", () => {
    expect(
      EpochDatabaseSchema.safeParse({
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
      }).success,
    ).toBe(true);
  });

  it("keeps frozen Server/Web constants identical", () => {
    expect(webContracts.CONTRACT_VERSION).toBe(CONTRACT_VERSION);
    expect(webContracts.CONTRACT_DIGEST).toBe(CONTRACT_DIGEST);
    expect(webContracts.ROLES).toEqual(ROLES);
    expect(webContracts.FAILURE_CODES).toEqual(FAILURE_CODES);
    expect(webContracts.REFRESH_PLAN_REASON_CODES).toEqual(
      REFRESH_PLAN_REASON_CODES,
    );
    expect(webContracts.ARTIFACT_REF_KINDS).toEqual(ARTIFACT_REF_KINDS);
    expect(webContracts.API_ERROR_STATUS).toEqual(API_ERROR_STATUS);
  });
});
