import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceManager } from "../workspace.js";
import {
  EvidencePackWriter,
  assertEvidencePackHash,
  buildCanonicalEvidencePack,
  type EvidencePackBuildInput,
} from "./evidence-pack-writer.js";
import {
  applyFixtureCommit,
  buildFixtureActionIntent,
  getEpochGuardFixture,
  initializeFixtureWorld,
} from "./fixtures.js";
import { ReceiptIssuer, type IssuedObservation } from "./receipt-issuer.js";
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
const GOLDEN_EVIDENCE_PACK_HASH =
  "sha256:67bcb33eea4df4514d19802044d76a8b65008e16b35ee35c6befedc4acaefb22";

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

interface PreparedBudgetEvidence {
  database: EpochDatabase;
  action: ActionIntent;
  querySpec: RoleQuerySpec & { role: "budget" };
  assignment: RunAssignment;
  observation: IssuedObservation;
  issuer: ReceiptIssuer;
}

function prepareBudgetEvidence(): PreparedBudgetEvidence {
  const database = emptyDatabase();
  const fixture = getEpochGuardFixture("impossible-collage-v1");
  const action = buildFixtureActionIntent(
    fixture.scenarioId,
    "session_golden",
    "action_golden",
  );
  database.roleQuerySpecs.push(...Object.values(fixture.querySpecs));
  const ledger = new WorldLedger();
  let nonceIndex = 0;
  const issuer = new ReceiptIssuer({
    now: () => "2025-01-01T00:02:00.000Z",
    nonceFactory: () =>
      nonceIndex++ === 0
        ? "nonce_budget_initial_0123456789abcdef0123456789abcdef"
        : "nonce_budget_refresh_fedcba9876543210fedcba9876543210",
  });
  const querySpec = fixture.querySpecs.budget;
  const assignment = assignmentFor(action, querySpec, "initial");
  let observation: IssuedObservation | undefined;

  initializeFixtureWorld(database, fixture);
  for (const step of fixture.initialSteps) {
    if (step.kind === "commit") {
      applyFixtureCommit(database, ledger, step);
    } else if (step.role === "budget") {
      database.runAssignments.push(assignment);
      observation = issuer.issue(database, { action, assignment, querySpec });
    }
  }
  if (observation === undefined) throw new Error("Budget capture is missing");
  return { database, action, querySpec, assignment, observation, issuer };
}

function buildInput(prepared: PreparedBudgetEvidence): EvidencePackBuildInput {
  return {
    action: prepared.action,
    querySpec: prepared.querySpec,
    assignment: prepared.assignment,
    receipt: prepared.observation.receipt,
    resourceVersion: prepared.observation.resourceVersion,
    worldHeadSeq: prepared.database.headSeq,
  };
}

describe("EvidencePackWriter", () => {
  it("freezes canonical Evidence Pack bytes and rebuilds identical input exactly", () => {
    const prepared = prepareBudgetEvidence();
    const input = buildInput(prepared);
    const first = buildCanonicalEvidencePack(input);
    prepared.assignment.evidencePackHash = first.evidencePackHash;
    const second = buildCanonicalEvidencePack(input);

    expect(second.canonicalText).toBe(first.canonicalText);
    expect(Buffer.from(second.canonicalBytes)).toEqual(
      Buffer.from(first.canonicalBytes),
    );
    expect(second.evidencePackHash).toBe(GOLDEN_EVIDENCE_PACK_HASH);
    expect(second.canonicalText).toBe(
      '{"action":{"campaignId":"campaign_42","estimatedCostCents":500000},"assignment":{"actionHash":"sha256:bd99e824e58087f03cd1018fe7457865a596ae74ffbb5a707b1d2c3b6da5c202","promptTemplateVersion":"epoch-prompt-v1","queryHash":"sha256:3497fdc0405a9ac929b9aa370295fac815db538f19efb1c51923c06d744711c4","role":"budget","roleProfileVersion":"budget-v1","runAssignmentId":"assignment_budget_initial","sessionId":"session_golden"},"decisionRule":"ALLOW iff remainingBudgetCents >= estimatedCostCents.","observation":{"nonce":"nonce_budget_initial_0123456789abcdef0123456789abcdef","observedAtSeq":19,"receiptId":"receipt_budget_initial","remainingBudgetCents":800000},"responseMarker":"EPOCH_DECISION"}',
    );
    expect(() => assertEvidencePackHash(prepared.assignment, second)).not.toThrow();
  });

  it("emits the exact minimal Action and observation projection for every role", () => {
    const database = emptyDatabase();
    const fixture = getEpochGuardFixture("normal-world-v1");
    const action = buildFixtureActionIntent(
      fixture.scenarioId,
      "session_all_roles",
      "action_all_roles",
    );
    database.roleQuerySpecs.push(...Object.values(fixture.querySpecs));
    const ledger = new WorldLedger();
    let nonceIndex = 0;
    const issuer = new ReceiptIssuer({
      now: () => "2025-01-01T00:02:00.000Z",
      nonceFactory: () => `nonce_all_roles_${++nonceIndex}_${"x".repeat(32)}`,
    });
    initializeFixtureWorld(database, fixture);
    const commit = fixture.initialSteps.find(
      (step) => step.kind === "commit",
    );
    if (commit === undefined || commit.kind !== "commit") {
      throw new Error("normal fixture commit is missing");
    }
    applyFixtureCommit(database, ledger, commit);

    const expected = {
      inventory: {
        action: { campaignId: "campaign_42", requestedUnits: 1 },
        observation: { availableUnits: 1, observedAtSeq: 10 },
        decisionRule: "ALLOW iff availableUnits >= requestedUnits.",
      },
      budget: {
        action: { campaignId: "campaign_42", estimatedCostCents: 500_000 },
        observation: { remainingBudgetCents: 800_000, observedAtSeq: 10 },
        decisionRule: "ALLOW iff remainingBudgetCents >= estimatedCostCents.",
      },
      policy: {
        action: { campaignId: "campaign_42", market: "SG" },
        observation: { permitted: true, observedAtSeq: 10 },
        decisionRule: "ALLOW iff permitted === true.",
      },
    } satisfies Record<Role, unknown>;

    for (const role of ["inventory", "budget", "policy"] as const) {
      const querySpec = fixture.querySpecs[role];
      const assignment = assignmentFor(action, querySpec, "all_roles");
      database.runAssignments.push(assignment);
      const observation = issuer.issue(database, {
        action,
        assignment,
        querySpec,
      });
      const built = buildCanonicalEvidencePack({
        action,
        querySpec,
        assignment,
        receipt: observation.receipt,
        resourceVersion: observation.resourceVersion,
        worldHeadSeq: database.headSeq,
      });
      expect(built.payload).toMatchObject(expected[role]);
      expect(built.payload.responseMarker).toBe("EPOCH_DECISION");
    }
  });

  it("keeps first and refresh Packs on separate immutable assignment paths", async () => {
    const prepared = prepareBudgetEvidence();
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "epochguard-evidence-pack-"),
    );
    try {
      await mkdir(path.join(workspaceRoot, prepared.assignment.agentId));
      const writer = new EvidencePackWriter(new WorkspaceManager(workspaceRoot));
      const firstInput = buildInput(prepared);
      const firstBuilt = writer.buildCanonicalPack(firstInput);
      prepared.assignment.evidencePackHash = firstBuilt.evidencePackHash;
      const firstWritten = await writer.writeCanonicalPack(firstInput);
      const firstAbsolutePath = path.join(
        workspaceRoot,
        prepared.assignment.agentId,
        ...firstWritten.writtenRelativePath.split("/"),
      );
      const originalFirstBytes = await readFile(firstAbsolutePath);

      const refreshAssignment = assignmentFor(
        prepared.action,
        prepared.querySpec,
        "refresh",
      );
      prepared.database.runAssignments.push(refreshAssignment);
      const refreshObservation = prepared.issuer.issue(prepared.database, {
        action: prepared.action,
        assignment: refreshAssignment,
        querySpec: prepared.querySpec,
      });
      const refreshInput: EvidencePackBuildInput = {
        action: prepared.action,
        querySpec: prepared.querySpec,
        assignment: refreshAssignment,
        receipt: refreshObservation.receipt,
        resourceVersion: refreshObservation.resourceVersion,
        worldHeadSeq: prepared.database.headSeq,
      };
      const refreshBuilt = writer.buildCanonicalPack(refreshInput);
      refreshAssignment.evidencePackHash = refreshBuilt.evidencePackHash;
      const refreshWritten = await writer.writeCanonicalPack(refreshInput);

      expect(refreshWritten.writtenRelativePath).not.toBe(
        firstWritten.writtenRelativePath,
      );
      expect(await readFile(firstAbsolutePath)).toEqual(originalFirstBytes);
      expect(refreshWritten.payload.observation).toMatchObject({
        remainingBudgetCents: 0,
        observedAtSeq: 21,
      });

      await writeFile(firstAbsolutePath, '{"tampered":true}', "utf8");
      const authoritativeRebuild = writer.buildCanonicalPack(firstInput);
      expect(authoritativeRebuild.canonicalBytes).toEqual(originalFirstBytes);
      expect(authoritativeRebuild.evidencePackHash).toBe(
        firstWritten.evidencePackHash,
      );
      await expect(writer.writeCanonicalPack(firstInput)).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(await readFile(firstAbsolutePath, "utf8")).toBe(
        '{"tampered":true}',
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects a finite horizon that is ahead of the supplied World head", () => {
    const prepared = prepareBudgetEvidence();
    const input = buildInput(prepared);
    expect(() =>
      buildCanonicalEvidencePack({ ...input, worldHeadSeq: 19 }),
    ).toThrow(/finite horizon is ahead/);
  });
});
