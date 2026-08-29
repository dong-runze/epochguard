import { z } from "zod";

export const CONTRACT_VERSION = "epochguard-contract-v2" as const;
export const CONTRACT_SCHEMA_VERSION = 1 as const;
export const CONTRACT_DIGEST =
  "sha256:0f16a9cb9f41cc64014ca8cc508a4f98b270cecf83882f328cb99994f7910d95" as const;

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
export const ArtifactRefKindSchema = z.enum(ARTIFACT_REF_KINDS);

export type Role = z.infer<typeof RoleSchema>;
export type FailureCode = z.infer<typeof FailureCodeSchema>;

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
    action: z
      .object({
        type: z.literal("PUBLISH_CAMPAIGN"),
        campaignId: OpaqueIdSchema,
        requestedUnits: z.number().int().positive(),
        estimatedCostCents: z.number().int().nonnegative(),
        market: z.literal("SG"),
      })
      .strict(),
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
        reasonCode: FailureCodeSchema,
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

  const decisions = snapshot.agents.flatMap((agent) =>
    agent.activeDecision === null ? [] : [agent.activeDecision],
  );
  const allowDecisions = decisions.filter(
    (decision) => decision.verdict === "ALLOW",
  ).length;
  const denyDecisions = decisions.length - allowDecisions;
  const reobservedAgents = snapshot.agents.filter(
    (agent) => agent.runCount > 1,
  ).length;
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
  });

  if (snapshot.actionHash !== snapshotActionHash(snapshot.action)) {
    snapshotIssue(context, "actionHash does not match the Snapshot Action", [
      "actionHash",
    ]);
  }

  if (snapshot.gate.state === "RELEASED") {
    if (
      snapshot.gate.effectsInSession !== 1 ||
      snapshot.gate.effectId === null ||
      snapshot.gate.permitId === null ||
      snapshot.sessionState !== "COMMITTED" ||
      snapshot.jointValidity.state !== "VALID_CURRENT" ||
      snapshot.availableActions.length !== 0
    ) {
      snapshotIssue(
        context,
        "RELEASED requires one Effect, Permit/Effect IDs, COMMITTED, and no actions",
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
    snapshotIssue(context, "COMMITTED must project a RELEASED Gate", [
      "sessionState",
    ]);
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

  const receiptByRole = new Map(
    snapshot.agents.flatMap((agent) =>
      agent.activeDecision === null
        ? []
        : ([[agent.role, agent.activeDecision.receipt]] as const),
    ),
  );
  const receipts = [...receiptByRole.values()];
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
    const boundsAgree =
      proof !== null &&
      snapshot.sessionState === "BLOCKED_NO_CUT" &&
      snapshot.gate.state === "LOCKED" &&
      snapshot.jointValidity.lowerBound === proof.lowerBound &&
      snapshot.jointValidity.upperBound === proof.upperBound &&
      proof.lowerBound === expectedLower &&
      proof.upperBound === expectedUpper &&
      proof.lowerBound > proof.upperBound &&
      snapshot.jointValidity.currentHeadCovered === false;
    let witnessAgrees = proof !== null;
    if (proof !== null) {
      const seenRoles = new Set<string>();
      let hasLatestStart = false;
      let hasEarliestEnd = false;
      for (const witness of proof.witness) {
        const receipt = receiptByRole.get(witness.role);
        seenRoles.add(witness.role);
        witnessAgrees &&=
          receipt !== undefined &&
          witness.receiptId === receipt.receiptId &&
          witness.from === receipt.validFromSeq &&
          witness.until === receipt.validUntilSeq;
        hasLatestStart ||= witness.from === proof.lowerBound;
        hasEarliestEnd ||= witness.until === proof.upperBound;
      }
      witnessAgrees &&=
        seenRoles.size === proof.witness.length && hasLatestStart && hasEarliestEnd;
    }
    if (!boundsAgree || !witnessAgrees) {
      snapshotIssue(
        context,
        "NO_CUT requires strict contradictory bounds and a matching receipt witness",
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
      const receipt = decision.receipt;
      return (
        decision.evidenceState === "INVALID_AT_HEAD" ||
        receipt.validFromSeq > snapshot.worldHead ||
        (receipt.validUntilSeq !== null &&
          snapshot.worldHead >= receipt.validUntilSeq)
      );
    })
    .map((agent) => agent.agentId)
    .sort();

  if (snapshot.refreshPlan !== null) {
    const owners = [...snapshot.refreshPlan.agentIds].sort();
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
      snapshot.jointValidity.state === "NO_CUT" &&
      (owners.join(",") !== invalidAgentIds.join(",") ||
        snapshot.refreshPlan.reasonCode !== "NO_VALID_OBSERVED_WORLD_CUT")
    ) {
      snapshotIssue(
        context,
        "NO_CUT refresh owners must match invalid receipt owners and roles",
        ["refreshPlan"],
      );
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

  const expectedActions: Array<"REOBSERVE_INVALID" | "COMMIT"> = [];
  if (
    snapshot.gate.state === "READY" &&
    snapshot.sessionState === "READY_AT_CURRENT_HEAD" &&
    snapshot.refreshPlan === null
  ) {
    expectedActions.push("COMMIT");
  } else if (
    snapshot.gate.state === "LOCKED" &&
    (snapshot.sessionState === "BLOCKED_NO_CUT" ||
      snapshot.sessionState === "HISTORICAL_STALE") &&
    snapshot.refreshPlan?.status === "AVAILABLE"
  ) {
    expectedActions.push("REOBSERVE_INVALID");
  }
  if (snapshot.availableActions.join(",") !== expectedActions.join(",")) {
    snapshotIssue(
      context,
      "availableActions must match Gate, Session, and refresh state",
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
  "PARSE_REJECTED byte length is <=16384, content/digest are non-null and equal, truncated=false",
  "OUTPUT_TOO_LARGE byte length is >16384, content/digest are null, truncated=true",
  "ENVELOPE_DIGEST ArtifactRef.id is Sha256Digest; every other ArtifactRef.id is OpaqueId",
  "Snapshot Agents are ordered inventory,budget,policy and have distinct Agent identities",
  "Snapshot actionHash equals sha256(canonical Snapshot Action)",
  "Snapshot metrics equal active Decision verdicts, reobserved Agent runCounts, and refresh ownership",
  "RELEASED iff one Effect is projected with Permit/Effect IDs, COMMITTED state, and no mutation action",
  "non-RELEASED Snapshot has zero Effects and no Effect ID",
  "VALID_CURRENT has no No-Cut proof and exact interval bounds covering worldHead",
  "NO_CUT has exact receipt-derived L/U with L>U and a two-receipt endpoint witness",
  "No-Cut refresh owners equal Agents whose active receipts are invalid at worldHead",
  "availableActions is exactly derived from Gate, Session, Permit, and refresh-plan state",
] as const;

export const WEB_CONTRACT_SCHEMA_REGISTRY = {
  OpaqueId: OpaqueIdSchema,
  Sha256Digest: Sha256DigestSchema,
  Role: RoleSchema,
  ScenarioId: ScenarioIdSchema,
  SessionState: SessionStateSchema,
  FailureCode: FailureCodeSchema,
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
