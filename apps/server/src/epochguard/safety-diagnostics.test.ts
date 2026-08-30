import { describe, expect, it } from "vitest";

import {
  EpochDatabaseSchema,
  GOLDEN_ACTION_HASH,
  GOLDEN_ACTION_INPUT,
  sha256Digest,
  type EpochDatabase,
  type SafetyDiagnostic,
} from "./types.js";
import {
  SafetyDiagnosticIntegrityError,
  assertSafetyDiagnosticCausalChains,
  buildSafetyDiagnostic,
  latestSafetyDiagnosticViews,
  toSafetyDiagnosticView,
} from "./safety-diagnostics.js";

const SESSION_ID = "session_diagnostic";
const NOW = "2026-08-29T12:00:00.000Z";
const DONE = "2026-08-29T12:01:00.000Z";
const ATTEMPT_ID = "attempt_budget_failed";
const ASSIGNMENT_ID = "assignment_budget_failed";
const RUN_ID = "run_budget_failed";
const ACTION = {
  ...GOLDEN_ACTION_INPUT,
  actionId: "action_diagnostic",
  sessionId: SESSION_ID,
  actionHash: GOLDEN_ACTION_HASH,
  idempotencyKey: `${SESSION_ID}:${GOLDEN_ACTION_HASH}`,
};

function runDiagnostic(
  overrides: Partial<SafetyDiagnostic> = {},
): SafetyDiagnostic {
  return buildSafetyDiagnostic({
    diagnosticId: "diagnostic_run_failed",
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    sessionRevision: 3,
    fixtureRef: null,
    kind: "SYSTEM_FAILURE",
    stage: "RUN",
    reasonCode: "RUN_FAILED",
    role: "budget",
    attemptId: ATTEMPT_ID,
    assignmentId: ASSIGNMENT_ID,
    runId: RUN_ID,
    artifactRefs: [
      { kind: "ATTEMPT", id: ATTEMPT_ID },
      { kind: "ASSIGNMENT", id: ASSIGNMENT_ID },
      { kind: "RUN", id: RUN_ID },
    ],
    causedByDiagnosticIds: ["diagnostic_dispatch_busy"],
    expected: null,
    actual: null,
    rejectedOutputArtifactId: null,
    auditSeq: 2,
    recommendedAction: "NEW_SESSION",
    ...overrides,
  });
}

function makeDatabase(): EpochDatabase {
  const dispatchDiagnostic = buildSafetyDiagnostic({
    diagnosticId: "diagnostic_dispatch_busy",
    sessionId: SESSION_ID,
    actionHash: GOLDEN_ACTION_HASH,
    sessionRevision: 2,
    fixtureRef: null,
    kind: "SYSTEM_FAILURE",
    stage: "DISPATCH",
    reasonCode: "AGENTS_BUSY",
    role: "budget",
    attemptId: null,
    assignmentId: null,
    runId: null,
    artifactRefs: [],
    causedByDiagnosticIds: [],
    expected: null,
    actual: null,
    rejectedOutputArtifactId: null,
    auditSeq: 1,
    recommendedAction: "NEW_SESSION",
  });
  return EpochDatabaseSchema.parse({
    schemaVersion: 1,
    snapshotRevision: 7,
    headSeq: 3,
    roleAgentRegistrations: [],
    worldCommits: [],
    resourceVersions: [],
    roleQuerySpecs: [],
    runAssignments: [
      {
        assignmentId: ASSIGNMENT_ID,
        sessionId: SESSION_ID,
        actionHash: GOLDEN_ACTION_HASH,
        agentId: "agent_budget",
        agentNameAtAssignment: "Budget Agent",
        role: "budget",
        receiptId: "receipt_budget_failed",
        queryHash: sha256Digest("budget query"),
        roleProfileVersion: "profile_budget_v1",
        promptTemplateVersion: "prompt_budget_v1",
        agentsMdDigest: sha256Digest("agents md"),
        runtimeLabelAtDispatch: "codex-budget",
        evidencePackRelativePath:
          ".epochguard/sessions/session_diagnostic/budget/assignment_budget_failed.json",
        evidencePackHash: sha256Digest("evidence pack"),
        boundRunId: RUN_ID,
        status: "REJECTED",
        consumedByDecisionCertificateId: null,
        createdAt: NOW,
        boundAt: NOW,
        consumedAt: null,
      },
    ],
    receipts: [],
    sessions: [
      {
        sessionId: SESSION_ID,
        scenarioId: "normal-world-v1",
        action: ACTION,
        actionHash: GOLDEN_ACTION_HASH,
        state: "FAILED",
        sessionRevision: 3,
        coordinationMode: "CONCURRENT",
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
          budget: ATTEMPT_ID,
          policy: null,
        },
        activeValidationId: null,
        activeRefreshPlanId: null,
        activePermitId: null,
        stateUpdatedAt: DONE,
        createdAt: NOW,
      },
    ],
    attempts: [
      {
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        actionHash: GOLDEN_ACTION_HASH,
        role: "budget",
        agentId: "agent_budget",
        assignmentId: ASSIGNMENT_ID,
        runId: RUN_ID,
        status: "FAILED",
        runStartedAt: NOW,
        runCompletedAt: DONE,
        threadId: "thread_budget_failed",
        usage: null,
        outputDigest: null,
      },
    ],
    decisions: [],
    validations: [],
    jointValidityCertificates: [],
    noCutProofs: [],
    refreshPlans: [],
    permits: [],
    effects: [],
    diagnostics: [dispatchDiagnostic, runDiagnostic()],
    rejectedOutputArtifacts: [],
    auditEvents: [],
  });
}

describe("SafetyDiagnostic construction", () => {
  it("requires terminal RUN, Attempt, and Assignment refs", () => {
    expect(runDiagnostic()).toMatchObject({
      stage: "RUN",
      reasonCode: "RUN_FAILED",
      artifactRefs: [
        { kind: "ATTEMPT", id: ATTEMPT_ID },
        { kind: "ASSIGNMENT", id: ASSIGNMENT_ID },
        { kind: "RUN", id: RUN_ID },
      ],
    });
    expect(() =>
      runDiagnostic({ artifactRefs: [{ kind: "ATTEMPT", id: ATTEMPT_ID }] }),
    ).toThrowError(SafetyDiagnosticIntegrityError);
  });

  it("requires malformed output to retain its rejected ArtifactRef", () => {
    const diagnostic = buildSafetyDiagnostic({
      diagnosticId: "diagnostic_output_malformed",
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      sessionRevision: 2,
      fixtureRef: null,
      kind: "SYSTEM_FAILURE",
      stage: "PARSE",
      reasonCode: "OUTPUT_MALFORMED",
      role: "budget",
      attemptId: ATTEMPT_ID,
      assignmentId: ASSIGNMENT_ID,
      runId: null,
      artifactRefs: [
        { kind: "ATTEMPT", id: ATTEMPT_ID },
        { kind: "ASSIGNMENT", id: ASSIGNMENT_ID },
        { kind: "REJECTED_OUTPUT", id: "rejected_budget" },
      ],
      causedByDiagnosticIds: [],
      expected: null,
      actual: null,
      rejectedOutputArtifactId: "rejected_budget",
      auditSeq: 3,
      recommendedAction: "NEW_SESSION",
    });
    expect(diagnostic.rejectedOutputArtifactId).toBe("rejected_budget");
  });
});

describe("SafetyDiagnostic causal reconciliation", () => {
  it("accepts an earlier same-Session cause and authoritative terminal Run mirror", () => {
    const database = makeDatabase();
    expect(() => assertSafetyDiagnosticCausalChains(database, SESSION_ID)).not.toThrow();
    expect(latestSafetyDiagnosticViews(database, SESSION_ID)).toEqual([
      toSafetyDiagnosticView(database.diagnostics[1]!),
      toSafetyDiagnosticView(database.diagnostics[0]!),
    ]);
  });

  it("fails closed on unresolved ArtifactRefs", () => {
    const database = makeDatabase();
    database.diagnostics[1]!.artifactRefs.push({
      kind: "RECEIPT",
      id: "receipt_does_not_exist",
    });
    expect(() => assertSafetyDiagnosticCausalChains(database, SESSION_ID)).toThrowError(
      expect.objectContaining({ code: "UNRESOLVED_ARTIFACT_REF" }),
    );
  });

  it("fails closed when a RUN ref is not terminal in the mirrored Attempt", () => {
    const database = makeDatabase();
    database.attempts[0]!.status = "RUNNING";
    database.attempts[0]!.runCompletedAt = null;
    expect(() => assertSafetyDiagnosticCausalChains(database, SESSION_ID)).toThrowError(
      expect.objectContaining({ code: "INVALID_DIAGNOSTIC_CAUSAL_CHAIN" }),
    );
  });

  it("rejects later, cross-Action, and cyclic causes", () => {
    const later = makeDatabase();
    later.diagnostics[0]!.auditSeq = 3;
    expect(() => assertSafetyDiagnosticCausalChains(later, SESSION_ID)).toThrowError(
      SafetyDiagnosticIntegrityError,
    );

    const crossAction = makeDatabase();
    crossAction.diagnostics[0]!.actionHash = sha256Digest("different action");
    expect(() =>
      assertSafetyDiagnosticCausalChains(crossAction, SESSION_ID),
    ).toThrowError(SafetyDiagnosticIntegrityError);

    const cycle = makeDatabase();
    cycle.diagnostics[0]!.causedByDiagnosticIds = ["diagnostic_run_failed"];
    expect(() => assertSafetyDiagnosticCausalChains(cycle, SESSION_ID)).toThrowError(
      SafetyDiagnosticIntegrityError,
    );
  });
});

describe("SafetyDiagnostic dashboard redaction", () => {
  it("never projects fixtureRef, expected, actual, or raw rejected material", () => {
    const diagnostic = buildSafetyDiagnostic({
      diagnosticId: "diagnostic_secret",
      sessionId: SESSION_ID,
      actionHash: GOLDEN_ACTION_HASH,
      sessionRevision: 1,
      fixtureRef: "C:\\Users\\alice\\raw-output.txt",
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
      actual: { env: "OPENAI_API_KEY=sk-super-secret" },
      rejectedOutputArtifactId: null,
      auditSeq: 1,
      recommendedAction: "NONE",
    });
    const serialized = JSON.stringify(toSafetyDiagnosticView(diagnostic));
    expect(serialized).not.toContain("raw-output");
    expect(serialized).not.toContain("RAW_PROMPT_SENTINEL");
    expect(serialized).not.toContain("sk-super-secret");
    expect(serialized).not.toContain("fixtureRef");
    expect(serialized).not.toContain("expected");
    expect(serialized).not.toContain("actual");
  });
});
