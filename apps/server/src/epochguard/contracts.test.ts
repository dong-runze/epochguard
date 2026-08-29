import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as webContracts from "../../../web/src/epochguard/contracts.js";
import {
  AGENTS_BUSY_MESSAGE,
  ALREADY_REOBSERVING_MESSAGE,
  API_ERROR_STATUS,
  AgentDecisionEnvelopeSchema,
  ARTIFACT_REF_KINDS,
  ARTIFACT_REF_TARGETS,
  ActionIntentSchema,
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
  RejectedOutputArtifactSchema,
  RefreshSessionRequestSchema,
  ROLES,
  SESSION_NOT_FOUND_MESSAGE,
  SHARED_CONTRACT_SCHEMA_NAMES,
  STALE_VIEW_MESSAGE,
  SafetyDiagnosticSchema,
  ScenarioFixtureManifestEntrySchema,
  SessionDashboardSnapshotSchema,
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

function expectSnapshotRejected(candidate: unknown): void {
  expect(SessionDashboardSnapshotSchema.safeParse(candidate).success).toBe(false);
  expect(webContracts.safeDecodeSessionDashboardSnapshot(candidate).success).toBe(
    false,
  );
}

describe("EpochGuard frozen contract", () => {
  it("freezes v2 over complete JSON Schemas, invariants, fixtures, and Snapshots", () => {
    expect(CONTRACT_VERSION).toBe("epochguard-contract-v2");
    expect(CONTRACT_DIGEST).toBe(
      "sha256:0f16a9cb9f41cc64014ca8cc508a4f98b270cecf83882f328cb99994f7910d95",
    );
    expect(computeContractDigest()).toBe(CONTRACT_DIGEST);
    expect(computeContractDigest(CONTRACT_MANIFEST)).toBe(CONTRACT_DIGEST);

    const document = buildContractDigestDocument() as any;
    expect(document.algorithm).toEqual(CONTRACT_DIGEST_ALGORITHM);
    expect(document.schemas.AgentAttempt.properties.threadId.anyOf).toEqual(
      expect.arrayContaining([{ type: "null" }]),
    );
    expect(document.schemas.CreateSessionRequest.additionalProperties).toBe(false);
    expect(document.schemas.RejectedOutputArtifact).toBeDefined();
    expect(document.semanticInvariants).toEqual(CONTRACT_SEMANTIC_INVARIANTS);
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
    nestedNullability.schemas.AgentAttempt.properties.threadId.anyOf.pop();
    const commandDto = mutableClone(CONTRACT_MANIFEST);
    commandDto.schemas.CreateSessionRequest.$defs.__schema1.required.pop();
    const enumValue = mutableClone(CONTRACT_MANIFEST);
    enumValue.schemas.FailureCode.enum[0] = "UNFROZEN_CODE";
    const invariant = mutableClone(CONTRACT_MANIFEST);
    invariant.semanticInvariants[0] = "Action hash is not checked";
    const fixture = mutableClone(CONTRACT_MANIFEST);
    fixture.fixtures[0].expected.initialEffectsInSession = 1;

    for (const tampered of [
      nestedNullability,
      commandDto,
      enumValue,
      invariant,
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
    for (const [name, snapshot] of Object.entries(snapshots)) {
      expect(SessionDashboardSnapshotSchema.parse(snapshot), name).toEqual(snapshot);
      expect(webContracts.decodeSessionDashboardSnapshot(snapshot), name).toEqual(
        snapshot,
      );
      expect(sha256Digest(canonicalJson(snapshot)), name).toBe(
        GOLDEN_SNAPSHOT_HASHES[name as keyof typeof GOLDEN_SNAPSHOT_HASHES],
      );
    }
    expect(decodeSessionDashboardSnapshot(NORMAL_READY_GOLDEN_SNAPSHOT)).toEqual(
      NORMAL_READY_GOLDEN_SNAPSHOT,
    );
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
    expect(webContracts.ARTIFACT_REF_KINDS).toEqual(ARTIFACT_REF_KINDS);
    expect(webContracts.API_ERROR_STATUS).toEqual(API_ERROR_STATUS);
  });
});
