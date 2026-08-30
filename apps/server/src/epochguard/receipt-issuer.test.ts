import { describe, expect, it } from "vitest";
import {
  applyFixtureCommit,
  buildFixtureActionIntent,
  getEpochGuardFixture,
  initializeFixtureWorld,
} from "./fixtures.js";
import {
  ReceiptIssuer,
  resolveReceiptResourceVersion,
  type IssuedObservation,
} from "./receipt-issuer.js";
import { WorldLedger } from "./world-ledger.js";
import type {
  ActionIntent,
  EpochDatabase,
  Role,
  RoleQuerySpec,
  RunAssignment,
} from "./types.js";

const ZERO_HASH = `sha256:${"0".repeat(64)}`;
const AGENTS_MD_HASH = `sha256:${"1".repeat(64)}`;

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

function assignmentFor(
  action: ActionIntent,
  querySpec: RoleQuerySpec,
  suffix: string,
): RunAssignment {
  const assignmentId = `assignment_${querySpec.role}_${suffix}`;
  return {
    assignmentId,
    sessionId: action.sessionId,
    actionHash: action.actionHash,
    agentId: `agent_${querySpec.role}`,
    agentNameAtAssignment: `${querySpec.role} agent`,
    role: querySpec.role,
    receiptId: `receipt_${querySpec.role}_${suffix}`,
    queryHash: querySpec.queryHash,
    roleProfileVersion: `${querySpec.role}-v1`,
    promptTemplateVersion: "epoch-prompt-v1",
    agentsMdDigest: AGENTS_MD_HASH,
    runtimeLabelAtDispatch: "test-runtime",
    evidencePackRelativePath: `.epochguard/sessions/${action.sessionId}/${querySpec.role}/${assignmentId}.json`,
    evidencePackHash: ZERO_HASH,
    boundRunId: null,
    status: "CREATED",
    consumedByDecisionCertificateId: null,
    createdAt: "2025-01-01T00:01:00.000Z",
    boundAt: null,
    consumedAt: null,
  };
}

function deterministicIssuer(): ReceiptIssuer {
  let nonceIndex = 0;
  return new ReceiptIssuer({
    now: () => "2025-01-01T00:02:00.000Z",
    nonceFactory: () => `nonce_${++nonceIndex}_${"n".repeat(40)}`,
  });
}

function captureImpossibleWorld(): {
  database: EpochDatabase;
  action: ActionIntent;
  observations: Map<Role, IssuedObservation>;
  assignments: Map<Role, RunAssignment>;
} {
  const database = emptyDatabase();
  const fixture = getEpochGuardFixture("impossible-collage-v1");
  const action = buildFixtureActionIntent(
    fixture.scenarioId,
    "session_impossible",
    "action_impossible",
  );
  database.roleQuerySpecs.push(...Object.values(fixture.querySpecs));
  const ledger = new WorldLedger();
  const issuer = deterministicIssuer();
  const observations = new Map<Role, IssuedObservation>();
  const assignments = new Map<Role, RunAssignment>();
  initializeFixtureWorld(database, fixture);

  for (const step of fixture.initialSteps) {
    if (step.kind === "commit") {
      applyFixtureCommit(database, ledger, step);
      continue;
    }
    const querySpec = fixture.querySpecs[step.role];
    const assignment = assignmentFor(action, querySpec, "initial");
    database.runAssignments.push(assignment);
    assignments.set(step.role, assignment);
    observations.set(
      step.role,
      issuer.issue(database, { action, assignment, querySpec }),
    );
  }
  return { database, action, observations, assignments };
}

describe("ReceiptIssuer", () => {
  it("issues server-owned Receipts at the interleaved capture heads", () => {
    const { database, observations } = captureImpossibleWorld();
    expect(database.receipts.map((receipt) => receipt.observedAtSeq)).toEqual([
      18, 19, 21,
    ]);
    expect(database.receipts.map((receipt) => receipt.role)).toEqual([
      "inventory",
      "budget",
      "policy",
    ]);
    for (const receipt of database.receipts) {
      expect(receipt.issuer).toBe("epochguard");
      expect(receipt.nonce.length).toBeGreaterThanOrEqual(32);
    }
    expect(observations.get("budget")?.receipt.sourceRevision).toBe(19);
  });

  it("reconstructs the finite Budget horizon under the active temporal rules", () => {
    const { database, observations } = captureImpossibleWorld();
    const budgetReceipt = observations.get("budget")?.receipt;
    if (budgetReceipt === undefined) throw new Error("Budget Receipt is missing");

    const version = resolveReceiptResourceVersion(database, budgetReceipt);
    expect({
      validFromSeq: version.validFromSeq,
      observedAtSeq: budgetReceipt.observedAtSeq,
      validUntilSeq: version.validUntilSeq,
      worldHead: database.headSeq,
    }).toEqual({
      validFromSeq: 19,
      observedAtSeq: 19,
      validUntilSeq: 20,
      worldHead: 21,
    });

    database.headSeq = 20;
    expect(() => resolveReceiptResourceVersion(database, budgetReceipt)).not.toThrow();
    database.headSeq = 19;
    expect(() => resolveReceiptResourceVersion(database, budgetReceipt)).toThrow(
      /ahead of the World head/,
    );
    database.headSeq = 21;
  });

  it("uses source + entityKey + sourceRevision when revisions collide globally", () => {
    const database = emptyDatabase();
    const fixture = getEpochGuardFixture("normal-world-v1");
    const action = buildFixtureActionIntent(
      fixture.scenarioId,
      "session_normal",
      "action_normal",
    );
    database.roleQuerySpecs.push(...Object.values(fixture.querySpecs));
    const ledger = new WorldLedger();
    initializeFixtureWorld(database, fixture);
    const commit = fixture.initialSteps.find(
      (step) => step.kind === "commit",
    );
    if (commit === undefined || commit.kind !== "commit") {
      throw new Error("normal fixture commit is missing");
    }
    applyFixtureCommit(database, ledger, commit);

    const querySpec = fixture.querySpecs.budget;
    const assignment = assignmentFor(action, querySpec, "same_revision");
    database.runAssignments.push(assignment);
    const { receipt } = deterministicIssuer().issue(database, {
      action,
      assignment,
      querySpec,
    });
    const version = resolveReceiptResourceVersion(database, receipt);
    expect(receipt.sourceRevision).toBe(10);
    expect(version.resourceId).toBe("budget:campaign_42");
    expect(version.value).toEqual({ remainingBudgetCents: 800_000 });
  });

  it("fails closed when persisted value changes without a new valueHash", () => {
    const { database, observations } = captureImpossibleWorld();
    const budgetReceipt = observations.get("budget")?.receipt;
    if (budgetReceipt === undefined) throw new Error("Budget Receipt is missing");
    const stored = database.resourceVersions.find(
      (version) =>
        version.resourceId === "budget:campaign_42" &&
        version.sourceRevision === 19,
    );
    if (stored === undefined) throw new Error("Budget version is missing");
    stored.value = { remainingBudgetCents: 0 };

    expect(() => resolveReceiptResourceVersion(database, budgetReceipt)).toThrow(
      /valueHash does not match/,
    );
  });

  it("rejects reconstructed-query mismatches and duplicate issuance", () => {
    const { database, action, assignments } = captureImpossibleWorld();
    const original = getEpochGuardFixture("impossible-collage-v1").querySpecs.budget;
    const assignment = assignments.get("budget");
    if (assignment === undefined) throw new Error("Budget Assignment is missing");

    expect(() =>
      deterministicIssuer().issue(database, {
        action,
        assignment,
        querySpec: { ...original, entityKey: "other_campaign" },
      }),
    ).toThrow(/does not reconstruct/);
    expect(() =>
      deterministicIssuer().issue(database, {
        action,
        assignment,
        querySpec: original,
      }),
    ).toThrow(/already has an issued Receipt/);
  });
});
