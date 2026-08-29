import { z } from "zod";

export const CONTRACT_VERSION = "epochguard-contract-v5" as const;
export const CONTRACT_SCHEMA_VERSION = 1 as const;
export const CONTRACT_DIGEST =
  "sha256:da04cd74212dc564efd3349790d64f27691bd8a2b073d9663949e322da7b5ae8" as const;

export const ROLES = ["inventory", "budget", "policy"] as const;
export const SCENARIO_IDS = ["normal-world-v1", "impossible-collage-v1"] as const;
export const SESSION_STATES = [
  "CREATED",
  "DISPATCHING",
  "COLLECTING",
  "VALIDATING",
  "BLOCKED_NO_CUT",
  "HISTORICAL_STALE",
  "REOBSERVING",
  "UNSTABLE_WORLD",
  "CONSISTENT_DENY",
  "READY_AT_CURRENT_HEAD",
  "COMMITTING",
  "COMMITTED",
  "COMMIT_RACE",
  "FAILED",
  "INTERRUPTED",
] as const;
export const FAILURE_CODES = [
  "ROLE_PROFILE_MISMATCH",
  "AGENTS_BUSY",
  "RUN_FAILED",
  "RUN_TIMEOUT",
  "OUTPUT_MALFORMED",
  "BINDING_MISMATCH",
  "DECISION_INVALID",
  "ACTION_HASH_MISMATCH",
  "QUERY_HASH_MISMATCH",
  "HISTORY_UNVERIFIABLE",
  "UNVERIFIABLE_SOURCE",
  "UNCOMPARABLE_CLOCKS",
  "NO_VALID_OBSERVED_WORLD_CUT",
  "HISTORICAL_BUT_STALE_NOW",
  "CONSISTENT_DENY",
  "UNSTABLE_WORLD",
  "COMMIT_RACE",
  "ALREADY_REOBSERVING",
  "STALE_VIEW",
  "MISSING_ACTION_FIELDS",
  "SESSION_NOT_FOUND",
  "UNSUPPORTED_SCHEMA",
  "PROJECTION_MISMATCH",
] as const;
export const REFRESH_PLAN_REASON_CODES = [
  "NO_VALID_OBSERVED_WORLD_CUT",
  "HISTORICAL_BUT_STALE_NOW",
] as const;
export const ARTIFACT_REF_KINDS = [
  "ATTEMPT",
  "ASSIGNMENT",
  "RUN",
  "ENVELOPE_DIGEST",
  "REJECTED_OUTPUT",
  "RECEIPT",
  "SOURCE_VERSION",
  "VALIDATION",
  "PROOF",
  "REFRESH_PLAN",
  "PERMIT",
  "EFFECT",
] as const;

export const TimestampSchema = z.string().datetime({ offset: true });
export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const EvidencePackRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(
    /^\.epochguard\/sessions\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(inventory|budget|policy)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/,
  );
export const RoleSchema = z.enum(ROLES);
export const ScenarioIdSchema = z.enum(SCENARIO_IDS);
export const SessionStateSchema = z.enum(SESSION_STATES);
export const FailureCodeSchema = z.enum(FAILURE_CODES);
export const RefreshPlanReasonCodeSchema = z.enum(REFRESH_PLAN_REASON_CODES);
export const ArtifactRefKindSchema = z.enum(ARTIFACT_REF_KINDS);

export type Role = z.infer<typeof RoleSchema>;
export type FailureCode = z.infer<typeof FailureCodeSchema>;
export type RefreshPlanReasonCode = z.infer<
  typeof RefreshPlanReasonCodeSchema
>;

const RunUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

const OpaqueArtifactRefKindSchema = z.enum(
  ARTIFACT_REF_KINDS.filter((kind) => kind !== "ENVELOPE_DIGEST") as [
    Exclude<(typeof ARTIFACT_REF_KINDS)[number], "ENVELOPE_DIGEST">,
    ...Exclude<(typeof ARTIFACT_REF_KINDS)[number], "ENVELOPE_DIGEST">[],
  ],
);
export const ArtifactRefSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("ENVELOPE_DIGEST"), id: Sha256DigestSchema })
    .strict(),
  z.object({ kind: OpaqueArtifactRefKindSchema, id: OpaqueIdSchema }).strict(),
]);
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

const SafetyDiagnosticViewSchema = z
  .object({
    diagnosticId: OpaqueIdSchema,
    kind: z.enum(["EXPECTED_BLOCK", "SYSTEM_FAILURE", "TRANSIENT_RACE"]),
    stage: z.enum([
      "DISPATCH",
      "RUN",
      "PARSE",
      "NORMALIZE",
      "COMPOSE",
      "VALIDATE",
      "PLAN_REFRESH",
      "ISSUE_PERMIT",
      "COMMIT",
      "EFFECT",
      "PROJECTION",
    ]),
    reasonCode: FailureCodeSchema,
    role: RoleSchema.nullable(),
    relevantIds: z.array(ArtifactRefSchema),
    auditSeq: z.number().int().nonnegative(),
    recommendedAction: z.enum(["NONE", "NEW_SESSION", "REOBSERVE_INVALID"]),
  })
  .strict();

const RedactedDashboardEventSchema = z
  .object({
    eventId: OpaqueIdSchema,
    sequence: z.number().int().nonnegative(),
    type: z.string().min(1).max(128),
    status: z.string().min(1).max(128),
    role: RoleSchema.nullable(),
    summary: z.string().min(1).max(1_000),
    createdAt: TimestampSchema,
  })
  .strict();

const ReceiptViewSchema = z
  .object({
    receiptId: OpaqueIdSchema,
    sourceRevision: z.number().int().nonnegative(),
    observedAtSeq: z.number().int().nonnegative(),
    validFromSeq: z.number().int().nonnegative(),
    validUntilSeq: z.number().int().nonnegative().nullable(),
  })
  .strict();

const RuntimeProofViewSchema = z
  .object({
    assignmentId: OpaqueIdSchema,
    threadId: z.string().min(1).max(512).nullable(),
    runtimeLabel: z.string().min(1).max(256),
    roleProfileVersion: OpaqueIdSchema,
    promptTemplateVersion: OpaqueIdSchema,
    agentsMdDigest: Sha256DigestSchema,
    evidencePackRelativePath: EvidencePackRelativePathSchema,
    evidencePackHash: Sha256DigestSchema,
    runStartedAt: TimestampSchema.nullable(),
    runCompletedAt: TimestampSchema.nullable(),
    outputDigest: Sha256DigestSchema.nullable(),
    usage: RunUsageSchema.nullable(),
  })
  .strict();

const ActiveDecisionViewSchema = z
  .object({
    certificateId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    verdict: z.enum(["ALLOW", "DENY"]),
    factSummary: z.string().min(1).max(500),
    evidenceState: z.enum(["CURRENT", "RETAINED", "INVALID_AT_HEAD"]),
    receipt: ReceiptViewSchema,
    runtimeProof: RuntimeProofViewSchema,
  })
  .strict();

const InFlightAttemptViewSchema = z
  .object({
    attemptId: OpaqueIdSchema,
    assignmentId: OpaqueIdSchema,
    runId: OpaqueIdSchema.nullable(),
    status: z.enum([
      "ASSIGNMENT_CREATED",
      "DISPATCHING",
      "QUEUED",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "INTERRUPTED",
      "OUTPUT_REJECTED",
    ]),
    runStartedAt: TimestampSchema.nullable(),
    runCompletedAt: TimestampSchema.nullable(),
  })
  .strict();

const AgentSnapshotViewSchema = z
  .object({
    role: RoleSchema,
    agentId: OpaqueIdSchema,
    agentNameAtAssignment: z.string().min(1).max(80),
    runCount: z.number().int().nonnegative(),
    activeDecision: ActiveDecisionViewSchema.nullable(),
    inFlightAttempt: InFlightAttemptViewSchema.nullable(),
  })
  .strict();

const NoCutProofViewSchema = z
  .object({
    proofId: OpaqueIdSchema,
    dependencySetHash: Sha256DigestSchema,
    lowerBound: z.number().int().nonnegative(),
    upperBound: z.number().int().nonnegative(),
    witness: z
      .array(
        z
          .object({
            role: RoleSchema,
            receiptId: OpaqueIdSchema,
            from: z.number().int().nonnegative(),
            until: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      )
      .length(2),
  })
  .strict();

const SnapshotActionViewSchema = z
  .object({
    type: z.literal("PUBLISH_CAMPAIGN"),
    campaignId: OpaqueIdSchema,
    requestedUnits: z.number().int().positive(),
    estimatedCostCents: z.number().int().nonnegative(),
    market: z.literal("SG"),
  })
  .strict();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f,
  0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;
const SHA256_ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
  0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
  0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
  0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

function sha256Text(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const state: number[] = [...SHA256_INITIAL];

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const prior15 = words[index - 15] ?? 0;
      const prior2 = words[index - 2] ?? 0;
      const sigma0 =
        rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ (prior15 >>> 3);
      const sigma1 =
        rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ (prior2 >>> 10);
      words[index] =
        ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const upper =
        rotateRight(e ?? 0, 6) ^ rotateRight(e ?? 0, 11) ^ rotateRight(e ?? 0, 25);
      const choice = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temporary1 =
        ((h ?? 0) + upper + choice + (SHA256_ROUND[index] ?? 0) +
          (words[index] ?? 0)) >>>
        0;
      const lower =
        rotateRight(a ?? 0, 2) ^ rotateRight(a ?? 0, 13) ^ rotateRight(a ?? 0, 22);
      const majority =
        ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temporary2 = (lower + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = ((d ?? 0) + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) {
      state[index] = ((state[index] ?? 0) + (next[index] ?? 0)) >>> 0;
    }
  }

  return `sha256:${state
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("")}`;
}

function snapshotActionHash(action: {
  type: "PUBLISH_CAMPAIGN";
  campaignId: string;
  requestedUnits: number;
  estimatedCostCents: number;
  market: "SG";
}): string {
  return sha256Text(canonicalJson({ schemaVersion: 1, ...action }));
}

const SessionDashboardSnapshotShapeSchema = z
  .object({
    schemaVersion: z.literal(1),
    contractVersion: z.literal(CONTRACT_VERSION),
    contractDigest: z.literal(CONTRACT_DIGEST),
    snapshotRevision: z.number().int().nonnegative(),
    sessionRevision: z.number().int().nonnegative(),
    stateUpdatedAt: TimestampSchema,
    generatedAt: TimestampSchema,
    sessionId: OpaqueIdSchema,
    scenarioId: ScenarioIdSchema,
    coordinationMode: z.enum(["PENDING", "CONCURRENT", "SEQUENTIAL_FALLBACK"]),
    sessionState: SessionStateSchema,
    action: SnapshotActionViewSchema,
    actionHash: Sha256DigestSchema,
    worldHead: z.number().int().nonnegative(),
    gate: z
      .object({
        state: z.enum(["WAITING", "CHECKING", "LOCKED", "READY", "RELEASED", "FAILED"]),
        reasonCode: FailureCodeSchema.nullable(),
        effectsInSession: z.number().int().nonnegative(),
        permitId: OpaqueIdSchema.nullable(),
        effectId: OpaqueIdSchema.nullable(),
      })
      .strict(),
    metrics: z
      .object({
        activeDecisions: z.number().int().min(0).max(3),
        requiredDecisions: z.literal(3),
        allowDecisions: z.number().int().min(0).max(3),
        denyDecisions: z.number().int().min(0).max(3),
        reobservedAgents: z.number().int().min(0).max(3),
        totalAgents: z.literal(3),
        rerunsAvoided: z.number().int().min(0).max(2),
        verificationLatencyMs: z.number().nonnegative().nullable(),
      })
      .strict(),
    agents: z.array(AgentSnapshotViewSchema).length(3),
    jointValidity: z
      .object({
        state: z.enum(["PENDING", "VALID_CURRENT", "NO_CUT", "HISTORICAL_STALE"]),
        lowerBound: z.number().int().nonnegative().nullable(),
        upperBound: z.number().int().nonnegative().nullable(),
        currentHeadCovered: z.boolean().nullable(),
        noCutProof: NoCutProofViewSchema.nullable(),
      })
      .strict(),
    refreshPlan: z
      .object({
        refreshPlanId: OpaqueIdSchema,
        status: z.enum(["AVAILABLE", "CLAIMED", "COMPLETED"]),
        agentIds: z.array(OpaqueIdSchema).min(1).max(3),
        reasonCode: RefreshPlanReasonCodeSchema,
      })
      .strict()
      .nullable(),
    availableActions: z.array(z.enum(["REOBSERVE_INVALID", "COMMIT"])).max(2),
    latestDiagnostics: z.array(SafetyDiagnosticViewSchema).max(3),
    events: z.array(RedactedDashboardEventSchema).max(6),
  })
  .strict();

type SessionDashboardSnapshotCandidate = z.infer<
  typeof SessionDashboardSnapshotShapeSchema
>;

type AuthoritativeSnapshotProjectionRule = {
  gateState: SessionDashboardSnapshotCandidate["gate"]["state"];
  reasonCode: FailureCode | null;
  jointValidityState: SessionDashboardSnapshotCandidate["jointValidity"]["state"];
  permit: "REQUIRED" | "FORBIDDEN";
  effect: "REQUIRED" | "FORBIDDEN";
  refreshPlan: "AVAILABLE" | "ABSENT_OR_COMPLETED";
  decisions:
    | "THREE"
    | "THREE_CURRENT_VALID_ALLOW"
    | "THREE_CURRENT_VALID_WITH_DENY";
  availableActions: readonly SessionDashboardSnapshotCandidate["availableActions"][number][];
  inFlightAttempts: "FORBIDDEN";
};

export const AUTHORITATIVE_SNAPSHOT_PROJECTION_RULES = {
  BLOCKED_NO_CUT: {
    gateState: "LOCKED",
    reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
    jointValidityState: "NO_CUT",
    permit: "FORBIDDEN",
    effect: "FORBIDDEN",
    refreshPlan: "AVAILABLE",
    decisions: "THREE",
    availableActions: ["REOBSERVE_INVALID"],
    inFlightAttempts: "FORBIDDEN",
  },
  HISTORICAL_STALE: {
    gateState: "LOCKED",
    reasonCode: "HISTORICAL_BUT_STALE_NOW",
    jointValidityState: "HISTORICAL_STALE",
    permit: "FORBIDDEN",
    effect: "FORBIDDEN",
    refreshPlan: "AVAILABLE",
    decisions: "THREE",
    availableActions: ["REOBSERVE_INVALID"],
    inFlightAttempts: "FORBIDDEN",
  },
  CONSISTENT_DENY: {
    gateState: "LOCKED",
    reasonCode: "CONSISTENT_DENY",
    jointValidityState: "VALID_CURRENT",
    permit: "FORBIDDEN",
    effect: "FORBIDDEN",
    refreshPlan: "ABSENT_OR_COMPLETED",
    decisions: "THREE_CURRENT_VALID_WITH_DENY",
    availableActions: [],
    inFlightAttempts: "FORBIDDEN",
  },
  READY_AT_CURRENT_HEAD: {
    gateState: "READY",
    reasonCode: null,
    jointValidityState: "VALID_CURRENT",
    permit: "REQUIRED",
    effect: "FORBIDDEN",
    refreshPlan: "ABSENT_OR_COMPLETED",
    decisions: "THREE_CURRENT_VALID_ALLOW",
    availableActions: ["COMMIT"],
    inFlightAttempts: "FORBIDDEN",
  },
  COMMITTED: {
    gateState: "RELEASED",
    reasonCode: null,
    jointValidityState: "VALID_CURRENT",
    permit: "REQUIRED",
    effect: "REQUIRED",
    refreshPlan: "ABSENT_OR_COMPLETED",
    decisions: "THREE_CURRENT_VALID_ALLOW",
    availableActions: [],
    inFlightAttempts: "FORBIDDEN",
  },
} as const satisfies Record<string, AuthoritativeSnapshotProjectionRule>;

export const SNAPSHOT_UNIVERSAL_SAFETY_RULES = {
  actionHash: "validate Snapshot Action shape before canonical hashing; safeParse never throws",
  receiptTemporal: [
    "validUntilSeq=null or validUntilSeq>validFromSeq",
    "finite validUntilSeq<=worldHead",
    "validFromSeq<=observedAtSeq",
    "observedAtSeq<(validUntilSeq??worldHead+1)",
    "observedAtSeq<=worldHead",
  ],
  uniqueIdentityNamespaces: {
    certificate: ["activeDecision.certificateId"],
    run: ["activeDecision.runId", "inFlightAttempt.runId(non-null)"],
    receipt: ["activeDecision.receipt.receiptId"],
    assignment: [
      "activeDecision.runtimeProof.assignmentId",
      "inFlightAttempt.assignmentId",
    ],
    attempt: ["inFlightAttempt.attemptId"],
  },
  refreshLifecycle: {
    reasonCodes: REFRESH_PLAN_REASON_CODES,
    claimedStates: ["REOBSERVING", "COLLECTING"],
    claimedTerminalExceptions: ["FAILED", "INTERRUPTED"],
    reobserving:
      "three retained old Decisions; plan owners = invalid Receipt owners = active in-flight owners",
    collecting:
      "plan owners partition into current-valid completed owners and invalid remaining in-flight owners",
    validating:
      "null initial Plan or COMPLETED refresh Plan with three active current-valid Decisions and no in-flight Attempt",
    ownerAttempt:
      "active pre-acceptance Attempt with new Assignment and, when non-null, new Run ID",
  },
  noCutDependencySetHash:
    "sha256(canonicalJSON(sort(all three active receiptIds)))",
  noCutWitness: {
    order: ["canonical earliest-ending Receipt", "canonical latest-starting Receipt"],
    tieBreak: "UTF-16 code-unit lexicographically smallest receiptId for each endpoint",
  },
} as const;

const CLAIMED_REFRESH_STATES =
  SNAPSHOT_UNIVERSAL_SAFETY_RULES.refreshLifecycle.claimedStates;
const CLAIMED_REFRESH_TERMINAL_EXCEPTIONS =
  SNAPSHOT_UNIVERSAL_SAFETY_RULES.refreshLifecycle.claimedTerminalExceptions;
const ACTIVE_IN_FLIGHT_ATTEMPT_STATES = [
  "ASSIGNMENT_CREATED",
  "DISPATCHING",
  "QUEUED",
  "RUNNING",
] as const;

type AuthoritativeSnapshotState =
  keyof typeof AUTHORITATIVE_SNAPSHOT_PROJECTION_RULES;

function authoritativeProjectionRule(
  state: SessionDashboardSnapshotCandidate["sessionState"],
): AuthoritativeSnapshotProjectionRule | null {
  return Object.prototype.hasOwnProperty.call(
    AUTHORITATIVE_SNAPSHOT_PROJECTION_RULES,
    state,
  )
    ? AUTHORITATIVE_SNAPSHOT_PROJECTION_RULES[
        state as AuthoritativeSnapshotState
      ]
    : null;
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    left.length === right.length &&
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    [...leftSet].every((id) => rightSet.has(id))
  );
}

function compareLexicographicIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function receiptCoversWorldHead(
  snapshot: SessionDashboardSnapshotCandidate,
  decision: NonNullable<
    SessionDashboardSnapshotCandidate["agents"][number]["activeDecision"]
  >,
): boolean {
  return (
    decision.receipt.validFromSeq <= snapshot.worldHead &&
    (decision.receipt.validUntilSeq === null ||
      snapshot.worldHead < decision.receipt.validUntilSeq)
  );
}

function receiptHasValidTemporalSemantics(
  snapshot: SessionDashboardSnapshotCandidate,
  receipt: NonNullable<
    SessionDashboardSnapshotCandidate["agents"][number]["activeDecision"]
  >["receipt"],
): boolean {
  const effectiveUntil = receipt.validUntilSeq ?? snapshot.worldHead + 1;
  return (
    (receipt.validUntilSeq === null ||
      (receipt.validUntilSeq > receipt.validFromSeq &&
        receipt.validUntilSeq <= snapshot.worldHead)) &&
    receipt.validFromSeq <= receipt.observedAtSeq &&
    receipt.observedAtSeq < effectiveUntil &&
    receipt.observedAtSeq <= snapshot.worldHead
  );
}

export function snapshotReceiptDependencySetHash(
  receiptIds: readonly string[],
): string {
  return sha256Text(canonicalJson([...receiptIds].sort()));
}

type SnapshotAgentCandidate =
  SessionDashboardSnapshotCandidate["agents"][number];

function refreshReasonForJointValidity(
  state: SessionDashboardSnapshotCandidate["jointValidity"]["state"],
): RefreshPlanReasonCode | null {
  if (state === "NO_CUT") return "NO_VALID_OBSERVED_WORLD_CUT";
  if (state === "HISTORICAL_STALE") return "HISTORICAL_BUT_STALE_NOW";
  return null;
}

function agentDecisionIsCurrentValid(
  snapshot: SessionDashboardSnapshotCandidate,
  agent: SnapshotAgentCandidate,
): boolean {
  return (
    agent.activeDecision !== null &&
    agent.activeDecision.evidenceState !== "INVALID_AT_HEAD" &&
    receiptCoversWorldHead(snapshot, agent.activeDecision)
  );
}

function agentDecisionIsInvalidAtHead(
  snapshot: SessionDashboardSnapshotCandidate,
  agent: SnapshotAgentCandidate,
): boolean {
  return (
    agent.activeDecision !== null &&
    agent.activeDecision.evidenceState === "INVALID_AT_HEAD" &&
    !receiptCoversWorldHead(snapshot, agent.activeDecision)
  );
}

function agentHasActiveNewRefreshAttempt(agent: SnapshotAgentCandidate): boolean {
  const decision = agent.activeDecision;
  const attempt = agent.inFlightAttempt;
  return (
    decision !== null &&
    attempt !== null &&
    (ACTIVE_IN_FLIGHT_ATTEMPT_STATES as readonly string[]).includes(
      attempt.status,
    ) &&
    agent.runCount > 1 &&
    attempt.assignmentId !== decision.runtimeProof.assignmentId &&
    (attempt.runId === null || attempt.runId !== decision.runId)
  );
}

function validateUniqueSnapshotIdentityReferences(
  snapshot: SessionDashboardSnapshotCandidate,
  context: z.RefinementCtx,
): void {
  type IdentityReference = { id: string | null; agentIndex: number };
  const namespaces: Array<{
    name: string;
    references: IdentityReference[];
  }> = [
    {
      name: "certificateId",
      references: snapshot.agents.map((agent, agentIndex) => ({
        id: agent.activeDecision?.certificateId ?? null,
        agentIndex,
      })),
    },
    {
      name: "receiptId",
      references: snapshot.agents.map((agent, agentIndex) => ({
        id: agent.activeDecision?.receipt.receiptId ?? null,
        agentIndex,
      })),
    },
    {
      name: "attemptId",
      references: snapshot.agents.map((agent, agentIndex) => ({
        id: agent.inFlightAttempt?.attemptId ?? null,
        agentIndex,
      })),
    },
    {
      name: "assignmentId",
      references: snapshot.agents.flatMap((agent, agentIndex) => [
        {
          id: agent.activeDecision?.runtimeProof.assignmentId ?? null,
          agentIndex,
        },
        { id: agent.inFlightAttempt?.assignmentId ?? null, agentIndex },
      ]),
    },
    {
      name: "runId",
      references: snapshot.agents.flatMap((agent, agentIndex) => [
        { id: agent.activeDecision?.runId ?? null, agentIndex },
        { id: agent.inFlightAttempt?.runId ?? null, agentIndex },
      ]),
    },
  ];

  for (const namespace of namespaces) {
    const ownerById = new Map<string, number>();
    let duplicatedAcrossAgents = false;
    for (const reference of namespace.references) {
      if (reference.id === null) continue;
      const existingOwner = ownerById.get(reference.id);
      if (
        existingOwner !== undefined &&
        existingOwner !== reference.agentIndex
      ) {
        duplicatedAcrossAgents = true;
      } else {
        ownerById.set(reference.id, reference.agentIndex);
      }
    }
    if (duplicatedAcrossAgents) {
      snapshotIssue(
        context,
        `${namespace.name} values must be unique across Agent projections within their ID namespace`,
        ["agents"],
      );
    }
  }
}

function snapshotIssue(
  context: z.RefinementCtx,
  message: string,
  path: PropertyKey[],
): void {
  context.addIssue({ code: "custom", message, path });
}

function addSnapshotInvariantIssues(
  snapshot: SessionDashboardSnapshotCandidate,
  context: z.RefinementCtx,
): void {
  if (snapshot.agents.map((agent) => agent.role).join(",") !== ROLES.join(",")) {
    snapshotIssue(context, "agents must be ordered inventory, budget, policy", [
      "agents",
    ]);
  }
  if (new Set(snapshot.agents.map((agent) => agent.agentId)).size !== 3) {
    snapshotIssue(context, "agents must contain three distinct Agent identities", [
      "agents",
    ]);
  }
  validateUniqueSnapshotIdentityReferences(snapshot, context);

  const decisions = snapshot.agents.flatMap((agent) =>
    agent.activeDecision === null ? [] : [agent.activeDecision],
  );
  const allowDecisions = decisions.filter(
    (decision) => decision.verdict === "ALLOW",
  ).length;
  const denyDecisions = decisions.length - allowDecisions;
  const reobservedAgentIds = snapshot.agents
    .filter((agent) => agent.runCount > 1)
    .map((agent) => agent.agentId);
  const reobservedAgents = reobservedAgentIds.length;
  const projectionRule = authoritativeProjectionRule(snapshot.sessionState);
  const decisionsValidAtHead =
    decisions.length === 3 &&
    decisions.every(
      (decision) =>
        decision.evidenceState !== "INVALID_AT_HEAD" &&
        receiptCoversWorldHead(snapshot, decision),
    );
  if (
    snapshot.metrics.activeDecisions !== decisions.length ||
    snapshot.metrics.allowDecisions !== allowDecisions ||
    snapshot.metrics.denyDecisions !== denyDecisions ||
    snapshot.metrics.reobservedAgents !== reobservedAgents
  ) {
    snapshotIssue(context, "decision and run metrics must match Agent projections", [
      "metrics",
    ]);
  }
  snapshot.agents.forEach((agent, index) => {
    const representedRuns =
      (agent.activeDecision === null ? 0 : 1) +
      (agent.inFlightAttempt === null ? 0 : 1);
    if (agent.runCount < representedRuns) {
      snapshotIssue(context, "runCount cannot be lower than represented runs", [
        "agents",
        index,
        "runCount",
      ]);
    }
    if (agent.activeDecision !== null) {
      if (
        !receiptHasValidTemporalSemantics(
          snapshot,
          agent.activeDecision.receipt,
        )
      ) {
        snapshotIssue(
          context,
          "Receipt observation and half-open validity interval must be temporally coherent at worldHead",
          ["agents", index, "activeDecision", "receipt"],
        );
      }
      const coversHead = receiptCoversWorldHead(
        snapshot,
        agent.activeDecision,
      );
      const evidenceClaimsHeadValidity =
        agent.activeDecision.evidenceState !== "INVALID_AT_HEAD";
      if (evidenceClaimsHeadValidity !== coversHead) {
        snapshotIssue(
          context,
          "Decision evidenceState must agree with half-open Receipt coverage at worldHead",
          ["agents", index, "activeDecision", "evidenceState"],
        );
      }
    }
  });

  const parsedSnapshotAction = SnapshotActionViewSchema.safeParse(
    snapshot.action,
  );
  if (
    parsedSnapshotAction.success &&
    snapshot.actionHash !== snapshotActionHash(parsedSnapshotAction.data)
  ) {
    snapshotIssue(context, "actionHash does not match the Snapshot Action", [
      "actionHash",
    ]);
  }

  if (projectionRule !== null) {
    if (
      snapshot.gate.state !== projectionRule.gateState ||
      snapshot.gate.reasonCode !== projectionRule.reasonCode ||
      snapshot.jointValidity.state !== projectionRule.jointValidityState
    ) {
      snapshotIssue(
        context,
        "Authoritative Session state requires its exact Gate, reason, and joint-validity projection",
        ["sessionState"],
      );
    }
    const permitPresent = snapshot.gate.permitId !== null;
    if ((projectionRule.permit === "REQUIRED") !== permitPresent) {
      snapshotIssue(context, "Permit presence must match authoritative Session state", [
        "gate",
        "permitId",
      ]);
    }
    const effectPresent = snapshot.gate.effectId !== null;
    if (
      (projectionRule.effect === "REQUIRED") !== effectPresent ||
      snapshot.gate.effectsInSession !==
        (projectionRule.effect === "REQUIRED" ? 1 : 0)
    ) {
      snapshotIssue(context, "Effect presence/count must match authoritative Session state", [
        "gate",
      ]);
    }
    if (snapshot.agents.some((agent) => agent.inFlightAttempt !== null)) {
      snapshotIssue(
        context,
        "Authoritative stable Session states cannot retain an in-flight Attempt",
        ["agents"],
      );
    }
    const decisionsMatch =
      projectionRule.decisions === "THREE"
        ? decisions.length === 3
        : projectionRule.decisions === "THREE_CURRENT_VALID_ALLOW"
          ? decisionsValidAtHead && allowDecisions === 3
          : decisionsValidAtHead && denyDecisions > 0;
    if (!decisionsMatch) {
      snapshotIssue(
        context,
        "Active Decisions must match the authoritative Session outcome",
        ["agents"],
      );
    }
  }

  if (
    snapshot.gate.state === "READY" &&
    snapshot.sessionState !== "READY_AT_CURRENT_HEAD"
  ) {
    snapshotIssue(context, "READY Gate is reserved for READY_AT_CURRENT_HEAD", [
      "gate",
      "state",
    ]);
  }
  if (
    snapshot.gate.reasonCode === "CONSISTENT_DENY" &&
    snapshot.sessionState !== "CONSISTENT_DENY"
  ) {
    snapshotIssue(
      context,
      "CONSISTENT_DENY reason is reserved for the CONSISTENT_DENY outcome",
      ["gate", "reasonCode"],
    );
  }
  if (
    snapshot.gate.state === "LOCKED" &&
    snapshot.gate.permitId !== null
  ) {
    snapshotIssue(context, "LOCKED Gate cannot carry a Permit", [
      "gate",
      "permitId",
    ]);
  }
  if (
    snapshot.gate.permitId !== null &&
    !["READY_AT_CURRENT_HEAD", "COMMITTING", "COMMITTED"].includes(
      snapshot.sessionState,
    )
  ) {
    snapshotIssue(context, "Permit is restricted to ready/commit projections", [
      "gate",
      "permitId",
    ]);
  }
  if (
    snapshot.sessionState === "FAILED" &&
    snapshot.gate.state === "WAITING" &&
    snapshot.gate.reasonCode === null
  ) {
    snapshotIssue(
      context,
      "FAILED cannot masquerade as an unreasoned WAITING projection",
      ["gate"],
    );
  }

  if (snapshot.gate.state === "RELEASED") {
    if (
      snapshot.gate.effectsInSession !== 1 ||
      snapshot.gate.effectId === null ||
      snapshot.gate.permitId === null ||
      snapshot.sessionState !== "COMMITTED" ||
      snapshot.jointValidity.state !== "VALID_CURRENT" ||
      decisions.length !== 3 ||
      allowDecisions !== 3 ||
      !decisionsValidAtHead ||
      snapshot.availableActions.length !== 0
    ) {
      snapshotIssue(
        context,
        "RELEASED requires COMMITTED, one Permit-bound Effect, three current-valid ALLOW Decisions, and no action",
        ["gate"],
      );
    }
  } else if (
    snapshot.gate.effectsInSession !== 0 ||
    snapshot.gate.effectId !== null
  ) {
    snapshotIssue(context, "non-RELEASED snapshots cannot project an Effect", [
      "gate",
    ]);
  }
  if (snapshot.sessionState === "COMMITTED" && snapshot.gate.state !== "RELEASED") {
    snapshotIssue(context, "COMMITTED must project a RELEASED Gate", ["sessionState"]);
  }
  if (
    snapshot.gate.state === "READY" &&
    (snapshot.sessionState !== "READY_AT_CURRENT_HEAD" ||
      snapshot.gate.permitId === null ||
      snapshot.jointValidity.state !== "VALID_CURRENT" ||
      allowDecisions !== 3)
  ) {
    snapshotIssue(
      context,
      "READY requires READY_AT_CURRENT_HEAD, a Permit, and three ALLOW Decisions",
      ["gate"],
    );
  }

  const receiptEntries = snapshot.agents.flatMap((agent) =>
    agent.activeDecision === null
      ? []
      : [{ role: agent.role, receipt: agent.activeDecision.receipt }],
  );
  const receipts = receiptEntries.map((entry) => entry.receipt);
  const expectedDependencySetHash =
    receipts.length === 3
      ? snapshotReceiptDependencySetHash(
          receipts.map((receipt) => receipt.receiptId),
        )
      : null;
  const expectedLower =
    receipts.length === 3
      ? Math.max(...receipts.map((receipt) => receipt.validFromSeq))
      : null;
  const expectedUpper =
    receipts.length === 3
      ? Math.min(
          ...receipts.map(
            (receipt) => receipt.validUntilSeq ?? snapshot.worldHead + 1,
          ),
        )
      : null;

  if (snapshot.jointValidity.state === "VALID_CURRENT") {
    const validAtHead =
      expectedLower !== null &&
      expectedUpper !== null &&
      expectedLower < expectedUpper &&
      expectedLower <= snapshot.worldHead &&
      snapshot.worldHead < expectedUpper;
    if (
      snapshot.jointValidity.noCutProof !== null ||
      snapshot.jointValidity.currentHeadCovered !== true ||
      snapshot.jointValidity.lowerBound !== expectedLower ||
      snapshot.jointValidity.upperBound !== expectedUpper ||
      !validAtHead
    ) {
      snapshotIssue(
        context,
        "VALID_CURRENT bounds, proof, and current-head coverage must reconcile",
        ["jointValidity"],
      );
    }
  } else if (snapshot.jointValidity.state === "NO_CUT") {
    const proof = snapshot.jointValidity.noCutProof;
    const canonicalLatestStart =
      expectedLower === null
        ? null
        : (receiptEntries
            .filter((entry) => entry.receipt.validFromSeq === expectedLower)
            .sort((left, right) =>
              compareLexicographicIds(
                left.receipt.receiptId,
                right.receipt.receiptId,
              ),
            )[0] ?? null);
    const canonicalEarliestEnd =
      expectedUpper === null
        ? null
        : (receiptEntries
            .filter(
              (entry) => entry.receipt.validUntilSeq === expectedUpper,
            )
            .sort((left, right) =>
              compareLexicographicIds(
                left.receipt.receiptId,
                right.receipt.receiptId,
              ),
            )[0] ?? null);
    const boundsAgree =
      proof !== null &&
      snapshot.jointValidity.lowerBound === proof.lowerBound &&
      snapshot.jointValidity.upperBound === proof.upperBound &&
      proof.lowerBound === expectedLower &&
      proof.upperBound === expectedUpper &&
      proof.lowerBound >= proof.upperBound &&
      proof.dependencySetHash === expectedDependencySetHash &&
      snapshot.jointValidity.currentHeadCovered === false;
    const canonicalWitnessEntries = [
      canonicalEarliestEnd,
      canonicalLatestStart,
    ] as const;
    const witnessAgrees =
      proof !== null &&
      canonicalWitnessEntries.every((entry, index) => {
        const witness = proof.witness[index];
        return (
          entry !== null &&
          witness !== undefined &&
          witness.role === entry.role &&
          witness.receiptId === entry.receipt.receiptId &&
          witness.from === entry.receipt.validFromSeq &&
          witness.until === entry.receipt.validUntilSeq
        );
      });
    if (!boundsAgree || !witnessAgrees) {
      snapshotIssue(
        context,
        "NO_CUT requires L>=U and the deterministic canonical earliest-end/latest-start Receipt witness",
        ["jointValidity"],
      );
    }
  } else if (snapshot.jointValidity.state === "PENDING") {
    if (
      snapshot.jointValidity.lowerBound !== null ||
      snapshot.jointValidity.upperBound !== null ||
      snapshot.jointValidity.currentHeadCovered !== null ||
      snapshot.jointValidity.noCutProof !== null
    ) {
      snapshotIssue(context, "PENDING cannot project validity evidence", [
        "jointValidity",
      ]);
    }
  } else if (
    snapshot.jointValidity.noCutProof !== null ||
    snapshot.jointValidity.currentHeadCovered !== false ||
    snapshot.jointValidity.lowerBound !== expectedLower ||
    snapshot.jointValidity.upperBound !== expectedUpper ||
    expectedLower === null ||
    expectedUpper === null ||
    expectedLower >= expectedUpper ||
    (expectedLower <= snapshot.worldHead && snapshot.worldHead < expectedUpper)
  ) {
    snapshotIssue(
      context,
      "HISTORICAL_STALE bounds must be coherent but exclude the current head",
      ["jointValidity"],
    );
  }

  const invalidAgentIds = snapshot.agents
    .filter((agent) => {
      const decision = agent.activeDecision;
      if (decision === null) return false;
      return !receiptCoversWorldHead(snapshot, decision);
    })
    .map((agent) => agent.agentId)
    .sort();

  if (snapshot.refreshPlan !== null) {
    const owners = snapshot.refreshPlan.agentIds;
    if (
      new Set(owners).size !== owners.length ||
      owners.some(
        (agentId) => !snapshot.agents.some((agent) => agent.agentId === agentId),
      )
    ) {
      snapshotIssue(context, "refreshPlan owners must be distinct projected Agents", [
        "refreshPlan",
        "agentIds",
      ]);
    }
    if (
      snapshot.refreshPlan.status === "AVAILABLE" &&
      snapshot.sessionState !== "BLOCKED_NO_CUT" &&
      snapshot.sessionState !== "HISTORICAL_STALE"
    ) {
      snapshotIssue(
        context,
        "AVAILABLE RefreshPlan is reserved for blocked/historical refresh projections",
        ["refreshPlan"],
      );
    }
  }

  const plan = snapshot.refreshPlan;
  const inFlightAgents = snapshot.agents.filter(
    (agent) => agent.inFlightAttempt !== null,
  );
  const inFlightAgentIds = inFlightAgents.map((agent) => agent.agentId);
  const retainedRefreshReason = refreshReasonForJointValidity(
    snapshot.jointValidity.state,
  );

  if (
    plan !== null &&
    retainedRefreshReason !== null &&
    plan.reasonCode !== retainedRefreshReason
  ) {
    snapshotIssue(
      context,
      "RefreshPlan reason must match the retained NO_CUT or HISTORICAL_STALE validation",
      ["refreshPlan", "reasonCode"],
    );
  }

  if (
    plan?.status === "CLAIMED" &&
    !(CLAIMED_REFRESH_STATES as readonly string[]).includes(
      snapshot.sessionState,
    ) &&
    !(CLAIMED_REFRESH_TERMINAL_EXCEPTIONS as readonly string[]).includes(
      snapshot.sessionState,
    )
  ) {
    snapshotIssue(
      context,
      "CLAIMED RefreshPlan is restricted to REOBSERVING/COLLECTING or terminal FAILED/INTERRUPTED projections",
      ["refreshPlan", "status"],
    );
  }

  if (snapshot.sessionState === "REOBSERVING") {
    const ownerIds = new Set(plan?.agentIds ?? []);
    const ownersAndNonOwnersAreCoherent = snapshot.agents.every((agent) =>
      ownerIds.has(agent.agentId)
        ? agentDecisionIsInvalidAtHead(snapshot, agent) &&
          agentHasActiveNewRefreshAttempt(agent)
        : agentDecisionIsCurrentValid(snapshot, agent) &&
          agent.inFlightAttempt === null,
    );
    if (
      plan?.status !== "CLAIMED" ||
      decisions.length !== 3 ||
      retainedRefreshReason === null ||
      invalidAgentIds.length === 0 ||
      !sameIdSet(plan.agentIds, invalidAgentIds) ||
      !sameIdSet(plan.agentIds, inFlightAgentIds) ||
      !ownersAndNonOwnersAreCoherent
    ) {
      snapshotIssue(
        context,
        "REOBSERVING must retain three old Decisions and bind exactly invalid owners to active new Attempts",
        ["refreshPlan"],
      );
    }
  }

  if (snapshot.sessionState === "COLLECTING" && plan !== null) {
    const ownerIds = new Set(plan.agentIds);
    const collectingJointValidityAllowed = [
      "PENDING",
      "NO_CUT",
      "HISTORICAL_STALE",
    ].includes(snapshot.jointValidity.state);
    const ownersPartitionCorrectly = snapshot.agents.every((agent) => {
      const isOwner = ownerIds.has(agent.agentId);
      const isRemaining = agent.inFlightAttempt !== null;
      if (!isOwner) {
        return (
          !isRemaining && agentDecisionIsCurrentValid(snapshot, agent)
        );
      }
      return isRemaining
        ? agentDecisionIsInvalidAtHead(snapshot, agent) &&
            agentHasActiveNewRefreshAttempt(agent)
        : agentDecisionIsCurrentValid(snapshot, agent) && agent.runCount > 1;
    });
    if (
      plan.status !== "CLAIMED" ||
      decisions.length !== 3 ||
      inFlightAgents.length === 0 ||
      !collectingJointValidityAllowed ||
      !sameIdSet(invalidAgentIds, inFlightAgentIds) ||
      !ownersPartitionCorrectly
    ) {
      snapshotIssue(
        context,
        "COLLECTING refresh owners must partition into completed current Decisions and remaining invalid active Attempts",
        ["refreshPlan"],
      );
    }
  }

  if (snapshot.sessionState === "VALIDATING" && plan !== null) {
    const completedRefreshProjection =
      plan.status === "COMPLETED" &&
      decisions.length === 3 &&
      decisionsValidAtHead &&
      inFlightAgents.length === 0 &&
      sameIdSet(plan.agentIds, reobservedAgentIds) &&
      snapshot.gate.state === "CHECKING" &&
      snapshot.gate.reasonCode === null &&
      snapshot.gate.effectsInSession === 0 &&
      snapshot.gate.permitId === null &&
      snapshot.gate.effectId === null &&
      snapshot.jointValidity.state === "PENDING" &&
      snapshot.availableActions.length === 0;
    if (!completedRefreshProjection) {
      snapshotIssue(
        context,
        "Refresh VALIDATING requires a COMPLETED Plan, three current-valid Decisions, PENDING validation, and no in-flight Attempt or side effect",
        ["refreshPlan"],
      );
    }
  }

  if (
    (snapshot.jointValidity.state === "NO_CUT" ||
      snapshot.jointValidity.state === "HISTORICAL_STALE") &&
    snapshot.refreshPlan === null
  ) {
    snapshotIssue(
      context,
      "NO_CUT/HISTORICAL_STALE validation evidence must retain its RefreshPlan",
      ["refreshPlan"],
    );
  }

  if (projectionRule !== null) {
    if (projectionRule.refreshPlan === "AVAILABLE") {
      if (
        snapshot.refreshPlan?.status !== "AVAILABLE" ||
        !sameIdSet(snapshot.refreshPlan.agentIds, invalidAgentIds) ||
        snapshot.refreshPlan.reasonCode !== projectionRule.reasonCode
      ) {
        snapshotIssue(
          context,
          "Blocked/historical RefreshPlan must be AVAILABLE with the exact invalid-Receipt owner set",
          ["refreshPlan"],
        );
      }
    } else {
      const completedPlanValid =
        reobservedAgentIds.length === 0
          ? snapshot.refreshPlan === null
          : snapshot.refreshPlan?.status === "COMPLETED" &&
            sameIdSet(snapshot.refreshPlan.agentIds, reobservedAgentIds) &&
            (snapshot.refreshPlan.reasonCode ===
              "NO_VALID_OBSERVED_WORLD_CUT" ||
              snapshot.refreshPlan.reasonCode === "HISTORICAL_BUT_STALE_NOW");
      if (!completedPlanValid) {
        snapshotIssue(
          context,
          "Current-valid terminal/ready outcomes require no initial Plan or the exact COMPLETED refresh Plan",
          ["refreshPlan"],
        );
      }
    }
  }

  const expectedRerunsAvoided =
    snapshot.refreshPlan === null ? 0 : 3 - snapshot.refreshPlan.agentIds.length;
  if (snapshot.metrics.rerunsAvoided !== expectedRerunsAvoided) {
    snapshotIssue(context, "rerunsAvoided must match the selective refresh plan", [
      "metrics",
      "rerunsAvoided",
    ]);
  }

  const expectedActions = projectionRule?.availableActions ?? [];
  if (!sameIdSet(snapshot.availableActions, expectedActions)) {
    snapshotIssue(
      context,
      "availableActions must match the authoritative state; non-authoritative and CLAIMED projections expose no mutation action",
      ["availableActions"],
    );
  }
}

export const SessionDashboardSnapshotSchema =
  SessionDashboardSnapshotShapeSchema.superRefine(addSnapshotInvariantIssues);

export type SessionDashboardSnapshot = z.infer<
  typeof SessionDashboardSnapshotSchema
>;

export const CreateSessionRequestSchema = z
  .object({
    scenarioId: ScenarioIdSchema,
    assignments: z
      .object({
        inventory: OpaqueIdSchema,
        budget: OpaqueIdSchema,
        policy: OpaqueIdSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(Object.values(request.assignments)).size !== 3) {
      context.addIssue({
        code: "custom",
        message: "Each Role must use a distinct Agent",
        path: ["assignments"],
      });
    }
  });
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const RefreshSessionRequestSchema = z
  .object({
    expectedSessionRevision: z.number().int().nonnegative(),
    refreshPlanId: OpaqueIdSchema,
  })
  .strict();
export type RefreshSessionRequest = z.infer<typeof RefreshSessionRequestSchema>;

export const CommitSessionRequestSchema = z
  .object({ expectedSessionRevision: z.number().int().nonnegative() })
  .strict();
export type CommitSessionRequest = z.infer<typeof CommitSessionRequestSchema>;

export const STALE_VIEW_MESSAGE =
  "Session changed; refresh before retrying the action." as const;
export const ALREADY_REOBSERVING_MESSAGE =
  "Re-observation is already in progress." as const;
export const AGENTS_BUSY_MESSAGE =
  "The assigned Role Agent triple is already in use by an active session." as const;
export const MISSING_ACTION_FIELDS_MESSAGE =
  "Action is missing fields required by the selected scenario." as const;
export const SESSION_NOT_FOUND_MESSAGE =
  "EpochGuard session was not found." as const;
export const UNSUPPORTED_SCHEMA_MESSAGE =
  "EpochGuard schema or contract version is unsupported." as const;
export const PROJECTION_MISMATCH_MESSAGE =
  "EpochGuard projection failed safety reconciliation." as const;

export const API_ERROR_STATUS = {
  STALE_VIEW: 409,
  ALREADY_REOBSERVING: 409,
  AGENTS_BUSY: 409,
  MISSING_ACTION_FIELDS: 422,
  SESSION_NOT_FOUND: 404,
  UNSUPPORTED_SCHEMA: 422,
  PROJECTION_MISMATCH: 500,
} as const;

export const StaleViewErrorBodySchema = z
  .object({
    error: z.literal("STALE_VIEW"),
    message: z.literal(STALE_VIEW_MESSAGE),
    sessionId: OpaqueIdSchema,
    expectedSessionRevision: z.number().int().nonnegative(),
    actualSessionRevision: z.number().int().nonnegative(),
  })
  .strict();
export type StaleViewErrorBody = z.infer<typeof StaleViewErrorBodySchema>;
export const AlreadyReobservingErrorBodySchema = z
  .object({
    error: z.literal("ALREADY_REOBSERVING"),
    message: z.literal(ALREADY_REOBSERVING_MESSAGE),
    sessionId: OpaqueIdSchema,
    refreshPlanId: OpaqueIdSchema,
    attemptId: OpaqueIdSchema,
  })
  .strict();
export type AlreadyReobservingErrorBody = z.infer<
  typeof AlreadyReobservingErrorBodySchema
>;
export const AgentsBusyErrorBodySchema = z
  .object({
    error: z.literal("AGENTS_BUSY"),
    message: z.literal(AGENTS_BUSY_MESSAGE),
    activeSessionId: OpaqueIdSchema,
    assignments: z
      .object({
        inventory: OpaqueIdSchema,
        budget: OpaqueIdSchema,
        policy: OpaqueIdSchema,
      })
      .strict(),
  })
  .strict();
export type AgentsBusyErrorBody = z.infer<typeof AgentsBusyErrorBodySchema>;
export const MissingActionFieldsErrorBodySchema = z
  .object({
    error: z.literal("MISSING_ACTION_FIELDS"),
    message: z.literal(MISSING_ACTION_FIELDS_MESSAGE),
    missingFields: z
      .array(
        z.enum([
          "schemaVersion",
          "type",
          "campaignId",
          "requestedUnits",
          "estimatedCostCents",
          "market",
        ]),
      )
      .min(1)
      .max(6),
  })
  .strict();
export type MissingActionFieldsErrorBody = z.infer<
  typeof MissingActionFieldsErrorBodySchema
>;
export const SessionNotFoundErrorBodySchema = z
  .object({
    error: z.literal("SESSION_NOT_FOUND"),
    message: z.literal(SESSION_NOT_FOUND_MESSAGE),
    sessionId: OpaqueIdSchema,
  })
  .strict();
export type SessionNotFoundErrorBody = z.infer<
  typeof SessionNotFoundErrorBodySchema
>;
export const UnsupportedSchemaErrorBodySchema = z
  .object({
    error: z.literal("UNSUPPORTED_SCHEMA"),
    message: z.literal(UNSUPPORTED_SCHEMA_MESSAGE),
    expectedSchemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedContractVersion: z.literal(CONTRACT_VERSION),
    receivedSchemaVersion: z.number().int().nonnegative().nullable(),
    receivedContractVersion: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type UnsupportedSchemaErrorBody = z.infer<
  typeof UnsupportedSchemaErrorBodySchema
>;
export const ProjectionMismatchErrorBodySchema = z
  .object({
    error: z.literal("PROJECTION_MISMATCH"),
    message: z.literal(PROJECTION_MISMATCH_MESSAGE),
    sessionId: OpaqueIdSchema,
    snapshotRevision: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectionMismatchErrorBody = z.infer<
  typeof ProjectionMismatchErrorBodySchema
>;
export const ConflictErrorBodySchema = z.discriminatedUnion("error", [
  StaleViewErrorBodySchema,
  AlreadyReobservingErrorBodySchema,
  AgentsBusyErrorBodySchema,
]);
export type ConflictErrorBody = z.infer<typeof ConflictErrorBodySchema>;

export const ApiErrorBodySchema = z.discriminatedUnion("error", [
  StaleViewErrorBodySchema,
  AlreadyReobservingErrorBodySchema,
  AgentsBusyErrorBodySchema,
  MissingActionFieldsErrorBodySchema,
  SessionNotFoundErrorBodySchema,
  UnsupportedSchemaErrorBodySchema,
  ProjectionMismatchErrorBodySchema,
]);
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const CONTRACT_SEMANTIC_INVARIANTS = [
  "ActionIntent.actionHash equals sha256(canonical ActionCanonicalFields)",
  "ActionIntent.idempotencyKey equals <sessionId>:<actionHash>; exactly-once scope is Session + Action",
  "RoleQuerySpec is reconstructed by role and queryHash excludes only queryHash itself",
  "CreateSessionRequest assignments contain three distinct Agents",
  "same Role-Agent triple conflicts with 409 AGENTS_BUSY before dispatch",
  "ResourceVersion.validUntilSeq is null or strictly greater than validFromSeq",
  "PARSE_REJECTED byte length is <=16384, sanitizedContent may be empty, its non-null digest equals sha256(content), and truncated=false",
  "OUTPUT_TOO_LARGE byte length is >16384, content/digest are null, truncated=true",
  "ENVELOPE_DIGEST ArtifactRef.id is Sha256Digest; every other ArtifactRef.id is OpaqueId",
  "Snapshot Agents are ordered inventory,budget,policy and have distinct Agent identities",
  "Snapshot actionHash equals sha256(canonical Snapshot Action)",
  "Snapshot safe decoders validate the Action shape before hashing and never throw for malformed Action fields",
  "Every active Receipt has validUntilSeq=null or validFromSeq<validUntilSeq<=worldHead, validFromSeq<=observedAtSeq<(validUntilSeq??worldHead+1), and observedAtSeq<=worldHead",
  "Snapshot certificate, run, receipt, assignment, and attempt references are unique across Agents within each ID namespace",
  "Snapshot metrics equal active Decision verdicts, reobserved Agent runCounts, and refresh ownership",
  "Only BLOCKED_NO_CUT, HISTORICAL_STALE, CONSISTENT_DENY, READY_AT_CURRENT_HEAD, and COMMITTED have bidirectionally frozen projection products; other Session states retain only universal safety constraints",
  "RELEASED iff COMMITTED projects one Permit-bound Effect, effectsInSession=1, three current-valid ALLOW Decisions, and no mutation action or in-flight Attempt",
  "non-RELEASED Snapshot has zero Effects and no Effect ID",
  "LOCKED carries no Permit; Permit IDs are restricted to READY_AT_CURRENT_HEAD, COMMITTING, or COMMITTED",
  "VALID_CURRENT has no No-Cut proof and exact interval bounds covering worldHead",
  "NO_CUT has exact receipt-derived L/U with L>=U and the canonical earliest-end/latest-start witness; endpoint ties choose UTF-16 code-unit lexicographically smallest receiptId",
  "NO_CUT dependencySetHash equals sha256(canonicalJSON(sort(all three active receiptIds)))",
  "NO_CUT/HISTORICAL_STALE retained validation evidence requires a RefreshPlan whose reasonCode exactly matches the validation outcome",
  "CURRENT and RETAINED evidence exactly mean the half-open Receipt covers worldHead; INVALID_AT_HEAD exactly means it does not",
  "Snapshot RefreshPlan.reasonCode is exactly NO_VALID_OBSERVED_WORLD_CUT or HISTORICAL_BUT_STALE_NOW; AVAILABLE exists only for matching blocked/historical invalid owners",
  "REOBSERVING CLAIMED retains three invalid old-owner Decisions; COLLECTING CLAIMED partitions completed and remaining owners; refresh VALIDATING uses COMPLETED with no in-flight; CLAIMED terminal exceptions are FAILED/INTERRUPTED",
  "READY_AT_CURRENT_HEAD accepts an absent initial Plan or the exact COMPLETED selective-refresh Plan and always exposes exactly COMMIT",
  "FAILED with WAITING and null reason is rejected; side-effect-free FAILED/INTERRUPTED Gate and reason products otherwise remain unfrozen",
  "availableActions is exactly REOBSERVE_INVALID for blocked/historical AVAILABLE Plans, COMMIT for READY_AT_CURRENT_HEAD, and empty otherwise",
] as const;

export const WEB_CONTRACT_SCHEMA_REGISTRY = {
  OpaqueId: OpaqueIdSchema,
  Sha256Digest: Sha256DigestSchema,
  Role: RoleSchema,
  ScenarioId: ScenarioIdSchema,
  SessionState: SessionStateSchema,
  FailureCode: FailureCodeSchema,
  RefreshPlanReasonCode: RefreshPlanReasonCodeSchema,
  ArtifactRefKind: ArtifactRefKindSchema,
  ArtifactRef: ArtifactRefSchema,
  SessionDashboardSnapshot: SessionDashboardSnapshotSchema,
  CreateSessionRequest: CreateSessionRequestSchema,
  RefreshSessionRequest: RefreshSessionRequestSchema,
  CommitSessionRequest: CommitSessionRequestSchema,
  StaleViewErrorBody: StaleViewErrorBodySchema,
  AlreadyReobservingErrorBody: AlreadyReobservingErrorBodySchema,
  AgentsBusyErrorBody: AgentsBusyErrorBodySchema,
  MissingActionFieldsErrorBody: MissingActionFieldsErrorBodySchema,
  SessionNotFoundErrorBody: SessionNotFoundErrorBodySchema,
  UnsupportedSchemaErrorBody: UnsupportedSchemaErrorBodySchema,
  ProjectionMismatchErrorBody: ProjectionMismatchErrorBodySchema,
  ConflictErrorBody: ConflictErrorBodySchema,
  ApiErrorBody: ApiErrorBodySchema,
} as const satisfies Record<string, z.ZodType>;

export function decodeSessionDashboardSnapshot(input: unknown): SessionDashboardSnapshot {
  return SessionDashboardSnapshotSchema.parse(input);
}

export function safeDecodeSessionDashboardSnapshot(input: unknown) {
  return SessionDashboardSnapshotSchema.safeParse(input);
}
