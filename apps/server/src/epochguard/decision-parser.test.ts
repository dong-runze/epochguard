import { describe, expect, it } from "vitest";
import {
  GOLDEN_ACTION_HASH,
  GOLDEN_ACTION_INPUT,
  buildRoleQuerySpec,
  canonicalJson,
  sha256Digest,
  type AgentDecisionEnvelope,
  type EpochDatabase,
} from "./types.js";
import {
  DecisionNormalizationError,
  EPOCH_DECISION_CLOSE_MARKER,
  EPOCH_DECISION_OPEN_MARKER,
  MAX_DECISION_OUTPUT_BYTES,
  normalizeAndConsumeDecision,
  parseDecisionEnvelope,
} from "./decision-parser.js";

const NOW = "2026-08-29T12:00:00.000Z";
const COMPLETED = "2026-08-29T12:00:01.000Z";
const DIGEST = `sha256:${"1".repeat(64)}`;

function renderEnvelope(envelope: unknown): string {
  return `${EPOCH_DECISION_OPEN_MARKER}\n${JSON.stringify(envelope)}\n${EPOCH_DECISION_CLOSE_MARKER}`;
}

function makeFixture() {
  const role = "budget" as const;
  const sessionId = "session_decision_1";
  const assignmentId = "assignment_budget_1";
  const attemptId = "attempt_budget_1";
  const runId = "run_budget_1";
  const receiptId = "receipt_budget_1";
  const nonce = "n".repeat(32);
  const query = buildRoleQuerySpec(GOLDEN_ACTION_INPUT, role);
  const envelope: AgentDecisionEnvelope = {
    schemaVersion: 1,
    sessionId,
    actionHash: GOLDEN_ACTION_HASH,
    runAssignmentId: assignmentId,
    role,
    receiptId,
    nonce,
    verdict: "ALLOW",
    reason: "The authoritative budget covers the requested spend.",
  };
  const rawOutput = renderEnvelope(envelope);
  const database: EpochDatabase = {
    schemaVersion: 1,
    snapshotRevision: 0,
    headSeq: 19,
    roleAgentRegistrations: [
      {
        role,
        agentId: "agent_budget",
        agentNameAtRegistration: "Budget Agent",
        roleProfileVersion: "budget-v1",
        agentsMdDigest: DIGEST,
        registeredAt: NOW,
      },
    ],
    worldCommits: [],
    resourceVersions: [],
    roleQuerySpecs: [query],
    runAssignments: [
      {
        assignmentId,
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        agentId: "agent_budget",
        agentNameAtAssignment: "Budget Agent",
        role,
        receiptId,
        queryHash: query.queryHash,
        roleProfileVersion: "budget-v1",
        promptTemplateVersion: "epoch-prompt-v1",
        agentsMdDigest: DIGEST,
        runtimeLabelAtDispatch: "ControlledRunner",
        evidencePackRelativePath:
          ".epochguard/sessions/session_decision_1/budget/assignment_budget_1.json",
        evidencePackHash: DIGEST,
        boundRunId: runId,
        status: "BOUND",
        consumedByDecisionCertificateId: null,
        createdAt: NOW,
        boundAt: NOW,
        consumedAt: null,
      },
    ],
    receipts: [
      {
        schemaVersion: 1,
        receiptId,
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        agentId: "agent_budget",
        runAssignmentId: assignmentId,
        role,
        source: role,
        entityKey: GOLDEN_ACTION_INPUT.campaignId,
        queryHash: query.queryHash,
        sourceRevision: 19,
        valueHash: DIGEST,
        observedAtSeq: 19,
        nonce,
        issuer: "epochguard",
        issuedAt: NOW,
      },
    ],
    sessions: [
      {
        sessionId,
        scenarioId: "impossible-collage-v1",
        action: {
          ...GOLDEN_ACTION_INPUT,
          actionId: "action_decision_1",
          sessionId,
          actionHash: GOLDEN_ACTION_HASH,
          idempotencyKey: `${sessionId}:${GOLDEN_ACTION_HASH}`,
        },
        actionHash: GOLDEN_ACTION_HASH,
        state: "COLLECTING",
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
          budget: attemptId,
          policy: null,
        },
        activeValidationId: null,
        activeRefreshPlanId: null,
        activePermitId: null,
        stateUpdatedAt: NOW,
        createdAt: NOW,
      },
    ],
    attempts: [
      {
        attemptId,
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        role,
        agentId: "agent_budget",
        assignmentId,
        runId,
        status: "COMPLETED",
        runStartedAt: NOW,
        runCompletedAt: COMPLETED,
        threadId: "thread_budget_1",
        usage: null,
        outputDigest: sha256Digest(rawOutput),
      },
    ],
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
  return { database, envelope, rawOutput, attemptId };
}

function replaceEnvelope(
  fixture: ReturnType<typeof makeFixture>,
  mutate: (envelope: any) => void,
): void {
  const envelope = structuredClone(fixture.envelope) as any;
  mutate(envelope);
  fixture.rawOutput = renderEnvelope(envelope);
  fixture.database.attempts[0]!.outputDigest = sha256Digest(fixture.rawOutput);
}

function expectNormalizationFailure(
  fixture: ReturnType<typeof makeFixture>,
  reasonCode: string,
): void {
  const before = structuredClone(fixture.database);
  try {
    normalizeAndConsumeDecision(
      fixture.database,
      fixture.attemptId,
      fixture.rawOutput,
      { certificateId: "decision_rejected", createdAt: COMPLETED },
    );
    throw new Error("Expected normalization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionNormalizationError);
    expect((error as DecisionNormalizationError).reasonCode).toBe(reasonCode);
  }
  expect(fixture.database).toEqual(before);
}

describe("Decision parser and normalizer", () => {
  it("accepts exactly one strict marker envelope up to the 16 KiB byte boundary", () => {
    const fixture = makeFixture();
    expect(parseDecisionEnvelope(fixture.rawOutput)).toEqual(fixture.envelope);

    const padding = " ".repeat(
      MAX_DECISION_OUTPUT_BYTES - Buffer.byteLength(fixture.rawOutput, "utf8"),
    );
    const boundaryOutput = `${padding}${fixture.rawOutput}`;
    expect(Buffer.byteLength(boundaryOutput, "utf8")).toBe(
      MAX_DECISION_OUTPUT_BYTES,
    );
    expect(parseDecisionEnvelope(boundaryOutput)).toEqual(fixture.envelope);
  });

  it("rejects missing/duplicate markers, malformed JSON, extra fields, and free text", () => {
    const fixture = makeFixture();
    const withExtraField = renderEnvelope({
      ...fixture.envelope,
      runId: "untrusted_run",
    });
    const malformedJson = `${EPOCH_DECISION_OPEN_MARKER}{bad json${EPOCH_DECISION_CLOSE_MARKER}`;
    const candidates = [
      JSON.stringify(fixture.envelope),
      `${fixture.rawOutput}\n${fixture.rawOutput}`,
      malformedJson,
      withExtraField,
      `explanation\n${fixture.rawOutput}`,
      `${fixture.rawOutput}\nfinished`,
      "x".repeat(MAX_DECISION_OUTPUT_BYTES + 1),
    ];
    for (const candidate of candidates) {
      expect(() => parseDecisionEnvelope(candidate)).toThrowError(
        DecisionNormalizationError,
      );
      try {
        parseDecisionEnvelope(candidate);
      } catch (error) {
        expect((error as DecisionNormalizationError).reasonCode).toBe(
          "OUTPUT_MALFORMED",
        );
      }
    }
  });

  it("constructs a server Decision and consumes its Assignment exactly once", () => {
    const fixture = makeFixture();
    const decision = normalizeAndConsumeDecision(
      fixture.database,
      fixture.attemptId,
      fixture.rawOutput,
      { certificateId: "decision_budget_1", createdAt: COMPLETED },
    );

    expect(decision).toMatchObject({
      certificateId: "decision_budget_1",
      agentId: "agent_budget",
      runId: "run_budget_1",
      role: "budget",
      receiptIds: ["receipt_budget_1"],
      verdict: "ALLOW",
      status: "ACTIVE",
      decisionDigest: sha256Digest(canonicalJson(fixture.envelope)),
    });
    expect(fixture.database.runAssignments[0]).toMatchObject({
      status: "CONSUMED",
      consumedByDecisionCertificateId: "decision_budget_1",
      consumedAt: COMPLETED,
    });
    expect(fixture.database.attempts[0]!.status).toBe("ACCEPTED");
    expect(
      fixture.database.sessions[0]!.activeDecisionCertificateIds.budget,
    ).toBe("decision_budget_1");
    expect(fixture.database.sessions[0]!.activeAttemptIds.budget).toBeNull();

    const afterFirstConsumption = structuredClone(fixture.database);
    expect(() =>
      normalizeAndConsumeDecision(
        fixture.database,
        fixture.attemptId,
        fixture.rawOutput,
        { certificateId: "decision_budget_2", createdAt: COMPLETED },
      ),
    ).toThrowError(DecisionNormalizationError);
    expect(fixture.database).toEqual(afterFirstConsumption);
    expect(fixture.database.decisions).toHaveLength(1);
  });

  it("fails closed for every Session/Action/Role/Run/Agent/Receipt/nonce replay", () => {
    const cases: Array<{
      name: string;
      reasonCode: string;
      mutate: (fixture: ReturnType<typeof makeFixture>) => void;
    }> = [
      {
        name: "cross-session envelope",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.sessionId = "session_other";
          }),
      },
      {
        name: "cross-action envelope",
        reasonCode: "ACTION_HASH_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.actionHash = `sha256:${"f".repeat(64)}`;
          }),
      },
      {
        name: "cross-role envelope",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.role = "policy";
          }),
      },
      {
        name: "cross-assignment envelope",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.runAssignmentId = "assignment_other";
          }),
      },
      {
        name: "cross-receipt envelope",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.receiptId = "receipt_other";
          }),
      },
      {
        name: "old nonce",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.nonce = "o".repeat(32);
          }),
      },
      {
        name: "cross-run Attempt",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) => {
          fixture.database.attempts[0]!.runId = "run_other";
        },
      },
      {
        name: "cross-agent Attempt",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) => {
          fixture.database.attempts[0]!.agentId = "agent_other";
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = makeFixture();
      testCase.mutate(fixture);
      expectNormalizationFailure(fixture, testCase.reasonCode);
    }
  });

  it("rejects canonical query, profile, output-digest, and active-Attempt drift", () => {
    const queryDrift = makeFixture();
    queryDrift.database.runAssignments[0]!.queryHash =
      `sha256:${"f".repeat(64)}`;
    expectNormalizationFailure(queryDrift, "QUERY_HASH_MISMATCH");

    const profileDrift = makeFixture();
    profileDrift.database.roleAgentRegistrations[0]!.agentsMdDigest =
      `sha256:${"a".repeat(64)}`;
    expectNormalizationFailure(profileDrift, "ROLE_PROFILE_MISMATCH");

    const outputDrift = makeFixture();
    outputDrift.database.attempts[0]!.outputDigest = `sha256:${"b".repeat(64)}`;
    expectNormalizationFailure(outputDrift, "BINDING_MISMATCH");

    const inactiveAttempt = makeFixture();
    inactiveAttempt.database.sessions[0]!.activeAttemptIds.budget =
      "attempt_other";
    expectNormalizationFailure(inactiveAttempt, "BINDING_MISMATCH");
  });

  it("supersedes only the prior active Decision when a refreshed Decision is accepted", () => {
    const fixture = makeFixture();
    fixture.database.decisions.push({
      certificateId: "decision_budget_old",
      sessionId: "session_decision_1",
      actionHash: GOLDEN_ACTION_HASH,
      agentId: "agent_budget",
      runAssignmentId: "assignment_budget_old",
      runId: "run_budget_old",
      role: "budget",
      verdict: "ALLOW",
      receiptIds: ["receipt_budget_old"],
      decisionDigest: DIGEST,
      status: "ACTIVE",
      supersededByCertificateId: null,
      constructedBy: "epochguard",
      createdAt: NOW,
    });
    fixture.database.sessions[0]!.activeDecisionCertificateIds.budget =
      "decision_budget_old";

    normalizeAndConsumeDecision(
      fixture.database,
      fixture.attemptId,
      fixture.rawOutput,
      { certificateId: "decision_budget_new", createdAt: COMPLETED },
    );
    expect(fixture.database.decisions[0]).toMatchObject({
      status: "SUPERSEDED",
      supersededByCertificateId: "decision_budget_new",
    });
    expect(
      fixture.database.sessions[0]!.activeDecisionCertificateIds.budget,
    ).toBe("decision_budget_new");
  });
});
