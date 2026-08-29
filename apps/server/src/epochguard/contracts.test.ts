import { describe, expect, it } from "vitest";
import * as webContracts from "../../../web/src/epochguard/contracts.js";
import {
  AGENTS_BUSY_MESSAGE,
  ALREADY_REOBSERVING_MESSAGE,
  AgentDecisionEnvelopeSchema,
  ARTIFACT_REF_KINDS,
  ARTIFACT_REF_TARGETS,
  ActionIntentSchema,
  ArtifactRefSchema,
  CommitSessionRequestSchema,
  CONTRACT_DIGEST,
  CONTRACT_MANIFEST,
  CONTRACT_VERSION,
  CreateSessionRequestSchema,
  FAILURE_CODES,
  GOLDEN_ACTION_CANONICAL,
  GOLDEN_ACTION_HASH,
  GOLDEN_ACTION_INPUT,
  GOLDEN_FIXTURE_MANIFEST,
  GOLDEN_QUERY_HASHES,
  IMPOSSIBLE_GOLDEN_SNAPSHOT,
  NORMAL_GOLDEN_SNAPSHOT,
  RefreshSessionRequestSchema,
  ROLES,
  STALE_VIEW_MESSAGE,
  SafetyDiagnosticSchema,
  EpochDatabaseSchema,
  ScenarioFixtureManifestEntrySchema,
  SessionDashboardSnapshotSchema,
  actionHash,
  buildRoleQuerySpec,
  canonicalJson,
  canonicalizeAction,
  computeContractDigest,
  decodeSessionDashboardSnapshot,
  makeAgentsBusyError,
  makeAlreadyReobservingError,
  makeStaleViewError,
  sha256Digest,
} from "./types.js";

describe("EpochGuard frozen contract", () => {
  it("freezes contract version and digest over the canonical manifest", () => {
    expect(CONTRACT_VERSION).toBe("epochguard-contract-v1");
    expect(CONTRACT_DIGEST).toBe(
      "sha256:dcf8815b991f475514e6387c9e78251c36d751e072fca0cc584267f55bd2718e",
    );
    expect(computeContractDigest()).toBe(CONTRACT_DIGEST);

    const tampered = structuredClone(CONTRACT_MANIFEST) as unknown as {
      p0Semantics: { exactlyOnceScope: string };
    };
    tampered.p0Semantics.exactlyOnceScope = "CROSS_SESSION";
    expect(computeContractDigest(tampered as never)).not.toBe(CONTRACT_DIGEST);
  });

  it("matches the Action and Role Query golden vectors", () => {
    expect(canonicalizeAction(GOLDEN_ACTION_INPUT)).toBe(GOLDEN_ACTION_CANONICAL);
    expect(actionHash(GOLDEN_ACTION_INPUT)).toBe(GOLDEN_ACTION_HASH);

    for (const role of ROLES) {
      const spec = buildRoleQuerySpec(GOLDEN_ACTION_INPUT, role);
      expect(spec.queryHash).toBe(GOLDEN_QUERY_HASHES[role]);
      expect(spec.actionHash).toBe(GOLDEN_ACTION_HASH);
      expect(spec.role).toBe(role);
      expect(spec.source).toBe(role);
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

  it("keeps ActionIntent strict while excluding identity fields from the Action hash", () => {
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
    expect(canonicalizeAction({ ...action, sessionId: "session_2" })).toBe(
      GOLDEN_ACTION_CANONICAL,
    );
    expect(
      ActionIntentSchema.safeParse({ ...action, actionHash: `sha256:${"f".repeat(64)}` })
        .success,
    ).toBe(false);
    expect(
      ActionIntentSchema.safeParse({ ...action, idempotencyKey: "cross-session" })
        .success,
    ).toBe(false);
  });

  it("freezes exact 409 conflict response bodies", () => {
    const stale = makeStaleViewError("session_1", 4, 5);
    expect(stale).toEqual({
      error: "STALE_VIEW",
      message: STALE_VIEW_MESSAGE,
      sessionId: "session_1",
      expectedSessionRevision: 4,
      actualSessionRevision: 5,
    });
    expect(Object.keys(stale)).toEqual([
      "error",
      "message",
      "sessionId",
      "expectedSessionRevision",
      "actualSessionRevision",
    ]);

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
    expect(webContracts.ConflictErrorBodySchema.parse(stale)).toEqual(stale);
    expect(webContracts.ConflictErrorBodySchema.parse(reobserving)).toEqual(
      reobserving,
    );
    expect(webContracts.ConflictErrorBodySchema.parse(busy)).toEqual(busy);
  });

  it("keeps command DTOs narrow and rejects browser-supplied trusted fields", () => {
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
        effectsInSession: 1,
      }).success,
    ).toBe(false);
  });

  it("closes FailureCode, Diagnostic, and ArtifactRef enums", () => {
    expect(new Set(FAILURE_CODES).size).toBe(FAILURE_CODES.length);
    expect(new Set(ARTIFACT_REF_KINDS).size).toBe(ARTIFACT_REF_KINDS.length);
    expect(Object.keys(ARTIFACT_REF_TARGETS).sort()).toEqual(
      [...ARTIFACT_REF_KINDS].sort(),
    );
    for (const kind of ARTIFACT_REF_KINDS) {
      expect(ArtifactRefSchema.parse({ kind, id: "artifact_1" })).toEqual({
        kind,
        id: "artifact_1",
      });
    }
    expect(
      ArtifactRefSchema.safeParse({ kind: "ABSOLUTE_PATH", id: "artifact_1" })
        .success,
    ).toBe(false);

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
    expect(
      SafetyDiagnosticSchema.safeParse({ ...diagnostic, absolutePath: "C:/secret" })
        .success,
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

  it("parses Normal and Impossible golden fixtures and snapshots on both sides", () => {
    for (const fixture of GOLDEN_FIXTURE_MANIFEST) {
      expect(ScenarioFixtureManifestEntrySchema.safeParse(fixture).success).toBe(
        true,
      );
    }

    expect(SessionDashboardSnapshotSchema.parse(NORMAL_GOLDEN_SNAPSHOT)).toEqual(
      NORMAL_GOLDEN_SNAPSHOT,
    );
    expect(
      SessionDashboardSnapshotSchema.parse(IMPOSSIBLE_GOLDEN_SNAPSHOT),
    ).toEqual(IMPOSSIBLE_GOLDEN_SNAPSHOT);
    expect(decodeSessionDashboardSnapshot(NORMAL_GOLDEN_SNAPSHOT)).toEqual(
      NORMAL_GOLDEN_SNAPSHOT,
    );
    expect(
      webContracts.decodeSessionDashboardSnapshot(NORMAL_GOLDEN_SNAPSHOT),
    ).toEqual(NORMAL_GOLDEN_SNAPSHOT);
    expect(
      webContracts.decodeSessionDashboardSnapshot(IMPOSSIBLE_GOLDEN_SNAPSHOT),
    ).toEqual(IMPOSSIBLE_GOLDEN_SNAPSHOT);

    expect(sha256Digest(canonicalJson(NORMAL_GOLDEN_SNAPSHOT))).toBe(
      "sha256:53f19c65de1c7ba3004ccdcf95f0e44a2724506e3122d3d1f184b7790e29222f",
    );
    expect(sha256Digest(canonicalJson(IMPOSSIBLE_GOLDEN_SNAPSHOT))).toBe(
      "sha256:ebe6d96bf3361b447a2240492718aa6a681e60d1805d49d164dfb3b5ef34d9d5",
    );
    expect(IMPOSSIBLE_GOLDEN_SNAPSHOT.jointValidity).toMatchObject({
      state: "NO_CUT",
      lowerBound: 21,
      upperBound: 20,
    });
    expect(IMPOSSIBLE_GOLDEN_SNAPSHOT.gate.effectsInSession).toBe(0);
    expect(NORMAL_GOLDEN_SNAPSHOT.gate.effectsInSession).toBe(1);
  });

  it("fails closed on unknown snapshot schema, digest, enum, extra fields, and role order", () => {
    const absolutePathSnapshot = structuredClone(NORMAL_GOLDEN_SNAPSHOT) as unknown as {
      agents: Array<{
        activeDecision: {
          runtimeProof: { evidencePackRelativePath: string };
        } | null;
      }>;
    };
    if (absolutePathSnapshot.agents[0]?.activeDecision) {
      absolutePathSnapshot.agents[0].activeDecision.runtimeProof.evidencePackRelativePath =
        "/tmp/agent/assignment.json";
    }
    const cases = [
      { ...NORMAL_GOLDEN_SNAPSHOT, schemaVersion: 2 },
      { ...NORMAL_GOLDEN_SNAPSHOT, contractDigest: `sha256:${"f".repeat(64)}` },
      { ...NORMAL_GOLDEN_SNAPSHOT, sessionState: "MYSTERY" },
      { ...NORMAL_GOLDEN_SNAPSHOT, secret: "must not pass" },
      {
        ...NORMAL_GOLDEN_SNAPSHOT,
        agents: [
          NORMAL_GOLDEN_SNAPSHOT.agents[1],
          NORMAL_GOLDEN_SNAPSHOT.agents[0],
          NORMAL_GOLDEN_SNAPSHOT.agents[2],
        ],
      },
      absolutePathSnapshot,
    ];
    for (const candidate of cases) {
      expect(SessionDashboardSnapshotSchema.safeParse(candidate).success).toBe(
        false,
      );
      expect(
        webContracts.safeDecodeSessionDashboardSnapshot(candidate).success,
      ).toBe(false);
    }
  });

  it("keeps server and Web frozen constants identical", () => {
    expect(webContracts.CONTRACT_VERSION).toBe(CONTRACT_VERSION);
    expect(webContracts.CONTRACT_DIGEST).toBe(CONTRACT_DIGEST);
    expect(webContracts.ROLES).toEqual(ROLES);
    expect(webContracts.FAILURE_CODES).toEqual(FAILURE_CODES);
    expect(webContracts.ARTIFACT_REF_KINDS).toEqual(ARTIFACT_REF_KINDS);
  });
});
