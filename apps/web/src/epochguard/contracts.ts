import { z } from "zod";

export const CONTRACT_VERSION = "epochguard-contract-v1" as const;
export const CONTRACT_DIGEST =
  "sha256:dcf8815b991f475514e6387c9e78251c36d751e072fca0cc584267f55bd2718e" as const;

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

const TimestampSchema = z.string().datetime({ offset: true });
const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const EvidencePackRelativePathSchema = z
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

export const ArtifactRefSchema = z
  .object({
    kind: ArtifactRefKindSchema,
    id: z.string().min(1).max(512),
  })
  .strict();
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

export const SessionDashboardSnapshotSchema = z
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
  .strict()
  .superRefine((snapshot, context) => {
    const roles = snapshot.agents.map((agent) => agent.role);
    if (roles.join(",") !== ROLES.join(",")) {
      context.addIssue({
        code: "custom",
        message: "agents must be ordered inventory, budget, policy",
        path: ["agents"],
      });
    }
    if (snapshot.metrics.allowDecisions + snapshot.metrics.denyDecisions !== snapshot.metrics.activeDecisions) {
      context.addIssue({
        code: "custom",
        message: "decision metrics must reconcile",
        path: ["metrics"],
      });
    }
  });

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
export const ConflictErrorBodySchema = z.discriminatedUnion("error", [
  StaleViewErrorBodySchema,
  AlreadyReobservingErrorBodySchema,
  AgentsBusyErrorBodySchema,
]);
export type ConflictErrorBody = z.infer<typeof ConflictErrorBodySchema>;

export function decodeSessionDashboardSnapshot(input: unknown): SessionDashboardSnapshot {
  return SessionDashboardSnapshotSchema.parse(input);
}

export function safeDecodeSessionDashboardSnapshot(input: unknown) {
  return SessionDashboardSnapshotSchema.safeParse(input);
}
