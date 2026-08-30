import { describe, expect, it } from "vitest";

import {
  EpochDatabaseSchema,
  GOLDEN_ACTION_HASH,
  GOLDEN_ACTION_INPUT,
  ROLES,
  buildRoleQuerySpec,
  canonicalJson,
  decodeSessionDashboardSnapshot,
  sha256Digest,
  snapshotReceiptDependencySetHash,
  type EpochDatabase,
  type Role,
  type Verdict,
} from "./types.js";
import {
  SessionViewBuilder,
  SessionViewBuilderError,
  buildSessionDashboardSnapshotFromSnapshot,
} from "./session-view-builder.js";
import {
  SafetyDiagnosticIntegrityError,
  assertSafetyDiagnosticCausalChains,
} from "./safety-diagnostics.js";

const SESSION_ID = "session_eg05";
const HEAD = 21;
const NOW = "2026-08-29T12:00:00.000Z";
const LATER = "2026-08-29T12:01:00.000Z";

const roleAgentId = (role: Role): string => `agent_${role}`;
const roleTitle = (role: Role): string =>
  `${role[0]?.toUpperCase() ?? ""}${role.slice(1)}`;
const assignmentId = (role: Role, run = 1): string =>
  `assignment_${role}_${run}`;
const attemptId = (role: Role, run = 1): string => `attempt_${role}_${run}`;
const runId = (role: Role, run = 1): string => `run_${role}_${run}`;
const receiptId = (role: Role, run = 1): string => `receipt_${role}_${run}`;
const certificateId = (role: Role, run = 1): string =>
  `decision_${role}_${run}`;

const ACTION = {
  ...GOLDEN_ACTION_INPUT,
  actionId: "action_eg05",
  sessionId: SESSION_ID,
  actionHash: GOLDEN_ACTION_HASH,
  idempotencyKey: `${SESSION_ID}:${GOLDEN_ACTION_HASH}`,
};

const VALUES = {
  inventory: { availableUnits: 4 },
  budget: { remainingBudgetCents: 900_000 },
  policy: { permitted: true },
} as const;

type EvidenceSpec = {
  sourceRevision: number;
  observedAtSeq: number;
  validFromSeq: number;
  validUntilSeq: number | null;
};

const STABLE_EVIDENCE: Record<Role, EvidenceSpec> = {
  inventory: {
    sourceRevision: 18,
    observedAtSeq: 18,
    validFromSeq: 10,
    validUntilSeq: null,
  },
  budget: {
    sourceRevision: 19,
    observedAtSeq: 19,
    validFromSeq: 11,
    validUntilSeq: null,
  },
  policy: {
    sourceRevision: 20,
    observedAtSeq: 20,
    validFromSeq: 12,
    validUntilSeq: null,
  },
};

const NO_CUT_EVIDENCE: Record<Role, EvidenceSpec> = {
  inventory: {
    sourceRevision: 18,
    observedAtSeq: 18,
    validFromSeq: 18,
    validUntilSeq: null,
  },
  budget: {
    sourceRevision: 19,
    observedAtSeq: 19,
    validFromSeq: 19,
    validUntilSeq: 20,
  },
  policy: {
    sourceRevision: 21,
    observedAtSeq: 21,
    validFromSeq: 21,
    validUntilSeq: null,
  },
};

function makeDatabase(
  verdicts: Record<Role, Verdict> = {
    inventory: "ALLOW",
    budget: "ALLOW",
    policy: "ALLOW",
  },
): EpochDatabase {
  const queries = ROLES.map((role) => buildRoleQuerySpec(GOLDEN_ACTION_INPUT, role));
  const queryFor = (role: Role) => {
    const query = queries.find((candidate) => candidate.role === role);
    if (query === undefined) throw new Error(`missing ${role} query`);
    return query;
  };
  const valueHashFor = (role: Role): string =>
    sha256Digest(canonicalJson(VALUES[role]));
  const receiptIds = ROLES.map((role) => receiptId(role));
  const decisionIds = ROLES.map((role) => certificateId(role)) as [
    string,
    string,
    string,
  ];
  const dependencySetHash = snapshotReceiptDependencySetHash(receiptIds);

  return EpochDatabaseSchema.parse({
    schemaVersion: 1,
    snapshotRevision: 101,
    headSeq: HEAD,
    roleAgentRegistrations: ROLES.map((role) => ({
      role,
      agentId: roleAgentId(role),
      agentNameAtRegistration: `${roleTitle(role)} Agent`,
      roleProfileVersion: `profile_${role}_v1`,
      agentsMdDigest: sha256Digest(`agents-md:${role}`),
      registeredAt: NOW,
    })),
    worldCommits: [],
    resourceVersions: ROLES.map((role) => ({
      id: `version_${role}_1`,
      resourceId: `resource_${role}`,
      sourceRevision: STABLE_EVIDENCE[role].sourceRevision,
      value: VALUES[role],
      valueHash: valueHashFor(role),
      validFromSeq: STABLE_EVIDENCE[role].validFromSeq,
      validUntilSeq: STABLE_EVIDENCE[role].validUntilSeq,
    })),
    roleQuerySpecs: queries,
    runAssignments: ROLES.map((role) => ({
      assignmentId: assignmentId(role),
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      agentId: roleAgentId(role),
      agentNameAtAssignment: `${roleTitle(role)} Agent`,
      role,
      receiptId: receiptId(role),
      queryHash: queryFor(role).queryHash,
      roleProfileVersion: `profile_${role}_v1`,
      promptTemplateVersion: `prompt_${role}_v1`,
      agentsMdDigest: sha256Digest(`agents-md:${role}`),
      runtimeLabelAtDispatch: `codex-${role}`,
      evidencePackRelativePath: `.epochguard/sessions/${SESSION_ID}/${role}/${assignmentId(role)}.json`,
      evidencePackHash: sha256Digest(`evidence-pack:${role}:1`),
      boundRunId: runId(role),
      status: "CONSUMED",
      consumedByDecisionCertificateId: certificateId(role),
      createdAt: NOW,
      boundAt: NOW,
      consumedAt: NOW,
    })),
    receipts: ROLES.map((role) => ({
      schemaVersion: 1,
      receiptId: receiptId(role),
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      agentId: roleAgentId(role),
      runAssignmentId: assignmentId(role),
      role,
      source: role,
      entityKey: queryFor(role).entityKey,
      queryHash: queryFor(role).queryHash,
      sourceRevision: STABLE_EVIDENCE[role].sourceRevision,
      valueHash: valueHashFor(role),
      observedAtSeq: STABLE_EVIDENCE[role].observedAtSeq,
      nonce: `nonce-${role}-`.padEnd(40, "x"),
      issuer: "epochguard",
      issuedAt: NOW,
    })),
    sessions: [
      {
        sessionId: SESSION_ID,
        scenarioId: "normal-world-v1",
        action: ACTION,
        actionHash: GOLDEN_ACTION_HASH,
        state: verdicts.policy === "DENY" ? "CONSISTENT_DENY" : "READY_AT_CURRENT_HEAD",
        sessionRevision: 8,
        coordinationMode: "CONCURRENT",
        frozenAssignments: {
          inventoryAgentId: roleAgentId("inventory"),
          budgetAgentId: roleAgentId("budget"),
          policyAgentId: roleAgentId("policy"),
        },
        activeDecisionCertificateIds: {
          inventory: certificateId("inventory"),
          budget: certificateId("budget"),
          policy: certificateId("policy"),
        },
        activeAttemptIds: { inventory: null, budget: null, policy: null },
        activeValidationId: "validation_current",
        activeRefreshPlanId: null,
        activePermitId: verdicts.policy === "DENY" ? null : "permit_current",
        stateUpdatedAt: NOW,
        createdAt: NOW,
      },
    ],
    attempts: ROLES.map((role) => ({
      attemptId: attemptId(role),
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      role,
      agentId: roleAgentId(role),
      assignmentId: assignmentId(role),
      runId: runId(role),
      status: "ACCEPTED",
      runStartedAt: NOW,
      runCompletedAt: LATER,
      threadId: `thread_${role}_1`,
      usage: { inputTokens: 100, outputTokens: 20 },
      outputDigest: sha256Digest(`output:${role}:1`),
    })),
    decisions: ROLES.map((role) => ({
      certificateId: certificateId(role),
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      agentId: roleAgentId(role),
      runAssignmentId: assignmentId(role),
      runId: runId(role),
      role,
      verdict: verdicts[role],
      receiptIds: [receiptId(role)],
      decisionDigest: sha256Digest(`decision:${role}:1:${verdicts[role]}`),
      status: "ACTIVE",
      supersededByCertificateId: null,
      constructedBy: "epochguard",
      createdAt: LATER,
    })),
    validations: [
      {
        validationId: "validation_current",
        sessionId: SESSION_ID,
        actionHash: GOLDEN_ACTION_HASH,
        baseSessionRevision: 7,
        decisionCertificateIds: decisionIds,
        dependencySetHash,
        validatedHead: HEAD,
        outcome: verdicts.policy === "DENY" ? "CONSISTENT_DENY" : "VALID_CURRENT_ALLOW",
        lowerBound: 12,
        upperBound: HEAD + 1,
        jointValidityCertificateId: "jvc_current",
        noCutProofId: null,
        refreshPlanId: null,
        verificationLatencyMs: 7,
        createdAt: LATER,
      },
    ],
    jointValidityCertificates: [
      {
        certificateId: "jvc_current",
        validationId: "validation_current",
        sessionId: SESSION_ID,
        actionHash: GOLDEN_ACTION_HASH,
        dependencySetHash,
        validatedAtHead: HEAD,
        selectedCutSeq: HEAD,
        currentHeadCovered: true,
        decisionCertificateIds: decisionIds,
        intervals: ROLES.map((role) => ({
          receiptId: receiptId(role),
          source: role,
          sourceRevision: STABLE_EVIDENCE[role].sourceRevision,
          from: STABLE_EVIDENCE[role].validFromSeq,
          until: STABLE_EVIDENCE[role].validUntilSeq,
        })),
        validatorVersion: "epochguard-jv-v1",
        createdAt: LATER,
      },
    ],
    noCutProofs: [],
    refreshPlans: [],
    permits:
      verdicts.policy === "DENY"
        ? []
        : [
            {
              permitId: "permit_current",
              sessionId: SESSION_ID,
              actionHash: GOLDEN_ACTION_HASH,
              dependencySetHash,
              jointValidityCertificateId: "jvc_current",
              validatedHead: HEAD,
              idempotencyKey: ACTION.idempotencyKey,
              status: "ISSUED",
              issuedAt: LATER,
              consumedAt: null,
            },
          ],
    effects: [],
    diagnostics:
      verdicts.policy === "DENY"
        ? [
            {
              diagnosticId: "diagnostic_deny",
              sessionId: SESSION_ID,
              actionHash: GOLDEN_ACTION_HASH,
              sessionRevision: 8,
              fixtureRef: null,
              kind: "EXPECTED_BLOCK",
              stage: "VALIDATE",
              reasonCode: "CONSISTENT_DENY",
              role: null,
              attemptId: null,
              assignmentId: null,
              runId: null,
              artifactRefs: [{ kind: "VALIDATION", id: "validation_current" }],
              causedByDiagnosticIds: [],
              expected: null,
              actual: null,
              rejectedOutputArtifactId: null,
              auditSeq: 1,
              recommendedAction: "NONE",
            },
          ]
        : [],
    rejectedOutputArtifacts: [],
    auditEvents: [
      {
        eventId: "event_state",
        sessionId: SESSION_ID,
        actionHash: GOLDEN_ACTION_HASH,
        sessionRevision: 8,
        auditSeq: 10,
        type: "SESSION_STATE",
        status: verdicts.policy === "DENY" ? "DENIED" : "READY",
        role: null,
        artifactRefs: [],
        createdAt: LATER,
      },
    ],
  });
}

function makeCollectingDatabase(): EpochDatabase {
  const database = makeDatabase();
  database.snapshotRevision = 102;
  const session = database.sessions[0]!;
  session.state = "COLLECTING";
  session.sessionRevision = 2;
  session.activeDecisionCertificateIds = {
    inventory: null,
    budget: null,
    policy: null,
  };
  session.activeAttemptIds = {
    inventory: attemptId("inventory"),
    budget: attemptId("budget"),
    policy: attemptId("policy"),
  };
  session.activeValidationId = null;
  session.activePermitId = null;
  database.runAssignments.forEach((assignment) => {
    assignment.status = "BOUND";
    assignment.consumedByDecisionCertificateId = null;
    assignment.consumedAt = null;
  });
  database.attempts.forEach((attempt) => {
    attempt.status = "RUNNING";
    attempt.runCompletedAt = null;
    attempt.outputDigest = null;
  });
  database.receipts = [];
  database.decisions = [];
  database.validations = [];
  database.jointValidityCertificates = [];
  database.permits = [];
  database.auditEvents[0]!.status = "COLLECTING";
  return EpochDatabaseSchema.parse(database);
}

function makeNoCutDatabase(): EpochDatabase {
  const database = makeDatabase();
  database.snapshotRevision = 201;
  const session = database.sessions[0]!;
  session.scenarioId = "impossible-collage-v1";
  session.state = "BLOCKED_NO_CUT";
  session.sessionRevision = 4;
  session.activeValidationId = "validation_no_cut";
  session.activeRefreshPlanId = "refresh_budget";
  session.activePermitId = null;

  for (const role of ROLES) {
    const evidence = NO_CUT_EVIDENCE[role];
    const version = database.resourceVersions.find(
      (candidate) => candidate.resourceId === `resource_${role}`,
    )!;
    version.sourceRevision = evidence.sourceRevision;
    version.validFromSeq = evidence.validFromSeq;
    version.validUntilSeq = evidence.validUntilSeq;
    const receipt = database.receipts.find((candidate) => candidate.role === role)!;
    receipt.sourceRevision = evidence.sourceRevision;
    receipt.observedAtSeq = evidence.observedAtSeq;
  }

  const decisionIds = ROLES.map((role) => certificateId(role)) as [
    string,
    string,
    string,
  ];
  const dependencySetHash = snapshotReceiptDependencySetHash(
    ROLES.map((role) => receiptId(role)),
  );
  database.validations = [
    {
      validationId: "validation_no_cut",
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      baseSessionRevision: 3,
      decisionCertificateIds: decisionIds,
      dependencySetHash,
      validatedHead: HEAD,
      outcome: "NO_VALID_OBSERVED_WORLD_CUT",
      lowerBound: 21,
      upperBound: 20,
      jointValidityCertificateId: null,
      noCutProofId: "proof_no_cut",
      refreshPlanId: "refresh_budget",
      verificationLatencyMs: 9,
      createdAt: LATER,
    },
  ];
  database.jointValidityCertificates = [];
  database.noCutProofs = [
    {
      proofId: "proof_no_cut",
      validationId: "validation_no_cut",
      reason: "NO_VALID_OBSERVED_WORLD_CUT",
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      dependencySetHash,
      decisionCertificateIds: decisionIds,
      validatedAtHead: HEAD,
      lowerBound: 21,
      upperBound: 20,
      latestStartingReceiptId: receiptId("policy"),
      earliestEndingReceiptId: receiptId("budget"),
      conflictWitnessReceiptIds: [receiptId("budget"), receiptId("policy")],
      refreshAgentIds: [roleAgentId("budget")],
      createdAt: LATER,
    },
  ];
  database.refreshPlans = [
    {
      refreshPlanId: "refresh_budget",
      sessionId: SESSION_ID,
      baseSessionRevision: 3,
      validatedHead: HEAD,
      dependencySetHash,
      activeDecisionCertificateIds: decisionIds,
      agentIds: [roleAgentId("budget")],
      status: "AVAILABLE",
      claimedAttemptId: null,
    },
  ];
  database.permits = [];
  database.diagnostics = [
    {
      diagnosticId: "diagnostic_no_cut",
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      sessionRevision: 4,
      fixtureRef: "impossible-collage-v1",
      kind: "EXPECTED_BLOCK",
      stage: "VALIDATE",
      reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
      role: null,
      attemptId: null,
      assignmentId: null,
      runId: null,
      artifactRefs: [
        { kind: "VALIDATION", id: "validation_no_cut" },
        { kind: "PROOF", id: "proof_no_cut" },
        { kind: "RECEIPT", id: receiptId("budget") },
        { kind: "RECEIPT", id: receiptId("policy") },
        { kind: "REFRESH_PLAN", id: "refresh_budget" },
      ],
      causedByDiagnosticIds: [],
      expected: null,
      actual: null,
      rejectedOutputArtifactId: null,
      auditSeq: 1,
      recommendedAction: "REOBSERVE_INVALID",
    },
  ];
  database.auditEvents[0]!.status = "BLOCKED_NO_CUT";
  return EpochDatabaseSchema.parse(database);
}

function makeHistoricalStaleDatabase(): EpochDatabase {
  const database = makeDatabase();
  database.snapshotRevision = 205;
  const session = database.sessions[0]!;
  session.state = "HISTORICAL_STALE";
  session.sessionRevision = 8;
  session.activeValidationId = "validation_historical";
  session.activeRefreshPlanId = "refresh_historical_budget";
  session.activePermitId = null;
  const budgetVersion = database.resourceVersions.find(
    (version) => version.resourceId === "resource_budget",
  )!;
  budgetVersion.validUntilSeq = 20;
  const decisionIds = ROLES.map((role) => certificateId(role)) as [
    string,
    string,
    string,
  ];
  const dependencySetHash = snapshotReceiptDependencySetHash(
    ROLES.map((role) => receiptId(role)),
  );
  database.validations = [
    {
      validationId: "validation_historical",
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      baseSessionRevision: 7,
      decisionCertificateIds: decisionIds,
      dependencySetHash,
      validatedHead: HEAD,
      outcome: "HISTORICAL_BUT_STALE_NOW",
      lowerBound: 12,
      upperBound: 20,
      jointValidityCertificateId: null,
      noCutProofId: null,
      refreshPlanId: "refresh_historical_budget",
      verificationLatencyMs: 6,
      createdAt: LATER,
    },
  ];
  database.jointValidityCertificates = [];
  database.permits = [];
  database.refreshPlans = [
    {
      refreshPlanId: "refresh_historical_budget",
      sessionId: SESSION_ID,
      baseSessionRevision: 7,
      validatedHead: HEAD,
      dependencySetHash,
      activeDecisionCertificateIds: decisionIds,
      agentIds: [roleAgentId("budget")],
      status: "AVAILABLE",
      claimedAttemptId: null,
    },
  ];
  database.diagnostics = [
    {
      diagnosticId: "diagnostic_historical",
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      sessionRevision: 8,
      fixtureRef: null,
      kind: "EXPECTED_BLOCK",
      stage: "VALIDATE",
      reasonCode: "HISTORICAL_BUT_STALE_NOW",
      role: null,
      attemptId: null,
      assignmentId: null,
      runId: null,
      artifactRefs: [
        { kind: "VALIDATION", id: "validation_historical" },
        { kind: "REFRESH_PLAN", id: "refresh_historical_budget" },
        { kind: "RECEIPT", id: receiptId("budget") },
      ],
      causedByDiagnosticIds: [],
      expected: null,
      actual: null,
      rejectedOutputArtifactId: null,
      auditSeq: 1,
      recommendedAction: "REOBSERVE_INVALID",
    },
  ];
  database.auditEvents[0]!.status = "HISTORICAL_STALE";
  return EpochDatabaseSchema.parse(database);
}

function makeReobservingDatabase(): EpochDatabase {
  const database = makeNoCutDatabase();
  database.snapshotRevision = 202;
  const session = database.sessions[0]!;
  session.state = "REOBSERVING";
  session.sessionRevision = 5;
  session.activeAttemptIds.budget = attemptId("budget", 2);
  const plan = database.refreshPlans[0]!;
  plan.status = "CLAIMED";
  plan.claimedAttemptId = attemptId("budget", 2);
  const query = database.roleQuerySpecs.find((candidate) => candidate.role === "budget")!;
  database.runAssignments.push({
    assignmentId: assignmentId("budget", 2),
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    agentId: roleAgentId("budget"),
    agentNameAtAssignment: "Budget Agent rerun",
    role: "budget",
    receiptId: receiptId("budget", 2),
    queryHash: query.queryHash,
    roleProfileVersion: "profile_budget_v1",
    promptTemplateVersion: "prompt_budget_v1",
    agentsMdDigest: sha256Digest("agents-md:budget"),
    runtimeLabelAtDispatch: "codex-budget-refresh",
    evidencePackRelativePath: `.epochguard/sessions/${SESSION_ID}/budget/${assignmentId("budget", 2)}.json`,
    evidencePackHash: sha256Digest("evidence-pack:budget:2"),
    boundRunId: runId("budget", 2),
    status: "BOUND",
    consumedByDecisionCertificateId: null,
    createdAt: LATER,
    boundAt: LATER,
    consumedAt: null,
  });
  database.attempts.push({
    attemptId: attemptId("budget", 2),
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    role: "budget",
    agentId: roleAgentId("budget"),
    assignmentId: assignmentId("budget", 2),
    runId: runId("budget", 2),
    status: "RUNNING",
    runStartedAt: LATER,
    runCompletedAt: null,
    threadId: "thread_budget_2",
    usage: null,
    outputDigest: null,
  });
  database.auditEvents[0]!.status = "REOBSERVING";
  return EpochDatabaseSchema.parse(database);
}

function makeFailedDatabase(): EpochDatabase {
  const database = makeReobservingDatabase();
  database.snapshotRevision = 203;
  const session = database.sessions[0]!;
  session.state = "FAILED";
  session.sessionRevision = 6;
  const failedAttempt = database.attempts.find(
    (attempt) => attempt.attemptId === attemptId("budget", 2),
  )!;
  failedAttempt.status = "FAILED";
  failedAttempt.runCompletedAt = "2026-08-29T12:02:00.000Z";
  const failedAssignment = database.runAssignments.find(
    (assignment) => assignment.assignmentId === assignmentId("budget", 2),
  )!;
  failedAssignment.status = "REJECTED";
  database.diagnostics.push({
    diagnosticId: "diagnostic_run_failed",
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    sessionRevision: 6,
    fixtureRef: null,
    kind: "SYSTEM_FAILURE",
    stage: "RUN",
    reasonCode: "RUN_FAILED",
    role: "budget",
    attemptId: attemptId("budget", 2),
    assignmentId: assignmentId("budget", 2),
    runId: runId("budget", 2),
    artifactRefs: [
      { kind: "ATTEMPT", id: attemptId("budget", 2) },
      { kind: "ASSIGNMENT", id: assignmentId("budget", 2) },
      { kind: "RUN", id: runId("budget", 2) },
    ],
    causedByDiagnosticIds: ["diagnostic_no_cut"],
    expected: null,
    actual: null,
    rejectedOutputArtifactId: null,
    auditSeq: 2,
    recommendedAction: "NEW_SESSION",
  });
  database.auditEvents[0]!.status = "FAILED";
  return EpochDatabaseSchema.parse(database);
}

function makeRecoveredDenyDatabase(): EpochDatabase {
  const database = makeNoCutDatabase();
  database.snapshotRevision = 204;
  const session = database.sessions[0]!;
  session.state = "CONSISTENT_DENY";
  session.sessionRevision = 8;
  session.activeDecisionCertificateIds.budget = certificateId("budget", 2);
  session.activeAttemptIds.budget = null;
  session.activeValidationId = "validation_recovered_deny";
  session.activePermitId = null;

  const oldBudgetDecision = database.decisions.find(
    (decision) => decision.certificateId === certificateId("budget"),
  )!;
  oldBudgetDecision.status = "SUPERSEDED";
  oldBudgetDecision.supersededByCertificateId = certificateId("budget", 2);
  const query = database.roleQuerySpecs.find((candidate) => candidate.role === "budget")!;
  const refreshedValue = { remainingBudgetCents: 100_000 };
  const refreshedValueHash = sha256Digest(canonicalJson(refreshedValue));
  database.resourceVersions.push({
    id: "version_budget_2",
    resourceId: "resource_budget",
    sourceRevision: 20,
    value: refreshedValue,
    valueHash: refreshedValueHash,
    validFromSeq: 20,
    validUntilSeq: null,
  });
  database.runAssignments.push({
    assignmentId: assignmentId("budget", 2),
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    agentId: roleAgentId("budget"),
    agentNameAtAssignment: "Budget Agent rerun",
    role: "budget",
    receiptId: receiptId("budget", 2),
    queryHash: query.queryHash,
    roleProfileVersion: "profile_budget_v1",
    promptTemplateVersion: "prompt_budget_v1",
    agentsMdDigest: sha256Digest("agents-md:budget"),
    runtimeLabelAtDispatch: "codex-budget-refresh",
    evidencePackRelativePath: `.epochguard/sessions/${SESSION_ID}/budget/${assignmentId("budget", 2)}.json`,
    evidencePackHash: sha256Digest("evidence-pack:budget:2"),
    boundRunId: runId("budget", 2),
    status: "CONSUMED",
    consumedByDecisionCertificateId: certificateId("budget", 2),
    createdAt: LATER,
    boundAt: LATER,
    consumedAt: "2026-08-29T12:02:00.000Z",
  });
  database.attempts.push({
    attemptId: attemptId("budget", 2),
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    role: "budget",
    agentId: roleAgentId("budget"),
    assignmentId: assignmentId("budget", 2),
    runId: runId("budget", 2),
    status: "ACCEPTED",
    runStartedAt: LATER,
    runCompletedAt: "2026-08-29T12:02:00.000Z",
    threadId: "thread_budget_2",
    usage: { inputTokens: 101, outputTokens: 21 },
    outputDigest: sha256Digest("output:budget:2"),
  });
  database.receipts.push({
    schemaVersion: 1,
    receiptId: receiptId("budget", 2),
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    agentId: roleAgentId("budget"),
    runAssignmentId: assignmentId("budget", 2),
    role: "budget",
    source: "budget",
    entityKey: query.entityKey,
    queryHash: query.queryHash,
    sourceRevision: 20,
    valueHash: refreshedValueHash,
    observedAtSeq: HEAD,
    nonce: "nonce-budget-refresh".padEnd(40, "x"),
    issuer: "epochguard",
    issuedAt: "2026-08-29T12:02:00.000Z",
  });
  database.decisions.push({
    certificateId: certificateId("budget", 2),
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    agentId: roleAgentId("budget"),
    runAssignmentId: assignmentId("budget", 2),
    runId: runId("budget", 2),
    role: "budget",
    verdict: "DENY",
    receiptIds: [receiptId("budget", 2)],
    decisionDigest: sha256Digest("decision:budget:2:DENY"),
    status: "ACTIVE",
    supersededByCertificateId: null,
    constructedBy: "epochguard",
    createdAt: "2026-08-29T12:02:00.000Z",
  });

  const activeDecisionIds = [
    certificateId("inventory"),
    certificateId("budget", 2),
    certificateId("policy"),
  ] as [string, string, string];
  const activeReceiptIds = [
    receiptId("inventory"),
    receiptId("budget", 2),
    receiptId("policy"),
  ];
  const dependencySetHash = snapshotReceiptDependencySetHash(activeReceiptIds);
  database.validations.push({
    validationId: "validation_recovered_deny",
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    baseSessionRevision: 7,
    decisionCertificateIds: activeDecisionIds,
    dependencySetHash,
    validatedHead: HEAD,
    outcome: "CONSISTENT_DENY",
    lowerBound: 21,
    upperBound: HEAD + 1,
    jointValidityCertificateId: "jvc_recovered_deny",
    noCutProofId: null,
    refreshPlanId: "refresh_budget",
    verificationLatencyMs: 8,
    createdAt: "2026-08-29T12:02:00.000Z",
  });
  database.jointValidityCertificates = [
    {
      certificateId: "jvc_recovered_deny",
      validationId: "validation_recovered_deny",
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      dependencySetHash,
      validatedAtHead: HEAD,
      selectedCutSeq: HEAD,
      currentHeadCovered: true,
      decisionCertificateIds: activeDecisionIds,
      intervals: [
        {
          receiptId: receiptId("inventory"),
          source: "inventory",
          sourceRevision: NO_CUT_EVIDENCE.inventory.sourceRevision,
          from: NO_CUT_EVIDENCE.inventory.validFromSeq,
          until: NO_CUT_EVIDENCE.inventory.validUntilSeq,
        },
        {
          receiptId: receiptId("budget", 2),
          source: "budget",
          sourceRevision: 20,
          from: 20,
          until: null,
        },
        {
          receiptId: receiptId("policy"),
          source: "policy",
          sourceRevision: NO_CUT_EVIDENCE.policy.sourceRevision,
          from: NO_CUT_EVIDENCE.policy.validFromSeq,
          until: NO_CUT_EVIDENCE.policy.validUntilSeq,
        },
      ],
      validatorVersion: "epochguard-jv-v1",
      createdAt: "2026-08-29T12:02:00.000Z",
    },
  ];
  const plan = database.refreshPlans[0]!;
  plan.status = "COMPLETED";
  plan.claimedAttemptId = attemptId("budget", 2);
  database.diagnostics.push({
    diagnosticId: "diagnostic_recovered_deny",
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    sessionRevision: 8,
    fixtureRef: "impossible-collage-v1",
    kind: "EXPECTED_BLOCK",
    stage: "VALIDATE",
    reasonCode: "CONSISTENT_DENY",
    role: null,
    attemptId: null,
    assignmentId: null,
    runId: null,
    artifactRefs: [
      { kind: "VALIDATION", id: "validation_recovered_deny" },
      { kind: "REFRESH_PLAN", id: "refresh_budget" },
      { kind: "RECEIPT", id: receiptId("budget", 2) },
    ],
    causedByDiagnosticIds: ["diagnostic_no_cut"],
    expected: null,
    actual: null,
    rejectedOutputArtifactId: null,
    auditSeq: 2,
    recommendedAction: "NONE",
  });
  database.auditEvents[0]!.status = "CONSISTENT_DENY";
  return EpochDatabaseSchema.parse(database);
}

function makeCommittedDatabase(): EpochDatabase {
  const database = makeDatabase();
  database.snapshotRevision = 301;
  const session = database.sessions[0]!;
  session.state = "COMMITTED";
  session.sessionRevision = 10;
  const permit = database.permits[0]!;
  permit.status = "CONSUMED";
  permit.consumedAt = "2026-08-29T12:03:00.000Z";
  database.effects = [
    {
      effectId: "effect_campaign",
      type: "PUBLISH_CAMPAIGN",
      idempotencyKey: ACTION.idempotencyKey,
      permitId: permit.permitId,
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      dependencySetHash: permit.dependencySetHash,
      jointValidityCertificateId: permit.jointValidityCertificateId,
      createdAt: "2026-08-29T12:03:00.000Z",
    },
  ];
  database.auditEvents[0]!.status = "COMMITTED";
  return EpochDatabaseSchema.parse(database);
}

function snapshot(database: EpochDatabase, generatedAt = NOW) {
  return buildSessionDashboardSnapshotFromSnapshot(database, SESSION_ID, generatedAt);
}

describe("SessionViewBuilder golden projections", () => {
  it.each([
    ["collecting", makeCollectingDatabase, "COLLECTING", "WAITING", "PENDING", 0],
    ["ready", makeDatabase, "READY_AT_CURRENT_HEAD", "READY", "VALID_CURRENT", 0],
    ["no-cut", makeNoCutDatabase, "BLOCKED_NO_CUT", "LOCKED", "NO_CUT", 0],
    ["reobserving", makeReobservingDatabase, "REOBSERVING", "LOCKED", "NO_CUT", 0],
    [
      "deny",
      makeRecoveredDenyDatabase,
      "CONSISTENT_DENY",
      "LOCKED",
      "VALID_CURRENT",
      0,
    ],
    ["committed", makeCommittedDatabase, "COMMITTED", "RELEASED", "VALID_CURRENT", 1],
    ["failed", makeFailedDatabase, "FAILED", "FAILED", "NO_CUT", 0],
  ])(
    "builds the %s golden state through the frozen decoder",
    (_name, factory, sessionState, gateState, validityState, effects) => {
      const result = snapshot(factory());
      expect(decodeSessionDashboardSnapshot(result)).toEqual(result);
      expect(result.sessionState).toBe(sessionState);
      expect(result.gate.state).toBe(gateState);
      expect(result.jointValidity.state).toBe(validityState);
      expect(result.gate.effectsInSession).toBe(effects);
    },
  );

  it("derives canonical no-cut witness and keeps proofId stable across GETs", () => {
    const database = makeNoCutDatabase();
    const first = snapshot(structuredClone(database), NOW);
    const second = snapshot(structuredClone(database), LATER);

    expect(first.jointValidity.noCutProof?.proofId).toBe("proof_no_cut");
    expect(second.jointValidity.noCutProof?.proofId).toBe("proof_no_cut");
    expect(first.generatedAt).not.toBe(second.generatedAt);
    expect(first.jointValidity.noCutProof?.witness).toEqual([
      {
        role: "budget",
        receiptId: receiptId("budget"),
        from: 19,
        until: 20,
      },
      {
        role: "policy",
        receiptId: receiptId("policy"),
        from: 21,
        until: null,
      },
    ]);
  });

  it("keeps retained activeDecision separate from the new inFlightAttempt", () => {
    const result = snapshot(makeReobservingDatabase());
    const budget = result.agents.find((agent) => agent.role === "budget")!;

    expect(budget.activeDecision?.runId).toBe(runId("budget"));
    expect(budget.activeDecision?.receipt.receiptId).toBe(receiptId("budget"));
    expect(budget.activeDecision?.runtimeProof.assignmentId).toBe(
      assignmentId("budget"),
    );
    expect(budget.inFlightAttempt).toMatchObject({
      attemptId: attemptId("budget", 2),
      assignmentId: assignmentId("budget", 2),
      runId: runId("budget", 2),
      status: "RUNNING",
    });
    expect(budget.inFlightAttempt?.runId).not.toBe(budget.activeDecision?.runId);
  });

  it("projects the recovered DENY from only the refreshed Budget evidence", () => {
    const result = snapshot(makeRecoveredDenyDatabase());
    expect(result.refreshPlan).toMatchObject({
      refreshPlanId: "refresh_budget",
      status: "COMPLETED",
      agentIds: [roleAgentId("budget")],
    });
    expect(result.metrics).toMatchObject({
      reobservedAgents: 1,
      rerunsAvoided: 2,
      denyDecisions: 1,
    });
    expect(result.agents.map((agent) => [agent.role, agent.runCount])).toEqual([
      ["inventory", 1],
      ["budget", 2],
      ["policy", 1],
    ]);
    expect(result.agents[1]!.activeDecision).toMatchObject({
      certificateId: certificateId("budget", 2),
      runId: runId("budget", 2),
      verdict: "DENY",
      evidenceState: "CURRENT",
    });
    expect(result.agents[1]!.inFlightAttempt).toBeNull();
  });

  it("projects terminal RUN diagnostic refs from the failed mirrored Attempt", () => {
    const result = snapshot(makeFailedDatabase());
    expect(result.latestDiagnostics[0]).toMatchObject({
      diagnosticId: "diagnostic_run_failed",
      stage: "RUN",
      reasonCode: "RUN_FAILED",
      role: "budget",
      relevantIds: [
        { kind: "ATTEMPT", id: attemptId("budget", 2) },
        { kind: "ASSIGNMENT", id: assignmentId("budget", 2) },
        { kind: "RUN", id: runId("budget", 2) },
      ],
    });
    expect(result.gate.reasonCode).toBe("RUN_FAILED");
  });
});

describe("single-snapshot isolation and fail-closed projection", () => {
  it.each([
    ["READY", () => makeDatabase()],
    ["COMMITTED", () => makeCommittedDatabase()],
  ] as const)(
    "requires complete active Decision evidence in %s projection",
    (_state, factory) => {
      const valid = snapshot(factory());
      for (const agent of valid.agents) {
        expect(agent.activeDecision?.runtimeProof.outputDigest).toMatch(
          /^sha256:[0-9a-f]{64}$/,
        );
      }

      const corruptions: Array<{
        name: string;
        apply: (database: EpochDatabase) => void;
      }> = [
        {
          name: "ACTIVE Decision carries a superseded pointer",
          apply: (database) => {
            database.decisions[0]!.supersededByCertificateId =
              "decision_fictional_replacement";
          },
        },
        {
          name: "CONSUMED Assignment has no consumedAt",
          apply: (database) => {
            database.runAssignments[0]!.consumedAt = null;
          },
        },
        {
          name: "ACCEPTED Attempt has no outputDigest",
          apply: (database) => {
            database.attempts[0]!.outputDigest = null;
          },
        },
      ];
      for (const corruption of corruptions) {
        const database = factory();
        corruption.apply(database);
        expect(() => snapshot(database), corruption.name).toThrowError(
          SessionViewBuilderError,
        );
      }
    },
  );

  it("rejects damaged Effect-to-Permit consumption ledgers", () => {
    const corruptions: Array<{
      name: string;
      apply: (database: EpochDatabase) => void;
    }> = [
      {
        name: "Permit idempotency differs from Action",
        apply: (database) => {
          database.permits[0]!.idempotencyKey = "fictional-permit-key";
        },
      },
      {
        name: "Effect idempotency differs from Permit and Action",
        apply: (database) => {
          database.effects[0]!.idempotencyKey = "fictional-effect-key";
        },
      },
      {
        name: "CONSUMED Permit has no consumedAt",
        apply: (database) => {
          database.permits[0]!.consumedAt = null;
        },
      },
      {
        name: "inactive CONSUMED Permit has no Effect closure",
        apply: (database) => {
          database.permits.push({
            ...database.permits[0]!,
            permitId: "permit_orphan_consumed",
          });
        },
      },
      {
        name: "Effect is not atomically timestamped with Permit consumption",
        apply: (database) => {
          database.effects[0]!.createdAt = "2026-08-29T12:04:00.000Z";
        },
      },
      {
        name: "another Session reuses the consumed Permit",
        apply: (database) => {
          database.effects.push({
            ...database.effects[0]!,
            effectId: "effect_fictional_duplicate",
            sessionId: "session_fictional_other",
          });
        },
      },
    ];

    for (const corruption of corruptions) {
      const database = makeCommittedDatabase();
      corruption.apply(database);
      expect(() => snapshot(database), corruption.name).toThrowError(
        SessionViewBuilderError,
      );
    }
  });

  it("reads Store once, clones immediately, and cannot mix a concurrently mutated revision", () => {
    const firstRevision = makeDatabase();
    const nextRevision = makeCommittedDatabase();
    let liveStoreValue = firstRevision;
    let calls = 0;
    const store = {
      snapshot(): unknown {
        calls += 1;
        if (calls > 1) throw new Error("second snapshot read is forbidden");
        const returnedLiveObject = liveStoreValue;
        return returnedLiveObject;
      },
    };
    const builder = new SessionViewBuilder(store, () => {
      // This simulates a concurrent writer replacing and mutating Store state
      // after the sole read but before projection begins.
      liveStoreValue = nextRevision;
      Object.assign(firstRevision, structuredClone(nextRevision));
      return NOW;
    });

    const result = builder.build(SESSION_ID);
    expect(calls).toBe(1);
    expect(result.snapshotRevision).toBe(101);
    expect(result.sessionState).toBe("READY_AT_CURRENT_HEAD");
    expect(result.gate).toMatchObject({
      state: "READY",
      effectsInSession: 0,
      effectId: null,
    });
    expect(liveStoreValue.snapshotRevision).toBe(301);
  });

  it("fails closed on unknown EpochStore schema", () => {
    const invalid = { ...makeDatabase(), schemaVersion: 2 };
    expect(() => snapshot(invalid as unknown as EpochDatabase)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_SCHEMA" }),
    );
  });

  it("fails closed when contract-v6 rejects the final candidate", () => {
    expect(() => snapshot(makeDatabase(), "not-an-iso-timestamp")).toThrowError(
      expect.objectContaining({ code: "PROJECTION_MISMATCH" }),
    );
  });

  it("fails closed when stored proof conflicts with the canonical witness", () => {
    const database = makeNoCutDatabase();
    database.noCutProofs[0]!.conflictWitnessReceiptIds = [
      receiptId("policy"),
      receiptId("budget"),
    ];
    expect(() => snapshot(database)).toThrowError(SessionViewBuilderError);
  });

  it("rejects Validation A combined with Proof B and arbitrary same-Session Receipts", () => {
    const database = makeNoCutDatabase();
    database.noCutProofs.push({
      ...database.noCutProofs[0]!,
      proofId: "proof_unrelated",
      validationId: "validation_unrelated",
    });
    database.diagnostics[0]!.artifactRefs = [
      { kind: "VALIDATION", id: "validation_no_cut" },
      { kind: "PROOF", id: "proof_unrelated" },
      { kind: "RECEIPT", id: receiptId("inventory") },
      { kind: "RECEIPT", id: receiptId("budget") },
      { kind: "REFRESH_PLAN", id: "refresh_budget" },
    ];

    expect(() => snapshot(database)).toThrowError(SessionViewBuilderError);
  });

  it("rejects missing, duplicate, and unrelated No-Cut closure refs", () => {
    const missingPlan = makeNoCutDatabase();
    missingPlan.diagnostics[0]!.artifactRefs =
      missingPlan.diagnostics[0]!.artifactRefs.filter(
        (reference) => reference.kind !== "REFRESH_PLAN",
      );
    expect(() => snapshot(missingPlan)).toThrowError(SessionViewBuilderError);

    const duplicate = makeNoCutDatabase();
    duplicate.diagnostics[0]!.artifactRefs.push({
      kind: "VALIDATION",
      id: "validation_no_cut",
    });
    expect(() => snapshot(duplicate)).toThrowError(SessionViewBuilderError);

    const unrelatedReceipt = makeNoCutDatabase();
    unrelatedReceipt.diagnostics[0]!.artifactRefs =
      unrelatedReceipt.diagnostics[0]!.artifactRefs.map((reference) =>
        reference.kind === "RECEIPT" && reference.id === receiptId("policy")
          ? { kind: "RECEIPT", id: receiptId("inventory") }
          : reference,
      );
    expect(() => snapshot(unrelatedReceipt)).toThrowError(
      SessionViewBuilderError,
    );
  });

  it("rejects future-head and forged No-Cut RefreshPlan owner closures", () => {
    const corruptions: Array<{
      name: string;
      apply: (database: EpochDatabase) => void;
    }> = [
      {
        name: "future validated head",
        apply: (database) => {
          database.validations[0]!.validatedHead = HEAD + 1;
          database.noCutProofs[0]!.validatedAtHead = HEAD + 1;
          database.refreshPlans[0]!.validatedHead = HEAD + 1;
        },
      },
      {
        name: "Proof refresh owner differs from canonical invalid owner",
        apply: (database) => {
          database.noCutProofs[0]!.refreshAgentIds = [
            roleAgentId("inventory"),
          ];
        },
      },
      {
        name: "RefreshPlan base revision differs from Validation",
        apply: (database) => {
          database.refreshPlans[0]!.baseSessionRevision += 1;
        },
      },
      {
        name: "RefreshPlan dependency differs from Validation",
        apply: (database) => {
          database.refreshPlans[0]!.dependencySetHash = sha256Digest(
            "fictional refresh dependency",
          );
        },
      },
      {
        name: "RefreshPlan Decision tuple is reordered",
        apply: (database) => {
          database.refreshPlans[0]!.activeDecisionCertificateIds = [
            certificateId("budget"),
            certificateId("inventory"),
            certificateId("policy"),
          ];
        },
      },
      {
        name: "RefreshPlan owner differs from invalid evidence owner",
        apply: (database) => {
          database.refreshPlans[0]!.agentIds = [roleAgentId("inventory")];
        },
      },
    ];

    for (const corruption of corruptions) {
      const database = makeNoCutDatabase();
      corruption.apply(database);
      expect(() => snapshot(database), corruption.name).toThrowError(
        SessionViewBuilderError,
      );
    }
  });

  it("closes historical-stale and consistent-DENY reason semantics", () => {
    expect(() => snapshot(makeHistoricalStaleDatabase())).not.toThrow();
    expect(() =>
      snapshot(
        makeDatabase({
          inventory: "ALLOW",
          budget: "ALLOW",
          policy: "DENY",
        }),
      ),
    ).not.toThrow();

    const forgedHistorical = makeHistoricalStaleDatabase();
    forgedHistorical.refreshPlans[0]!.agentIds = [roleAgentId("inventory")];
    expect(() => snapshot(forgedHistorical)).toThrowError(
      SessionViewBuilderError,
    );

    const forgedDenyOutcome = makeRecoveredDenyDatabase();
    forgedDenyOutcome.validations.find(
      (validation) => validation.validationId === "validation_recovered_deny",
    )!.outcome = "VALID_CURRENT_ALLOW";
    expect(() => snapshot(forgedDenyOutcome)).toThrowError(
      SessionViewBuilderError,
    );

    const unrelatedDenyReceipt = makeRecoveredDenyDatabase();
    unrelatedDenyReceipt.diagnostics.find(
      (diagnostic) => diagnostic.diagnosticId === "diagnostic_recovered_deny",
    )!.artifactRefs = [
      { kind: "VALIDATION", id: "validation_recovered_deny" },
      { kind: "REFRESH_PLAN", id: "refresh_budget" },
      { kind: "RECEIPT", id: receiptId("inventory") },
    ];
    expect(() => snapshot(unrelatedDenyReceipt)).toThrowError(
      SessionViewBuilderError,
    );
  });

  it("accepts the authoritative COMMIT_RACE chain and rejects an unrelated Permit", () => {
    const diagnostic = {
      diagnosticId: "diagnostic_commit_race",
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      sessionRevision: 9,
      fixtureRef: null,
      kind: "TRANSIENT_RACE" as const,
      stage: "COMMIT" as const,
      reasonCode: "COMMIT_RACE" as const,
      role: null,
      attemptId: null,
      assignmentId: null,
      runId: null,
      artifactRefs: [
        { kind: "VALIDATION" as const, id: "validation_current" },
        { kind: "PERMIT" as const, id: "permit_current" },
      ],
      causedByDiagnosticIds: [],
      expected: null,
      actual: null,
      rejectedOutputArtifactId: null,
      auditSeq: 2,
      recommendedAction: "NONE" as const,
    };
    const makeRaceDatabase = (): EpochDatabase => {
      const database = makeDatabase();
      database.snapshotRevision = 401;
      database.headSeq = HEAD + 1;
      database.resourceVersions[0]!.validUntilSeq = HEAD + 1;
      const session = database.sessions[0]!;
      session.state = "COMMIT_RACE";
      session.sessionRevision = 9;
      session.activePermitId = null;
      session.stateUpdatedAt = "2026-08-29T12:02:00.000Z";
      database.permits[0]!.status = "REVOKED";
      database.permits[0]!.consumedAt = null;
      database.diagnostics.push(diagnostic);
      database.auditEvents.push({
        eventId: "event_commit_race",
        sessionId: SESSION_ID,
        actionHash: GOLDEN_ACTION_HASH,
        sessionRevision: 9,
        auditSeq: 11,
        type: "SESSION_STATE",
        status: "COMMIT_RACE",
        role: null,
        artifactRefs: [
          { kind: "VALIDATION", id: "validation_current" },
          { kind: "PERMIT", id: "permit_current" },
        ],
        createdAt: "2026-08-29T12:02:00.000Z",
      });
      return database;
    };

    const valid = makeRaceDatabase();
    expect(() => snapshot(valid)).not.toThrow();

    const retainedRevokedPermitPointer = makeRaceDatabase();
    retainedRevokedPermitPointer.sessions[0]!.activePermitId = "permit_current";
    expect(() => snapshot(retainedRevokedPermitPointer)).not.toThrow();

    const corruptions: Array<{
      name: string;
      apply: (database: EpochDatabase) => void;
    }> = [
      {
        name: "one Decision is not ALLOW",
        apply: (database) => {
          database.decisions[0]!.verdict = "DENY";
        },
      },
      {
        name: "Validation L is forged",
        apply: (database) => {
          database.validations[0]!.lowerBound! += 1;
        },
      },
      {
        name: "JVC Receipt interval is forged",
        apply: (database) => {
          database.jointValidityCertificates[0]!.intervals[0]!.from += 1;
        },
      },
      {
        name: "JVC Receipt interval is missing",
        apply: (database) => {
          database.jointValidityCertificates[0]!.intervals.pop();
        },
      },
      {
        name: "JVC selectedCut is not the validated head",
        apply: (database) => {
          database.jointValidityCertificates[0]!.selectedCutSeq = HEAD - 1;
        },
      },
      {
        name: "JVC denies current-head coverage",
        apply: (database) => {
          database.jointValidityCertificates[0]!.currentHeadCovered = false;
        },
      },
      {
        name: "frozen registration digest differs",
        apply: (database) => {
          database.roleAgentRegistrations[0]!.agentsMdDigest =
            sha256Digest("fictional changed registration");
        },
      },
      {
        name: "Permit idempotency differs from Action",
        apply: (database) => {
          database.permits[0]!.idempotencyKey = "fictional-race-key";
        },
      },
      {
        name: "Permit was not revoked",
        apply: (database) => {
          database.permits[0]!.status = "ISSUED";
        },
      },
      {
        name: "Permit predates its Validation and JVC",
        apply: (database) => {
          database.permits[0]!.issuedAt = "2026-08-29T11:59:59.000Z";
        },
      },
      {
        name: "active Permit pointer names an unrelated ledger entry",
        apply: (database) => {
          database.permits.push({
            ...database.permits[0]!,
            permitId: "permit_unrelated_pointer",
            dependencySetHash: sha256Digest("unrelated pointer dependency"),
            jointValidityCertificateId: "jvc_unrelated_pointer",
          });
          database.sessions[0]!.activePermitId = "permit_unrelated_pointer";
        },
      },
      {
        name: "race lifecycle event is missing",
        apply: (database) => {
          database.auditEvents = database.auditEvents.filter(
            (event) => event.eventId !== "event_commit_race",
          );
        },
      },
      {
        name: "race lifecycle event references another Permit",
        apply: (database) => {
          database.auditEvents.at(-1)!.artifactRefs[1] = {
            kind: "PERMIT",
            id: "permit_unrelated_event",
          };
        },
      },
    ];
    for (const corruption of corruptions) {
      const database = makeRaceDatabase();
      corruption.apply(database);
      expect(
        () => assertSafetyDiagnosticCausalChains(database, SESSION_ID),
        corruption.name,
      ).toThrowError(SafetyDiagnosticIntegrityError);
    }

    const unrelated = makeRaceDatabase();
    unrelated.permits.push({
      ...unrelated.permits[0]!,
      permitId: "permit_unrelated",
      dependencySetHash: sha256Digest("unrelated dependency set"),
      jointValidityCertificateId: "jvc_unrelated",
    });
    unrelated.diagnostics[0]!.artifactRefs = [
      { kind: "VALIDATION", id: "validation_current" },
      { kind: "PERMIT", id: "permit_unrelated" },
    ];

    expect(() => snapshot(unrelated)).toThrowError(SessionViewBuilderError);
  });

  it("rejects an old claimed Attempt when the active pointer names the rerun", () => {
    const database = makeReobservingDatabase();
    database.refreshPlans[0]!.claimedAttemptId = attemptId("budget");

    expect(() => snapshot(database)).toThrowError(SessionViewBuilderError);
  });

  it("rejects a claimed Attempt from another action", () => {
    const database = makeReobservingDatabase();
    const activeAttempt = database.attempts.find(
      (attempt) => attempt.attemptId === attemptId("budget", 2),
    )!;
    database.attempts.push({
      ...activeAttempt,
      attemptId: "attempt_budget_cross_action",
      actionHash: sha256Digest("different action"),
    });
    database.refreshPlans[0]!.claimedAttemptId = "attempt_budget_cross_action";

    expect(() => snapshot(database)).toThrowError(SessionViewBuilderError);
  });

  it("rejects a claimed Attempt with a cross-role owner binding", () => {
    const database = makeReobservingDatabase();
    const activeAttempt = database.attempts.find(
      (attempt) => attempt.attemptId === attemptId("budget", 2),
    )!;
    database.attempts.push({
      ...activeAttempt,
      attemptId: "attempt_budget_cross_role",
      role: "inventory",
    });
    database.refreshPlans[0]!.claimedAttemptId = "attempt_budget_cross_role";

    expect(() => snapshot(database)).toThrowError(SessionViewBuilderError);
  });
});

describe("fixed redaction boundary", () => {
  it("redacts bare lowercase 64-hex while preserving typed digest and ID fields", () => {
    const freeTextHex64 = "a3c7e1f5".repeat(8);
    const structuredIdHex64 = "b4d8f2a6".repeat(8);
    const database = makeDatabase();
    database.runAssignments[0]!.agentNameAtAssignment = freeTextHex64;
    database.attempts[2]!.threadId = structuredIdHex64;

    const result = snapshot(database);
    expect(JSON.stringify(result)).not.toContain(freeTextHex64);
    expect(result.agents[0]!.agentNameAtAssignment).toBe("inventory Agent");
    expect(result.agents[2]!.activeDecision?.runtimeProof.threadId).toBe(
      structuredIdHex64,
    );
    expect(result.actionHash).toBe(GOLDEN_ACTION_HASH);
    expect(result.agents[2]!.activeDecision?.runtimeProof.outputDigest).toBe(
      database.attempts[2]!.outputDigest,
    );
  });

  it("redacts bare 32/40-hex secrets only from free display text", () => {
    const freeAgentHex32 = "a7c3e9f1".repeat(4);
    const freeRuntimeHex40 = "b8d4f0a2".repeat(5);
    const freeEventTypeHex32 = "c9e5a1b3".repeat(4);
    const freeEventStatusHex40 = "d0f6b2c4".repeat(5);
    const structuredThreadHex32 = "e1a7c3d5".repeat(4);
    const structuredEventHex40 = "f2b8d4e6".repeat(5);
    const database = makeDatabase();
    database.runAssignments[0]!.agentNameAtAssignment = freeAgentHex32;
    database.runAssignments[1]!.runtimeLabelAtDispatch = freeRuntimeHex40;
    database.auditEvents[0]!.type = freeEventTypeHex32;
    database.auditEvents[0]!.status = freeEventStatusHex40;
    database.attempts[2]!.threadId = structuredThreadHex32;
    database.auditEvents[0]!.eventId = structuredEventHex40;

    const result = snapshot(database);
    const serialized = JSON.stringify(result);
    for (const secret of [
      freeAgentHex32,
      freeRuntimeHex40,
      freeEventTypeHex32,
      freeEventStatusHex40,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(result.agents[0]!.agentNameAtAssignment).toBe("inventory Agent");
    expect(result.agents[1]!.activeDecision?.runtimeProof.runtimeLabel).toBe(
      "redacted-runtime",
    );
    expect(result.events[0]).toMatchObject({
      eventId: structuredEventHex40,
      type: "EVENT",
      status: "REDACTED",
      summary: "Session: EVENT REDACTED",
    });
    expect(result.agents[2]!.activeDecision?.runtimeProof.threadId).toBe(
      structuredThreadHex32,
    );
  });

  it("redacts fictitious Basic Authorization material from public text", () => {
    const database = makeDatabase();
    const placeholder = "Basic RklDVElUSU9VU1BST1hZ";
    database.runAssignments[0]!.runtimeLabelAtDispatch = placeholder;

    const result = snapshot(database);
    expect(JSON.stringify(result)).not.toContain(placeholder);
    expect(result.agents[0]!.activeDecision?.runtimeProof.runtimeLabel).toBe(
      "redacted-runtime",
    );
  });

  it("allows a Crockford ID only in explicit system-ID fields", () => {
    const placeholderUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const database = makeDatabase();
    database.runAssignments[0]!.agentNameAtAssignment = placeholderUlid;
    database.auditEvents[0]!.status = placeholderUlid;
    database.attempts[2]!.threadId = placeholderUlid;

    const result = snapshot(database);
    expect(result.agents[0]!.agentNameAtAssignment).toBe("inventory Agent");
    expect(result.events[0]!.status).toBe("REDACTED");
    expect(result.agents[2]!.activeDecision?.runtimeProof.threadId).toBe(
      placeholderUlid,
    );
  });

  it("redacts a bare GitHub PAT from an Agent display name", () => {
    const database = makeDatabase();
    const secret = `ghp_${"Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8Tu0Vw1Xy"}`;
    database.runAssignments[0]!.agentNameAtAssignment = secret;

    const result = snapshot(database);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.agents[0]!.agentNameAtAssignment).toBe("inventory Agent");
  });

  it("redacts a github_pat token from a runtime label", () => {
    const database = makeDatabase();
    const secret = `github_pat_${"Ab1_Cd2_Ef3_Gh4_Jk5_Mn6_Pq7_Rs8"}`;
    database.runAssignments[1]!.runtimeLabelAtDispatch = secret;

    const result = snapshot(database);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.agents[1]!.activeDecision?.runtimeProof.runtimeLabel).toBe(
      "redacted-runtime",
    );
  });

  it("redacts a Bearer credential from a thread field", () => {
    const database = makeDatabase();
    const secret = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJlZzA1In0.signature";
    database.attempts[2]!.threadId = secret;

    const result = snapshot(database);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.agents[2]!.activeDecision?.runtimeProof.threadId).toBeNull();
  });

  it("redacts private-key material from an event token", () => {
    const database = makeDatabase();
    const secret = "-----BEGIN PRIVATE KEY-----";
    database.auditEvents[0]!.type = secret;

    const result = snapshot(database);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.events[0]!.type).toBe("EVENT");
  });

  it("redacts an unknown high-entropy value from an event status", () => {
    const database = makeDatabase();
    const secret = "aB3dE5fG7hJ9kL2mN4pQ6rS8tV0wX1yZ";
    database.auditEvents[0]!.status = secret;

    const result = snapshot(database);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.events[0]!.status).toBe("REDACTED");
  });

  it("keeps secrets, env dumps, absolute paths, prompts, and raw output out", () => {
    const database = makeDatabase();
    database.runAssignments[0]!.agentNameAtAssignment =
      "C:\\Users\\Alice\\secrets.env";
    database.runAssignments[1]!.runtimeLabelAtDispatch =
      "OPENAI_API_KEY=sk-topsecret-value";
    database.runAssignments[2]!.roleProfileVersion = "API_KEY_SENTINEL";
    database.runAssignments[2]!.promptTemplateVersion = "RAW_PROMPT_SENTINEL";
    database.attempts[2]!.threadId =
      "<EPOCH_DECISION> RAW_OUTPUT_SENTINEL Bearer abcdefgh";
    database.auditEvents[0]!.type = "ENV_DUMP_SENTINEL";
    database.auditEvents[0]!.status = "password=hunter2";
    database.worldCommits.push({
      seq: HEAD,
      changes: [
        {
          resourceId: "resource_inventory",
          previousVersionId: null,
          nextVersionId: "version_inventory_1",
        },
      ],
      reason: "/home/alice/.env ABSOLUTE_PATH_SENTINEL",
      createdAt: NOW,
    });
    const inventoryVersion = database.resourceVersions.find(
      (version) => version.resourceId === "resource_inventory",
    )!;
    inventoryVersion.value = {
      availableUnits: 4,
      rawPrompt: "You are the Inventory Agent RAW_PROMPT_SENTINEL",
      environment: "OPENAI_API_KEY=sk-resource-secret",
    };
    inventoryVersion.valueHash = sha256Digest(canonicalJson(inventoryVersion.value));
    database.receipts.find((receipt) => receipt.role === "inventory")!.valueHash =
      inventoryVersion.valueHash;
    database.diagnostics.push({
      diagnosticId: "diagnostic_redaction",
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      sessionRevision: 8,
      fixtureRef: "C:\\workspace\\RAW_OUTPUT_SENTINEL.txt",
      kind: "SYSTEM_FAILURE",
      stage: "PROJECTION",
      reasonCode: "PROJECTION_MISMATCH",
      role: null,
      attemptId: null,
      assignmentId: null,
      runId: null,
      artifactRefs: [],
      causedByDiagnosticIds: [],
      expected: { prompt: "RAW_PROMPT_SENTINEL" },
      actual: { env: "OPENAI_API_KEY=sk-diagnostic-secret" },
      rejectedOutputArtifactId: null,
      auditSeq: 2,
      recommendedAction: "NONE",
    });
    const sanitizedContent = "<EPOCH_DECISION> RAW_OUTPUT_SENTINEL sk-artifact-secret";
    database.rejectedOutputArtifacts.push({
      artifactId: "rejected_redaction",
      sessionId: SESSION_ID,
      attemptId: attemptId("inventory"),
      originalDigest: sha256Digest("raw artifact"),
      redactionVersion: "epoch-redact-v1",
      reason: "PARSE_REJECTED",
      originalByteLength: sanitizedContent.length,
      sanitizedContent,
      sanitizedContentDigest: sha256Digest(sanitizedContent),
      truncated: false,
      createdAt: NOW,
    });

    const result = snapshot(EpochDatabaseSchema.parse(database));
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "topsecret",
      "resource-secret",
      "diagnostic-secret",
      "artifact-secret",
      "RAW_PROMPT_SENTINEL",
      "RAW_OUTPUT_SENTINEL",
      "ENV_DUMP_SENTINEL",
      "ABSOLUTE_PATH_SENTINEL",
      "C:\\\\Users",
      "/home/alice",
      "<EPOCH_DECISION>",
      "Bearer abcdefgh",
      "hunter2",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(result.agents[0]!.agentNameAtAssignment).toBe("inventory Agent");
    expect(result.agents[1]!.activeDecision?.runtimeProof.runtimeLabel).toBe(
      "redacted-runtime",
    );
    expect(result.agents[2]!.activeDecision?.runtimeProof).toMatchObject({
      threadId: null,
      roleProfileVersion: "redacted-role-profile",
      promptTemplateVersion: "redacted-prompt-template",
    });
    expect(result.events[0]).toMatchObject({
      type: "EVENT",
      status: "REDACTED",
      summary: "Session: EVENT REDACTED",
    });
  });
});
