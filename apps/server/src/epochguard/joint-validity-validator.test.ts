import { describe, expect, it } from "vitest";
import {
  GOLDEN_ACTION_HASH,
  GOLDEN_ACTION_INPUT,
  ROLES,
  buildRoleQuerySpec,
  canonicalJson,
  sha256Digest,
  type EpochDatabase,
  type ResourceVersion,
  type Role,
  type Verdict,
} from "./types.js";
import {
  JointValidityValidationError,
  jointValidityDependencySetHash,
  validateJointValidity,
  type JointValidityValidationOptions,
  type ResourceVersionLookup,
  type ResourceVersionResolution,
} from "./joint-validity-validator.js";

const NOW = "2026-08-29T12:00:00.000Z";
const COMPLETED = "2026-08-29T12:00:01.000Z";
const DIGEST = `sha256:${"1".repeat(64)}`;
type IntervalSpec = {
  from: number;
  until: number | null;
  observedAt: number;
  sourceRevision?: number;
};

type FixtureOptions = {
  head?: number;
  intervals?: Partial<Record<Role, Partial<IntervalSpec>>>;
  verdicts?: Partial<Record<Role, Verdict>>;
  receiptIds?: Partial<Record<Role, string>>;
};

function agentId(role: Role): string {
  return `agent_${role}`;
}

function makeFixture(options: FixtureOptions = {}) {
  const head = options.head ?? 10;
  const sessionId = "session_joint_validity_1";
  const intervalsByRole = Object.fromEntries(
    ROLES.map((role) => {
      const base: IntervalSpec = { from: 10, until: null, observedAt: 10 };
      return [role, { ...base, ...options.intervals?.[role] }];
    }),
  ) as Record<Role, IntervalSpec>;
  const queries = ROLES.map((role) =>
    buildRoleQuerySpec(GOLDEN_ACTION_INPUT, role),
  );
  const receipts = ROLES.map((role) => {
    const query = queries.find((candidate) => candidate.role === role)!;
    const interval = intervalsByRole[role];
    const receiptId = options.receiptIds?.[role] ?? `receipt_${role}`;
    return {
      schemaVersion: 1 as const,
      receiptId,
      sessionId,
      actionHash: GOLDEN_ACTION_HASH,
      agentId: agentId(role),
      runAssignmentId: `assignment_${role}`,
      role,
      source: query.source,
      entityKey: query.entityKey,
      queryHash: query.queryHash,
      sourceRevision: interval.sourceRevision ?? interval.observedAt,
      valueHash: sha256Digest(`value:${role}:${interval.observedAt}`),
      observedAtSeq: interval.observedAt,
      nonce: role.repeat(32).slice(0, 32),
      issuer: "epochguard" as const,
      issuedAt: NOW,
    };
  });
  const resourceVersions = ROLES.map((role, index): ResourceVersion => {
    const receipt = receipts.find((candidate) => candidate.role === role)!;
    const interval = intervalsByRole[role];
    return {
      id: `resource_version_${index + 1}`,
      resourceId: `opaque_resource_${index + 1}`,
      sourceRevision: receipt.sourceRevision,
      value: { role, observedAt: interval.observedAt },
      valueHash: receipt.valueHash,
      validFromSeq: interval.from,
      validUntilSeq: interval.until,
    };
  });
  const versionsByReceipt = new Map(
    receipts.map((receipt, index) => [receipt.receiptId, resourceVersions[index]!]),
  );
  const lookups: ResourceVersionLookup[] = [];
  const resolveResourceVersion = (
    lookup: ResourceVersionLookup,
  ): ResourceVersionResolution | null => {
    lookups.push({ ...lookup });
    const resourceVersion = versionsByReceipt.get(lookup.receiptId);
    return resourceVersion === undefined
      ? null
      : {
          source: lookup.source,
          entityKey: lookup.entityKey,
          resourceVersion,
        };
  };

  const database: EpochDatabase = {
    schemaVersion: 1,
    snapshotRevision: 0,
    headSeq: head,
    roleAgentRegistrations: ROLES.map((role) => ({
      role,
      agentId: agentId(role),
      agentNameAtRegistration: `${role} agent`,
      roleProfileVersion: `${role}-v1`,
      agentsMdDigest: DIGEST,
      registeredAt: NOW,
    })),
    worldCommits: [],
    resourceVersions,
    roleQuerySpecs: queries,
    runAssignments: ROLES.map((role) => {
      const receipt = receipts.find((candidate) => candidate.role === role)!;
      const query = queries.find((candidate) => candidate.role === role)!;
      return {
        assignmentId: `assignment_${role}`,
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        agentId: agentId(role),
        agentNameAtAssignment: `${role} agent`,
        role,
        receiptId: receipt.receiptId,
        queryHash: query.queryHash,
        roleProfileVersion: `${role}-v1`,
        promptTemplateVersion: "epoch-prompt-v1",
        agentsMdDigest: DIGEST,
        runtimeLabelAtDispatch: "ControlledRunner",
        evidencePackRelativePath:
          `.epochguard/sessions/${sessionId}/${role}/assignment_${role}.json`,
        evidencePackHash: DIGEST,
        boundRunId: `run_${role}`,
        status: "CONSUMED" as const,
        consumedByDecisionCertificateId: `decision_${role}`,
        createdAt: NOW,
        boundAt: NOW,
        consumedAt: COMPLETED,
      };
    }),
    receipts,
    sessions: [
      {
        sessionId,
        scenarioId: "impossible-collage-v1",
        action: {
          ...GOLDEN_ACTION_INPUT,
          actionId: "action_joint_validity_1",
          sessionId,
          actionHash: GOLDEN_ACTION_HASH,
          idempotencyKey: `${sessionId}:${GOLDEN_ACTION_HASH}`,
        },
        actionHash: GOLDEN_ACTION_HASH,
        state: "VALIDATING",
        sessionRevision: 7,
        coordinationMode: "CONCURRENT",
        frozenAssignments: {
          inventoryAgentId: agentId("inventory"),
          budgetAgentId: agentId("budget"),
          policyAgentId: agentId("policy"),
        },
        activeDecisionCertificateIds: {
          inventory: "decision_inventory",
          budget: "decision_budget",
          policy: "decision_policy",
        },
        activeAttemptIds: { inventory: null, budget: null, policy: null },
        activeValidationId: null,
        activeRefreshPlanId: null,
        activePermitId: null,
        stateUpdatedAt: NOW,
        createdAt: NOW,
      },
    ],
    attempts: ROLES.map((role) => ({
      attemptId: `attempt_${role}`,
      sessionId,
      actionHash: GOLDEN_ACTION_HASH,
      role,
      agentId: agentId(role),
      assignmentId: `assignment_${role}`,
      runId: `run_${role}`,
      status: "ACCEPTED" as const,
      runStartedAt: NOW,
      runCompletedAt: COMPLETED,
      threadId: `thread_${role}`,
      usage: null,
      outputDigest: sha256Digest(`output:${role}`),
    })),
    decisions: ROLES.map((role) => ({
      certificateId: `decision_${role}`,
      sessionId,
      actionHash: GOLDEN_ACTION_HASH,
      agentId: agentId(role),
      runAssignmentId: `assignment_${role}`,
      runId: `run_${role}`,
      role,
      verdict: options.verdicts?.[role] ?? "ALLOW",
      receiptIds: [
        receipts.find((candidate) => candidate.role === role)!.receiptId,
      ],
      decisionDigest: sha256Digest(`decision:${role}`),
      status: "ACTIVE" as const,
      supersededByCertificateId: null,
      constructedBy: "epochguard" as const,
      createdAt: COMPLETED,
    })),
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

  return {
    database,
    sessionId,
    receipts,
    resourceVersions,
    versionsByReceipt,
    lookups,
    resolveResourceVersion,
  };
}

function runValidation(
  fixture: ReturnType<typeof makeFixture>,
  overrides: Partial<JointValidityValidationOptions> = {},
) {
  return validateJointValidity(fixture.database, fixture.sessionId, {
    resolveResourceVersion: fixture.resolveResourceVersion,
    validationId: "validation_1",
    jointValidityCertificateId: "jvc_1",
    noCutProofId: "proof_1",
    createdAt: COMPLETED,
    verificationLatencyMs: 7,
    ...overrides,
  });
}

function expectValidationFailure(
  fixture: ReturnType<typeof makeFixture>,
  reasonCode: string,
  overrides: Partial<JointValidityValidationOptions> = {},
): void {
  try {
    runValidation(fixture, overrides);
    throw new Error("Expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(JointValidityValidationError);
    expect((error as JointValidityValidationError).reasonCode).toBe(reasonCode);
  }
}

describe("Joint validity validator", () => {
  it("WC-01 issues a current-head JVC with the frozen H+1 open interval", () => {
    const fixture = makeFixture({ head: 10 });
    const before = structuredClone(fixture.database);
    const result = runValidation(fixture);

    expect(result.validationRecord).toMatchObject({
      outcome: "VALID_CURRENT_ALLOW",
      lowerBound: 10,
      upperBound: 11,
      validatedHead: 10,
      jointValidityCertificateId: "jvc_1",
      noCutProofId: null,
      verificationLatencyMs: 7,
    });
    expect(result.jointValidityCertificate).toMatchObject({
      certificateId: "jvc_1",
      selectedCutSeq: 10,
      currentHeadCovered: true,
      validatedAtHead: 10,
      intervals: [
        { receiptId: "receipt_inventory", from: 10, until: null },
        { receiptId: "receipt_budget", from: 10, until: null },
        { receiptId: "receipt_policy", from: 10, until: null },
      ],
    });
    expect(result.noCutProof).toBeNull();
    expect(result.currentInvalidAgentIds).toEqual([]);
    expect(result.validationRecord.dependencySetHash).toBe(
      jointValidityDependencySetHash([
        "receipt_policy",
        "receipt_inventory",
        "receipt_budget",
      ]),
    );
    expect(fixture.database).toEqual(before);

    expect(fixture.lookups).toEqual(
      fixture.receipts.map((receipt) => ({
        receiptId: receipt.receiptId,
        source: receipt.source,
        entityKey: receipt.entityKey,
        sourceRevision: receipt.sourceRevision,
        valueHash: receipt.valueHash,
        observedAtSeq: receipt.observedAtSeq,
        validatedAtHead: 10,
      })),
    );
  });

  it("WC-02 proves L=21/U=20 with old Budget and permitted Policy witnesses", () => {
    const fixture = makeFixture({
      head: 21,
      intervals: {
        inventory: { from: 1, until: null, observedAt: 21 },
        budget: { from: 1, until: 20, observedAt: 19 },
        policy: { from: 21, until: null, observedAt: 21 },
      },
    });
    const result = runValidation(fixture);

    expect(result.validationRecord).toMatchObject({
      outcome: "NO_VALID_OBSERVED_WORLD_CUT",
      lowerBound: 21,
      upperBound: 20,
      jointValidityCertificateId: null,
      noCutProofId: "proof_1",
    });
    expect(result.noCutProof).toMatchObject({
      latestStartingReceiptId: "receipt_policy",
      earliestEndingReceiptId: "receipt_budget",
      conflictWitnessReceiptIds: ["receipt_budget", "receipt_policy"],
      refreshAgentIds: ["agent_budget"],
      lowerBound: 21,
      upperBound: 20,
    });
    expect(result.currentInvalidAgentIds).toEqual(["agent_budget"]);
    expect(result.jointValidityCertificate).toBeNull();
  });

  it("WC-03 records a historical cut but fences stale current-head evidence", () => {
    const fixture = makeFixture({
      head: 20,
      intervals: {
        inventory: { from: 5, until: null, observedAt: 20 },
        budget: { from: 5, until: 10, observedAt: 9 },
        policy: { from: 5, until: null, observedAt: 20 },
      },
    });
    const result = runValidation(fixture);

    expect(result.validationRecord).toMatchObject({
      outcome: "HISTORICAL_BUT_STALE_NOW",
      lowerBound: 5,
      upperBound: 10,
      jointValidityCertificateId: null,
      noCutProofId: null,
    });
    expect(result.currentInvalidAgentIds).toEqual(["agent_budget"]);
    expect(result.jointValidityCertificate).toBeNull();
    expect(result.noCutProof).toBeNull();
  });

  it("WC-04 treats touching half-open endpoints as No-Cut", () => {
    const fixture = makeFixture({
      head: 2,
      intervals: {
        inventory: { from: 1, until: 2, observedAt: 1 },
        budget: { from: 2, until: null, observedAt: 2 },
        policy: { from: 2, until: null, observedAt: 2 },
      },
    });
    const result = runValidation(fixture);

    expect(result.validationRecord).toMatchObject({
      outcome: "NO_VALID_OBSERVED_WORLD_CUT",
      lowerBound: 2,
      upperBound: 2,
    });
    expect(result.noCutProof).toMatchObject({
      earliestEndingReceiptId: "receipt_inventory",
      conflictWitnessReceiptIds: ["receipt_inventory", "receipt_budget"],
      refreshAgentIds: ["agent_inventory"],
    });
  });

  it("uses UTF-16 receiptId order to break both No-Cut endpoint ties", () => {
    const earliestTie = makeFixture({
      head: 21,
      receiptIds: {
        inventory: "receipt_z_inventory",
        budget: "receipt_a_budget",
        policy: "receipt_policy",
      },
      intervals: {
        inventory: { from: 1, until: 20, observedAt: 19 },
        budget: { from: 1, until: 20, observedAt: 19 },
        policy: { from: 21, until: null, observedAt: 21 },
      },
    });
    expect(runValidation(earliestTie).noCutProof).toMatchObject({
      earliestEndingReceiptId: "receipt_a_budget",
      latestStartingReceiptId: "receipt_policy",
      conflictWitnessReceiptIds: ["receipt_a_budget", "receipt_policy"],
    });

    const latestTie = makeFixture({
      head: 21,
      receiptIds: {
        inventory: "receipt_z_inventory",
        budget: "receipt_budget",
        policy: "receipt_a_policy",
      },
      intervals: {
        inventory: { from: 21, until: null, observedAt: 21 },
        budget: { from: 1, until: 20, observedAt: 19 },
        policy: { from: 21, until: null, observedAt: 21 },
      },
    });
    expect(runValidation(latestTie).noCutProof).toMatchObject({
      earliestEndingReceiptId: "receipt_budget",
      latestStartingReceiptId: "receipt_a_policy",
      conflictWitnessReceiptIds: ["receipt_budget", "receipt_a_policy"],
    });
  });

  it("returns CONSISTENT_DENY with a bound current-head JVC and no Permit", () => {
    const fixture = makeFixture({ verdicts: { policy: "DENY" } });
    const before = structuredClone(fixture.database);
    const result = runValidation(fixture);
    const decisionCertificateIds = [
      "decision_inventory",
      "decision_budget",
      "decision_policy",
    ] as const;
    const dependencySetHash = jointValidityDependencySetHash([
      "receipt_inventory",
      "receipt_budget",
      "receipt_policy",
    ]);

    expect(result.validationRecord).toEqual({
      validationId: "validation_1",
      sessionId: fixture.sessionId,
      actionHash: GOLDEN_ACTION_HASH,
      baseSessionRevision: 7,
      decisionCertificateIds,
      dependencySetHash,
      validatedHead: 10,
      outcome: "CONSISTENT_DENY",
      lowerBound: 10,
      upperBound: 11,
      jointValidityCertificateId: "jvc_1",
      noCutProofId: null,
      refreshPlanId: null,
      verificationLatencyMs: 7,
      createdAt: COMPLETED,
    });
    expect(result.jointValidityCertificate).toEqual({
      certificateId: "jvc_1",
      validationId: "validation_1",
      sessionId: fixture.sessionId,
      actionHash: GOLDEN_ACTION_HASH,
      dependencySetHash,
      validatedAtHead: 10,
      selectedCutSeq: 10,
      currentHeadCovered: true,
      decisionCertificateIds,
      intervals: [
        {
          receiptId: "receipt_inventory",
          source: "inventory",
          sourceRevision: 10,
          from: 10,
          until: null,
        },
        {
          receiptId: "receipt_budget",
          source: "budget",
          sourceRevision: 10,
          from: 10,
          until: null,
        },
        {
          receiptId: "receipt_policy",
          source: "policy",
          sourceRevision: 10,
          from: 10,
          until: null,
        },
      ],
      validatorVersion: "epochguard-jv-v1",
      createdAt: COMPLETED,
    });
    expect(result.noCutProof).toBeNull();
    expect(result.currentInvalidAgentIds).toEqual([]);
    expect(fixture.database.permits).toEqual([]);
    expect(fixture.database.effects).toEqual([]);
    expect(fixture.database).toEqual(before);
  });

  it("fails closed for unknown, truncated, future, and mismatched history", () => {
    const unknown = makeFixture();
    expectValidationFailure(unknown, "HISTORY_UNVERIFIABLE", {
      resolveResourceVersion: () => null,
    });

    const truncated = makeFixture();
    expectValidationFailure(truncated, "HISTORY_UNVERIFIABLE", {
      resolveResourceVersion: (lookup) => ({
        source: lookup.source,
        entityKey: lookup.entityKey,
        resourceVersion: {} as ResourceVersion,
      }),
    });

    const wrongRevision = makeFixture();
    wrongRevision.resourceVersions[0]!.sourceRevision += 1;
    expectValidationFailure(wrongRevision, "HISTORY_UNVERIFIABLE");

    const futureClosure = makeFixture();
    futureClosure.resourceVersions[0]!.validUntilSeq = 12;
    expectValidationFailure(futureClosure, "HISTORY_UNVERIFIABLE");

    const wrongValue = makeFixture();
    wrongValue.resourceVersions[0]!.valueHash = `sha256:${"f".repeat(64)}`;
    expectValidationFailure(wrongValue, "BINDING_MISMATCH");
  });

  it("requires the resolver to preserve source and entityKey bindings", () => {
    const wrongSource = makeFixture();
    expectValidationFailure(wrongSource, "BINDING_MISMATCH", {
      resolveResourceVersion: (lookup) => ({
        source: lookup.source === "inventory" ? "budget" : "inventory",
        entityKey: lookup.entityKey,
        resourceVersion: wrongSource.versionsByReceipt.get(lookup.receiptId)!,
      }),
    });

    const wrongEntity = makeFixture();
    expectValidationFailure(wrongEntity, "BINDING_MISMATCH", {
      resolveResourceVersion: (lookup) => ({
        source: lookup.source,
        entityKey: "entity_other",
        resourceVersion: wrongEntity.versionsByReceipt.get(lookup.receiptId)!,
      }),
    });
  });

  it("rechecks cross-Session/Action/Role/Run/Agent/Receipt bindings", () => {
    const cases: Array<(database: EpochDatabase) => void> = [
      (database) => {
        database.decisions[0]!.sessionId = "session_other";
      },
      (database) => {
        database.decisions[0]!.actionHash = `sha256:${"f".repeat(64)}`;
      },
      (database) => {
        database.decisions[0]!.role = "budget";
      },
      (database) => {
        database.decisions[0]!.runId = "run_other";
      },
      (database) => {
        database.decisions[0]!.agentId = "agent_other";
      },
      (database) => {
        database.decisions[0]!.receiptIds = ["receipt_budget"];
      },
    ];
    for (const mutate of cases) {
      const fixture = makeFixture();
      mutate(fixture.database);
      expect(() => runValidation(fixture)).toThrowError(
        JointValidityValidationError,
      );
    }
  });

  it("is deterministic for fixed IDs, time, head, and active tuple", () => {
    const fixture = makeFixture({
      head: 21,
      intervals: {
        inventory: { from: 1, until: null, observedAt: 21 },
        budget: { from: 1, until: 20, observedAt: 19 },
        policy: { from: 21, until: null, observedAt: 21 },
      },
    });
    const first = runValidation(fixture);
    const second = runValidation(fixture);
    expect(canonicalJson(second)).toBe(canonicalJson(first));
  });
});
