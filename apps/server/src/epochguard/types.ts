import { createHash } from "node:crypto";
import { z } from "zod";

export const CONTRACT_VERSION = "epochguard-contract-v4" as const;
export const CONTRACT_SCHEMA_VERSION = 1 as const;
export const CONTRACT_DIGEST =
  "sha256:a3360afb53ed8d77742eb4e61e4d916b5f44f2d16c939bef14f853c6ab9f6823" as const;

export const ROLES = ["inventory", "budget", "policy"] as const;
export const SOURCES = ["inventory", "budget", "policy"] as const;
export const VERDICTS = ["ALLOW", "DENY"] as const;
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

export const ATTEMPT_STATES = [
  "ASSIGNMENT_CREATED",
  "DISPATCHING",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "OUTPUT_REJECTED",
  "ACCEPTED",
] as const;

export const ASSIGNMENT_STATES = ["CREATED", "BOUND", "CONSUMED", "REJECTED"] as const;
export const DECISION_STATES = ["ACTIVE", "SUPERSEDED"] as const;
export const VALIDATION_OUTCOMES = [
  "VALID_CURRENT_ALLOW",
  "CONSISTENT_DENY",
  "NO_VALID_OBSERVED_WORLD_CUT",
  "HISTORICAL_BUT_STALE_NOW",
  "FAILED",
] as const;
export const PERMIT_STATES = ["ISSUED", "CONSUMED", "REVOKED"] as const;
export const REFRESH_PLAN_STATES = [
  "AVAILABLE",
  "CLAIMED",
  "COMPLETED",
  "INVALIDATED",
] as const;
export const COORDINATION_MODES = [
  "PENDING",
  "CONCURRENT",
  "SEQUENTIAL_FALLBACK",
] as const;
export const GATE_STATES = [
  "WAITING",
  "CHECKING",
  "LOCKED",
  "READY",
  "RELEASED",
  "FAILED",
] as const;
export const JOINT_VALIDITY_STATES = [
  "PENDING",
  "VALID_CURRENT",
  "NO_CUT",
  "HISTORICAL_STALE",
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

export const DIAGNOSTIC_KINDS = [
  "EXPECTED_BLOCK",
  "SYSTEM_FAILURE",
  "TRANSIENT_RACE",
] as const;
export const DIAGNOSTIC_STAGES = [
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
] as const;
export const RECOMMENDED_ACTIONS = ["NONE", "NEW_SESSION", "REOBSERVE_INVALID"] as const;
export const AVAILABLE_ACTIONS = ["REOBSERVE_INVALID", "COMMIT"] as const;

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

export const ARTIFACT_REF_TARGETS = {
  ATTEMPT: "epochDatabase.attempts",
  ASSIGNMENT: "epochDatabase.runAssignments",
  RUN: "launchpadDatabase.runs",
  ENVELOPE_DIGEST: "epochDatabase.attempts.outputDigest",
  REJECTED_OUTPUT: "epochDatabase.rejectedOutputArtifacts",
  RECEIPT: "epochDatabase.receipts",
  SOURCE_VERSION: "epochDatabase.resourceVersions",
  VALIDATION: "epochDatabase.validations",
  PROOF: "epochDatabase.noCutProofs",
  REFRESH_PLAN: "epochDatabase.refreshPlans",
  PERMIT: "epochDatabase.permits",
  EFFECT: "epochDatabase.effects",
} as const satisfies Record<(typeof ARTIFACT_REF_KINDS)[number], string>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

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
export const SourceSchema = z.enum(SOURCES);
export const VerdictSchema = z.enum(VERDICTS);
export const ScenarioIdSchema = z.enum(SCENARIO_IDS);
export const SessionStateSchema = z.enum(SESSION_STATES);
export const AttemptStateSchema = z.enum(ATTEMPT_STATES);
export const AssignmentStateSchema = z.enum(ASSIGNMENT_STATES);
export const DecisionStateSchema = z.enum(DECISION_STATES);
export const ValidationOutcomeSchema = z.enum(VALIDATION_OUTCOMES);
export const PermitStateSchema = z.enum(PERMIT_STATES);
export const RefreshPlanStateSchema = z.enum(REFRESH_PLAN_STATES);
export const CoordinationModeSchema = z.enum(COORDINATION_MODES);
export const GateStateSchema = z.enum(GATE_STATES);
export const JointValidityStateSchema = z.enum(JOINT_VALIDITY_STATES);
export const FailureCodeSchema = z.enum(FAILURE_CODES);
export const DiagnosticKindSchema = z.enum(DIAGNOSTIC_KINDS);
export const DiagnosticStageSchema = z.enum(DIAGNOSTIC_STAGES);
export const RecommendedActionSchema = z.enum(RECOMMENDED_ACTIONS);
export const AvailableActionSchema = z.enum(AVAILABLE_ACTIONS);
export const ArtifactRefKindSchema = z.enum(ARTIFACT_REF_KINDS);

export type Role = z.infer<typeof RoleSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
export type AttemptState = z.infer<typeof AttemptStateSchema>;
export type FailureCode = z.infer<typeof FailureCodeSchema>;

export const ActionCanonicalFieldsSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("PUBLISH_CAMPAIGN"),
    campaignId: OpaqueIdSchema,
    requestedUnits: z.number().int().positive(),
    estimatedCostCents: z.number().int().nonnegative(),
    market: z.literal("SG"),
  })
  .strict();

export const ActionIntentSchema = ActionCanonicalFieldsSchema.extend({
  actionId: OpaqueIdSchema,
  sessionId: OpaqueIdSchema,
  actionHash: Sha256DigestSchema,
  idempotencyKey: z.string().min(1).max(768),
})
  .strict()
  .superRefine((intent, context) => {
    const canonicalFields = ActionCanonicalFieldsSchema.safeParse({
      schemaVersion: intent.schemaVersion,
      type: intent.type,
      campaignId: intent.campaignId,
      requestedUnits: intent.requestedUnits,
      estimatedCostCents: intent.estimatedCostCents,
      market: intent.market,
    });
    if (!canonicalFields.success) return;
    const expectedActionHash = sha256Digest(canonicalJson(canonicalFields.data));
    if (intent.actionHash !== expectedActionHash) {
      context.addIssue({
        code: "custom",
        message: "actionHash does not match the canonical Action",
        path: ["actionHash"],
      });
    }
    const expectedIdempotencyKey = `${intent.sessionId}:${expectedActionHash}`;
    if (intent.idempotencyKey !== expectedIdempotencyKey) {
      context.addIssue({
        code: "custom",
        message: "idempotencyKey must be scoped to Session + Action",
        path: ["idempotencyKey"],
      });
    }
  });

export type ActionCanonicalFields = z.infer<typeof ActionCanonicalFieldsSchema>;
export type ActionIntent = z.infer<typeof ActionIntentSchema>;

const InventoryRoleQuerySchema = z
  .object({
    schemaVersion: z.literal(1),
    actionHash: Sha256DigestSchema,
    role: z.literal("inventory"),
    source: z.literal("inventory"),
    entityKey: OpaqueIdSchema,
    actionProjection: z
      .object({
        campaignId: OpaqueIdSchema,
        requestedUnits: z.number().int().positive(),
      })
      .strict(),
    queryHash: Sha256DigestSchema,
  })
  .strict();

const BudgetRoleQuerySchema = z
  .object({
    schemaVersion: z.literal(1),
    actionHash: Sha256DigestSchema,
    role: z.literal("budget"),
    source: z.literal("budget"),
    entityKey: OpaqueIdSchema,
    actionProjection: z
      .object({
        campaignId: OpaqueIdSchema,
        estimatedCostCents: z.number().int().nonnegative(),
      })
      .strict(),
    queryHash: Sha256DigestSchema,
  })
  .strict();

const PolicyRoleQuerySchema = z
  .object({
    schemaVersion: z.literal(1),
    actionHash: Sha256DigestSchema,
    role: z.literal("policy"),
    source: z.literal("policy"),
    entityKey: OpaqueIdSchema,
    actionProjection: z
      .object({
        campaignId: OpaqueIdSchema,
        market: z.literal("SG"),
      })
      .strict(),
    queryHash: Sha256DigestSchema,
  })
  .strict();

export const RoleQuerySpecSchema = z.discriminatedUnion("role", [
  InventoryRoleQuerySchema,
  BudgetRoleQuerySchema,
  PolicyRoleQuerySchema,
]);
export type RoleQuerySpec = z.infer<typeof RoleQuerySpecSchema>;

export const RoleAgentRegistrationSchema = z
  .object({
    role: RoleSchema,
    agentId: OpaqueIdSchema,
    agentNameAtRegistration: z.string().min(1).max(80),
    roleProfileVersion: OpaqueIdSchema,
    agentsMdDigest: Sha256DigestSchema,
    registeredAt: TimestampSchema,
  })
  .strict();
export type RoleAgentRegistration = z.infer<typeof RoleAgentRegistrationSchema>;

export const WorldCommitSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    changes: z
      .array(
        z
          .object({
            resourceId: OpaqueIdSchema,
            previousVersionId: OpaqueIdSchema.nullable(),
            nextVersionId: OpaqueIdSchema,
          })
          .strict(),
      )
      .min(1),
    reason: z.string().min(1).max(1_000),
    createdAt: TimestampSchema,
  })
  .strict();
export type WorldCommit = z.infer<typeof WorldCommitSchema>;

export const ResourceVersionSchema = z
  .object({
    id: OpaqueIdSchema,
    resourceId: OpaqueIdSchema,
    sourceRevision: z.number().int().nonnegative(),
    value: JsonValueSchema,
    valueHash: Sha256DigestSchema,
    validFromSeq: z.number().int().nonnegative(),
    validUntilSeq: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.validUntilSeq !== null && value.validUntilSeq <= value.validFromSeq) {
      context.addIssue({
        code: "custom",
        message: "validUntilSeq must be greater than validFromSeq",
        path: ["validUntilSeq"],
      });
    }
  });
export type ResourceVersion = z.infer<typeof ResourceVersionSchema>;

export const RunUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RunUsage = z.infer<typeof RunUsageSchema>;

export const RunAssignmentSchema = z
  .object({
    assignmentId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    agentId: OpaqueIdSchema,
    agentNameAtAssignment: z.string().min(1).max(80),
    role: RoleSchema,
    receiptId: OpaqueIdSchema,
    queryHash: Sha256DigestSchema,
    roleProfileVersion: OpaqueIdSchema,
    promptTemplateVersion: OpaqueIdSchema,
    agentsMdDigest: Sha256DigestSchema,
    runtimeLabelAtDispatch: z.string().min(1).max(256),
    evidencePackRelativePath: EvidencePackRelativePathSchema,
    evidencePackHash: Sha256DigestSchema,
    boundRunId: OpaqueIdSchema.nullable(),
    status: AssignmentStateSchema,
    consumedByDecisionCertificateId: OpaqueIdSchema.nullable(),
    createdAt: TimestampSchema,
    boundAt: TimestampSchema.nullable(),
    consumedAt: TimestampSchema.nullable(),
  })
  .strict();
export type RunAssignment = z.infer<typeof RunAssignmentSchema>;

export const AgentAttemptSchema = z
  .object({
    attemptId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    role: RoleSchema,
    agentId: OpaqueIdSchema,
    assignmentId: OpaqueIdSchema,
    runId: OpaqueIdSchema.nullable(),
    status: AttemptStateSchema,
    runStartedAt: TimestampSchema.nullable(),
    runCompletedAt: TimestampSchema.nullable(),
    threadId: z.string().min(1).max(512).nullable(),
    usage: RunUsageSchema.nullable(),
    outputDigest: Sha256DigestSchema.nullable(),
  })
  .strict();
export type AgentAttempt = z.infer<typeof AgentAttemptSchema>;

export const ObservationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    agentId: OpaqueIdSchema,
    runAssignmentId: OpaqueIdSchema,
    role: RoleSchema,
    source: SourceSchema,
    entityKey: OpaqueIdSchema,
    queryHash: Sha256DigestSchema,
    sourceRevision: z.number().int().nonnegative(),
    valueHash: Sha256DigestSchema,
    observedAtSeq: z.number().int().nonnegative(),
    nonce: z.string().min(32).max(512),
    issuer: z.literal("epochguard"),
    issuedAt: TimestampSchema,
    integrityTag: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ObservationReceipt = z.infer<typeof ObservationReceiptSchema>;

export const AgentDecisionEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    runAssignmentId: OpaqueIdSchema,
    role: RoleSchema,
    receiptId: OpaqueIdSchema,
    nonce: z.string().min(32).max(512),
    verdict: VerdictSchema,
    reason: z.string().min(1).max(1_000),
  })
  .strict();
export type AgentDecisionEnvelope = z.infer<typeof AgentDecisionEnvelopeSchema>;

export const DependencyCertificateSchema = z
  .object({
    certificateId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    agentId: OpaqueIdSchema,
    runAssignmentId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    role: RoleSchema,
    verdict: VerdictSchema,
    receiptIds: z.tuple([OpaqueIdSchema]),
    decisionDigest: Sha256DigestSchema,
    status: DecisionStateSchema,
    supersededByCertificateId: OpaqueIdSchema.nullable(),
    constructedBy: z.literal("epochguard"),
    createdAt: TimestampSchema,
  })
  .strict();
export type DependencyCertificate = z.infer<typeof DependencyCertificateSchema>;

export const ActiveDecisionCertificateIdsSchema = z
  .object({
    inventory: OpaqueIdSchema.nullable(),
    budget: OpaqueIdSchema.nullable(),
    policy: OpaqueIdSchema.nullable(),
  })
  .strict();
export type ActiveDecisionCertificateIds = z.infer<
  typeof ActiveDecisionCertificateIdsSchema
>;

export const EpochSessionSchema = z
  .object({
    sessionId: OpaqueIdSchema,
    scenarioId: ScenarioIdSchema,
    action: ActionIntentSchema,
    actionHash: Sha256DigestSchema,
    state: SessionStateSchema,
    sessionRevision: z.number().int().nonnegative(),
    coordinationMode: CoordinationModeSchema,
    frozenAssignments: z
      .object({
        inventoryAgentId: OpaqueIdSchema,
        budgetAgentId: OpaqueIdSchema,
        policyAgentId: OpaqueIdSchema,
      })
      .strict(),
    activeDecisionCertificateIds: ActiveDecisionCertificateIdsSchema,
    activeAttemptIds: z
      .object({
        inventory: OpaqueIdSchema.nullable(),
        budget: OpaqueIdSchema.nullable(),
        policy: OpaqueIdSchema.nullable(),
      })
      .strict(),
    activeValidationId: OpaqueIdSchema.nullable(),
    activeRefreshPlanId: OpaqueIdSchema.nullable(),
    activePermitId: OpaqueIdSchema.nullable(),
    stateUpdatedAt: TimestampSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type EpochSession = z.infer<typeof EpochSessionSchema>;

export const ValidationRecordSchema = z
  .object({
    validationId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    baseSessionRevision: z.number().int().nonnegative(),
    decisionCertificateIds: z.tuple([OpaqueIdSchema, OpaqueIdSchema, OpaqueIdSchema]),
    dependencySetHash: Sha256DigestSchema,
    validatedHead: z.number().int().nonnegative(),
    outcome: ValidationOutcomeSchema,
    lowerBound: z.number().int().nonnegative().nullable(),
    upperBound: z.number().int().nonnegative().nullable(),
    jointValidityCertificateId: OpaqueIdSchema.nullable(),
    noCutProofId: OpaqueIdSchema.nullable(),
    refreshPlanId: OpaqueIdSchema.nullable(),
    verificationLatencyMs: z.number().nonnegative(),
    createdAt: TimestampSchema,
  })
  .strict();
export type ValidationRecord = z.infer<typeof ValidationRecordSchema>;

const IntervalSchema = z
  .object({
    receiptId: OpaqueIdSchema,
    source: SourceSchema,
    sourceRevision: z.number().int().nonnegative(),
    from: z.number().int().nonnegative(),
    until: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const JointValidityCertificateSchema = z
  .object({
    certificateId: OpaqueIdSchema,
    validationId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    dependencySetHash: Sha256DigestSchema,
    validatedAtHead: z.number().int().nonnegative(),
    selectedCutSeq: z.number().int().nonnegative(),
    currentHeadCovered: z.boolean(),
    decisionCertificateIds: z.tuple([OpaqueIdSchema, OpaqueIdSchema, OpaqueIdSchema]),
    intervals: z.array(IntervalSchema).length(3),
    validatorVersion: z.literal("epochguard-jv-v1"),
    createdAt: TimestampSchema,
  })
  .strict();
export type JointValidityCertificate = z.infer<
  typeof JointValidityCertificateSchema
>;

export const EffectPermitSchema = z
  .object({
    permitId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    dependencySetHash: Sha256DigestSchema,
    jointValidityCertificateId: OpaqueIdSchema,
    validatedHead: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1).max(768),
    status: PermitStateSchema,
    issuedAt: TimestampSchema,
    consumedAt: TimestampSchema.nullable(),
  })
  .strict();
export type EffectPermit = z.infer<typeof EffectPermitSchema>;

export const NoCutProofSchema = z
  .object({
    proofId: OpaqueIdSchema,
    validationId: OpaqueIdSchema,
    reason: z.literal("NO_VALID_OBSERVED_WORLD_CUT"),
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    dependencySetHash: Sha256DigestSchema,
    decisionCertificateIds: z.tuple([OpaqueIdSchema, OpaqueIdSchema, OpaqueIdSchema]),
    validatedAtHead: z.number().int().nonnegative(),
    lowerBound: z.number().int().nonnegative(),
    upperBound: z.number().int().nonnegative(),
    latestStartingReceiptId: OpaqueIdSchema,
    earliestEndingReceiptId: OpaqueIdSchema,
    conflictWitnessReceiptIds: z.tuple([OpaqueIdSchema, OpaqueIdSchema]),
    refreshAgentIds: z.array(OpaqueIdSchema).min(1).max(3),
    createdAt: TimestampSchema,
  })
  .strict();
export type NoCutProof = z.infer<typeof NoCutProofSchema>;

export const EffectRecordSchema = z
  .object({
    effectId: OpaqueIdSchema,
    type: z.literal("PUBLISH_CAMPAIGN"),
    idempotencyKey: z.string().min(1).max(768),
    permitId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    dependencySetHash: Sha256DigestSchema,
    jointValidityCertificateId: OpaqueIdSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type EffectRecord = z.infer<typeof EffectRecordSchema>;

export const RefreshPlanSchema = z
  .object({
    refreshPlanId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    baseSessionRevision: z.number().int().nonnegative(),
    validatedHead: z.number().int().nonnegative(),
    dependencySetHash: Sha256DigestSchema,
    activeDecisionCertificateIds: z.array(OpaqueIdSchema).length(3),
    agentIds: z.array(OpaqueIdSchema).min(1).max(3),
    status: RefreshPlanStateSchema,
    claimedAttemptId: OpaqueIdSchema.nullable(),
  })
  .strict();
export type RefreshPlan = z.infer<typeof RefreshPlanSchema>;

const RejectedOutputArtifactBaseSchema = z
  .object({
    artifactId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    attemptId: OpaqueIdSchema,
    originalDigest: Sha256DigestSchema,
    redactionVersion: z.literal("epoch-redact-v1"),
    createdAt: TimestampSchema,
  })
  .strict();

const ParseRejectedOutputArtifactSchema = RejectedOutputArtifactBaseSchema.extend({
  reason: z.literal("PARSE_REJECTED"),
  originalByteLength: z.number().int().nonnegative().max(16 * 1_024),
  sanitizedContent: z.string(),
  sanitizedContentDigest: Sha256DigestSchema,
  truncated: z.literal(false),
})
  .strict()
  .superRefine((artifact, context) => {
    if (sha256Digest(artifact.sanitizedContent) !== artifact.sanitizedContentDigest) {
      context.addIssue({
        code: "custom",
        message: "sanitizedContentDigest must match sanitizedContent",
        path: ["sanitizedContentDigest"],
      });
    }
  });

const OversizedRejectedOutputArtifactSchema = RejectedOutputArtifactBaseSchema.extend({
  reason: z.literal("OUTPUT_TOO_LARGE"),
  originalByteLength: z.number().int().min(16 * 1_024 + 1),
  sanitizedContent: z.null(),
  sanitizedContentDigest: z.null(),
  truncated: z.literal(true),
}).strict();

export const RejectedOutputArtifactSchema = z.discriminatedUnion("reason", [
  ParseRejectedOutputArtifactSchema,
  OversizedRejectedOutputArtifactSchema,
]);
export type RejectedOutputArtifact = z.infer<
  typeof RejectedOutputArtifactSchema
>;

const OpaqueArtifactRefKindSchema = z.enum(
  ARTIFACT_REF_KINDS.filter((kind) => kind !== "ENVELOPE_DIGEST") as [
    Exclude<(typeof ARTIFACT_REF_KINDS)[number], "ENVELOPE_DIGEST">,
    ...Exclude<(typeof ARTIFACT_REF_KINDS)[number], "ENVELOPE_DIGEST">[],
  ],
);
export const ArtifactRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ENVELOPE_DIGEST"),
      id: Sha256DigestSchema,
    })
    .strict(),
  z
    .object({
      kind: OpaqueArtifactRefKindSchema,
      id: OpaqueIdSchema,
    })
    .strict(),
]);
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const SafetyDiagnosticSchema = z
  .object({
    diagnosticId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    sessionRevision: z.number().int().nonnegative(),
    fixtureRef: z.string().min(1).max(256).nullable(),
    kind: DiagnosticKindSchema,
    stage: DiagnosticStageSchema,
    reasonCode: FailureCodeSchema,
    role: RoleSchema.nullable(),
    attemptId: OpaqueIdSchema.nullable(),
    assignmentId: OpaqueIdSchema.nullable(),
    runId: OpaqueIdSchema.nullable(),
    artifactRefs: z.array(ArtifactRefSchema),
    causedByDiagnosticIds: z.array(OpaqueIdSchema),
    expected: JsonValueSchema.nullable(),
    actual: JsonValueSchema.nullable(),
    rejectedOutputArtifactId: OpaqueIdSchema.nullable(),
    auditSeq: z.number().int().nonnegative(),
    recommendedAction: RecommendedActionSchema,
  })
  .strict();
export type SafetyDiagnostic = z.infer<typeof SafetyDiagnosticSchema>;

export const SafetyDiagnosticViewSchema = z
  .object({
    diagnosticId: OpaqueIdSchema,
    kind: DiagnosticKindSchema,
    stage: DiagnosticStageSchema,
    reasonCode: FailureCodeSchema,
    role: RoleSchema.nullable(),
    relevantIds: z.array(ArtifactRefSchema),
    auditSeq: z.number().int().nonnegative(),
    recommendedAction: RecommendedActionSchema,
  })
  .strict();
export type SafetyDiagnosticView = z.infer<typeof SafetyDiagnosticViewSchema>;

export const AuditEventSchema = z
  .object({
    eventId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    actionHash: Sha256DigestSchema,
    sessionRevision: z.number().int().nonnegative(),
    auditSeq: z.number().int().nonnegative(),
    type: z.string().min(1).max(128),
    status: z.string().min(1).max(128),
    role: RoleSchema.nullable(),
    artifactRefs: z.array(ArtifactRefSchema),
    createdAt: TimestampSchema,
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const EpochDatabaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotRevision: z.number().int().nonnegative(),
    headSeq: z.number().int().nonnegative(),
    roleAgentRegistrations: z.array(RoleAgentRegistrationSchema),
    worldCommits: z.array(WorldCommitSchema),
    resourceVersions: z.array(ResourceVersionSchema),
    roleQuerySpecs: z.array(RoleQuerySpecSchema),
    runAssignments: z.array(RunAssignmentSchema),
    receipts: z.array(ObservationReceiptSchema),
    sessions: z.array(EpochSessionSchema),
    attempts: z.array(AgentAttemptSchema),
    decisions: z.array(DependencyCertificateSchema),
    validations: z.array(ValidationRecordSchema),
    jointValidityCertificates: z.array(JointValidityCertificateSchema),
    noCutProofs: z.array(NoCutProofSchema),
    refreshPlans: z.array(RefreshPlanSchema),
    permits: z.array(EffectPermitSchema),
    effects: z.array(EffectRecordSchema),
    diagnostics: z.array(SafetyDiagnosticSchema),
    rejectedOutputArtifacts: z.array(RejectedOutputArtifactSchema),
    auditEvents: z.array(AuditEventSchema),
  })
  .strict();
export type EpochDatabase = z.infer<typeof EpochDatabaseSchema>;

export const RedactedDashboardEventSchema = z
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
export type RedactedDashboardEvent = z.infer<typeof RedactedDashboardEventSchema>;

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
    verdict: VerdictSchema,
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

const SnapshotActionViewSchema = ActionCanonicalFieldsSchema.omit({
  schemaVersion: true,
}).strict();

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
    coordinationMode: CoordinationModeSchema,
    sessionState: SessionStateSchema,
    action: SnapshotActionViewSchema,
    actionHash: Sha256DigestSchema,
    worldHead: z.number().int().nonnegative(),
    gate: z
      .object({
        state: GateStateSchema,
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
        state: JointValidityStateSchema,
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
    availableActions: z.array(AvailableActionSchema).max(2),
    latestDiagnostics: z.array(SafetyDiagnosticViewSchema).max(3),
    events: z.array(RedactedDashboardEventSchema).max(6),
  })
  .strict();

type SessionDashboardSnapshotCandidate = z.infer<
  typeof SessionDashboardSnapshotShapeSchema
>;

type AuthoritativeSnapshotProjectionRule = {
  gateState: (typeof GATE_STATES)[number];
  reasonCode: FailureCode | null;
  jointValidityState: (typeof JOINT_VALIDITY_STATES)[number];
  permit: "REQUIRED" | "FORBIDDEN";
  effect: "REQUIRED" | "FORBIDDEN";
  refreshPlan: "AVAILABLE" | "ABSENT_OR_COMPLETED";
  decisions:
    | "THREE"
    | "THREE_CURRENT_VALID_ALLOW"
    | "THREE_CURRENT_VALID_WITH_DENY";
  availableActions: readonly (typeof AVAILABLE_ACTIONS)[number][];
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
  claimedRefresh: {
    sessionStates: ["REOBSERVING", "COLLECTING", "VALIDATING"],
    planStatus: "CLAIMED",
    ownerSet: "exact Agent set with an active inFlightAttempt",
    assignment: "new relative to the owner's active Decision assignment",
  },
  noCutDependencySetHash:
    "sha256(canonicalJSON(sort(all three active receiptIds)))",
} as const;

const CLAIMED_REFRESH_BINDING_STATES =
  SNAPSHOT_UNIVERSAL_SAFETY_RULES.claimedRefresh.sessionStates;
const ACTIVE_IN_FLIGHT_ATTEMPT_STATES = [
  "ASSIGNMENT_CREATED",
  "DISPATCHING",
  "QUEUED",
  "RUNNING",
] as const;

type AuthoritativeSnapshotState =
  keyof typeof AUTHORITATIVE_SNAPSHOT_PROJECTION_RULES;

function authoritativeProjectionRule(
  state: SessionState,
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
      receipt.validUntilSeq > receipt.validFromSeq) &&
    receipt.validFromSeq <= receipt.observedAtSeq &&
    receipt.observedAtSeq < effectiveUntil &&
    receipt.observedAtSeq <= snapshot.worldHead
  );
}

export function snapshotReceiptDependencySetHash(
  receiptIds: readonly string[],
): string {
  return sha256Digest(canonicalJson([...receiptIds].sort()));
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
  const roles = snapshot.agents.map((agent) => agent.role);
  if (roles.join(",") !== ROLES.join(",")) {
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
  if (parsedSnapshotAction.success) {
    const expectedActionHash = sha256Digest(
      canonicalJson({ schemaVersion: 1, ...parsedSnapshotAction.data }),
    );
    if (snapshot.actionHash !== expectedActionHash) {
      snapshotIssue(context, "actionHash does not match the Snapshot Action", [
        "actionHash",
      ]);
    }
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

  const receiptByRole = new Map(
    snapshot.agents.flatMap((agent) =>
      agent.activeDecision === null
        ? []
        : ([[agent.role, agent.activeDecision.receipt]] as const),
    ),
  );
  const receipts = [...receiptByRole.values()];
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
    const boundsAgree =
      proof !== null &&
      snapshot.jointValidity.lowerBound === proof.lowerBound &&
      snapshot.jointValidity.upperBound === proof.upperBound &&
      proof.lowerBound === expectedLower &&
      proof.upperBound === expectedUpper &&
      proof.lowerBound >= proof.upperBound &&
      proof.dependencySetHash === expectedDependencySetHash &&
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
        "NO_CUT requires non-overlapping half-open bounds L>=U and a matching Receipt witness",
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

  if (
    snapshot.refreshPlan?.status === "CLAIMED" &&
    (CLAIMED_REFRESH_BINDING_STATES as readonly string[]).includes(
      snapshot.sessionState,
    )
  ) {
    const inFlightOwners = snapshot.agents.filter(
      (agent) => agent.inFlightAttempt !== null,
    );
    const inFlightOwnerIds = inFlightOwners.map((agent) => agent.agentId);
    const ownerAttemptsAreActiveAndNew = inFlightOwners.every((agent) => {
      const attempt = agent.inFlightAttempt;
      if (attempt === null) return false;
      const representedRuns =
        (agent.activeDecision === null ? 0 : 1) + 1;
      return (
        (ACTIVE_IN_FLIGHT_ATTEMPT_STATES as readonly string[]).includes(
          attempt.status,
        ) &&
        agent.runCount >= representedRuns &&
        (agent.activeDecision === null ||
          attempt.assignmentId !==
            agent.activeDecision.runtimeProof.assignmentId)
      );
    });
    if (
      inFlightOwners.length === 0 ||
      !sameIdSet(snapshot.refreshPlan.agentIds, inFlightOwnerIds) ||
      !ownerAttemptsAreActiveAndNew
    ) {
      snapshotIssue(
        context,
        "CLAIMED refresh must bind exactly its active owner Attempts and new Assignments",
        ["refreshPlan"],
      );
    }
  }

  if (snapshot.jointValidity.state === "NO_CUT" && snapshot.refreshPlan === null) {
    snapshotIssue(context, "NO_CUT must retain a RefreshPlan", ["refreshPlan"]);
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
  .object({
    expectedSessionRevision: z.number().int().nonnegative(),
  })
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

export const makeStaleViewError = (
  sessionId: string,
  expectedSessionRevision: number,
  actualSessionRevision: number,
): StaleViewErrorBody =>
  StaleViewErrorBodySchema.parse({
    error: "STALE_VIEW",
    message: STALE_VIEW_MESSAGE,
    sessionId,
    expectedSessionRevision,
    actualSessionRevision,
  });

export const makeAlreadyReobservingError = (
  sessionId: string,
  refreshPlanId: string,
  attemptId: string,
): AlreadyReobservingErrorBody =>
  AlreadyReobservingErrorBodySchema.parse({
    error: "ALREADY_REOBSERVING",
    message: ALREADY_REOBSERVING_MESSAGE,
    sessionId,
    refreshPlanId,
    attemptId,
  });

export const makeAgentsBusyError = (
  activeSessionId: string,
  assignments: CreateSessionRequest["assignments"],
): AgentsBusyErrorBody =>
  AgentsBusyErrorBodySchema.parse({
    error: "AGENTS_BUSY",
    message: AGENTS_BUSY_MESSAGE,
    activeSessionId,
    assignments,
  });

export const makeMissingActionFieldsError = (
  missingFields: MissingActionFieldsErrorBody["missingFields"],
): MissingActionFieldsErrorBody =>
  MissingActionFieldsErrorBodySchema.parse({
    error: "MISSING_ACTION_FIELDS",
    message: MISSING_ACTION_FIELDS_MESSAGE,
    missingFields,
  });

export const makeSessionNotFoundError = (
  sessionId: string,
): SessionNotFoundErrorBody =>
  SessionNotFoundErrorBodySchema.parse({
    error: "SESSION_NOT_FOUND",
    message: SESSION_NOT_FOUND_MESSAGE,
    sessionId,
  });

export const makeUnsupportedSchemaError = (
  receivedSchemaVersion: number | null,
  receivedContractVersion: string | null,
): UnsupportedSchemaErrorBody =>
  UnsupportedSchemaErrorBodySchema.parse({
    error: "UNSUPPORTED_SCHEMA",
    message: UNSUPPORTED_SCHEMA_MESSAGE,
    expectedSchemaVersion: CONTRACT_SCHEMA_VERSION,
    expectedContractVersion: CONTRACT_VERSION,
    receivedSchemaVersion,
    receivedContractVersion,
  });

export const makeProjectionMismatchError = (
  sessionId: string,
  snapshotRevision: number,
): ProjectionMismatchErrorBody =>
  ProjectionMismatchErrorBodySchema.parse({
    error: "PROJECTION_MISMATCH",
    message: PROJECTION_MISMATCH_MESSAGE,
    sessionId,
    snapshotRevision,
  });

export const ScenarioFixtureManifestEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    fixtureId: OpaqueIdSchema,
    fixtureVersion: OpaqueIdSchema,
    seed: z.number().int().nonnegative(),
    scenarioId: ScenarioIdSchema,
    action: ActionCanonicalFieldsSchema,
    expected: z
      .object({
        initialWorldHead: z.number().int().nonnegative(),
        initialOutcome: ValidationOutcomeSchema,
        lowerBound: z.number().int().nonnegative(),
        upperBound: z.number().int().nonnegative(),
        initialEffectsInSession: z.number().int().nonnegative(),
        refreshRoles: z.array(RoleSchema).max(3),
        finalOutcome: ValidationOutcomeSchema,
        finalEffectsInSession: z.number().int().nonnegative(),
      })
      .strict(),
    requiredFor: z.array(z.enum(["CORE", "REAL_MODEL"])).min(1),
  })
  .strict();
export type ScenarioFixtureManifestEntry = z.infer<
  typeof ScenarioFixtureManifestEntrySchema
>;

export const GOLDEN_ACTION_INPUT = {
  schemaVersion: 1,
  type: "PUBLISH_CAMPAIGN",
  campaignId: "campaign_42",
  requestedUnits: 1,
  estimatedCostCents: 500_000,
  market: "SG",
} as const satisfies ActionCanonicalFields;

export const GOLDEN_ACTION_CANONICAL =
  '{"campaignId":"campaign_42","estimatedCostCents":500000,"market":"SG","requestedUnits":1,"schemaVersion":1,"type":"PUBLISH_CAMPAIGN"}' as const;

// These literal hashes are deliberately not derived from the implementation. Tests
// compare the implementation against them so a canonicalization change is visible.
export const GOLDEN_ACTION_HASH =
  "sha256:bd99e824e58087f03cd1018fe7457865a596ae74ffbb5a707b1d2c3b6da5c202" as const;
export const GOLDEN_QUERY_HASHES = {
  inventory: "sha256:e983c6df43fd6e4cb78da19db9583f0112740ca06be695c1411273dad9f4c8c2",
  budget: "sha256:3497fdc0405a9ac929b9aa370295fac815db538f19efb1c51923c06d744711c4",
  policy: "sha256:8a14b7c6299bffad16ec48f56739aa661dcf3166011f9c554f7ead09ea8117ce",
} as const;

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function sha256Digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalizeAction(
  action: Pick<
    ActionCanonicalFields,
    | "schemaVersion"
    | "type"
    | "campaignId"
    | "requestedUnits"
    | "estimatedCostCents"
    | "market"
  >,
): string {
  const parsed = ActionCanonicalFieldsSchema.parse({
    schemaVersion: action.schemaVersion,
    type: action.type,
    campaignId: action.campaignId,
    requestedUnits: action.requestedUnits,
    estimatedCostCents: action.estimatedCostCents,
    market: action.market,
  });
  return canonicalJson(parsed);
}

export function actionHash(action: ActionCanonicalFields): string {
  return sha256Digest(canonicalizeAction(action));
}

export function canonicalizeRoleQuery(spec: RoleQuerySpec): string {
  const parsed = RoleQuerySpecSchema.parse(spec);
  switch (parsed.role) {
    case "inventory":
      return canonicalJson({
        schemaVersion: parsed.schemaVersion,
        actionHash: parsed.actionHash,
        role: parsed.role,
        source: parsed.source,
        entityKey: parsed.entityKey,
        actionProjection: parsed.actionProjection,
      });
    case "budget":
      return canonicalJson({
        schemaVersion: parsed.schemaVersion,
        actionHash: parsed.actionHash,
        role: parsed.role,
        source: parsed.source,
        entityKey: parsed.entityKey,
        actionProjection: parsed.actionProjection,
      });
    case "policy":
      return canonicalJson({
        schemaVersion: parsed.schemaVersion,
        actionHash: parsed.actionHash,
        role: parsed.role,
        source: parsed.source,
        entityKey: parsed.entityKey,
        actionProjection: parsed.actionProjection,
      });
  }
}

export function queryHash(spec: RoleQuerySpec): string {
  return sha256Digest(canonicalizeRoleQuery(spec));
}

export function buildRoleQuerySpec(
  action: ActionCanonicalFields,
  role: Role,
): RoleQuerySpec {
  const hashedAction = actionHash(action);
  const parsedRole = RoleSchema.parse(role);
  const base = {
    schemaVersion: 1 as const,
    actionHash: hashedAction,
  };
  let withoutHash: Omit<RoleQuerySpec, "queryHash">;
  switch (parsedRole) {
    case "inventory":
      withoutHash = {
        ...base,
        role,
        source: role,
        entityKey: action.campaignId,
        actionProjection: {
          campaignId: action.campaignId,
          requestedUnits: action.requestedUnits,
        },
      };
      break;
    case "budget":
      withoutHash = {
        ...base,
        role,
        source: role,
        entityKey: action.campaignId,
        actionProjection: {
          campaignId: action.campaignId,
          estimatedCostCents: action.estimatedCostCents,
        },
      };
      break;
    case "policy":
      withoutHash = {
        ...base,
        role,
        source: role,
        entityKey: action.market,
        actionProjection: {
          campaignId: action.campaignId,
          market: action.market,
        },
      };
      break;
  }
  const candidate = { ...withoutHash, queryHash: "sha256:" + "0".repeat(64) };
  return RoleQuerySpecSchema.parse({
    ...withoutHash,
    queryHash: sha256Digest(canonicalizeRoleQuery(RoleQuerySpecSchema.parse(candidate))),
  });
}

export const GOLDEN_FIXTURE_MANIFEST = [
  {
    schemaVersion: 1,
    fixtureId: "fixture_normal_world_v1",
    fixtureVersion: "normal-world-v1.0.0",
    seed: 10,
    scenarioId: "normal-world-v1",
    action: GOLDEN_ACTION_INPUT,
    expected: {
      initialWorldHead: 10,
      initialOutcome: "VALID_CURRENT_ALLOW",
      lowerBound: 10,
      upperBound: 11,
      initialEffectsInSession: 0,
      refreshRoles: [],
      finalOutcome: "VALID_CURRENT_ALLOW",
      finalEffectsInSession: 1,
    },
    requiredFor: ["CORE", "REAL_MODEL"],
  },
  {
    schemaVersion: 1,
    fixtureId: "fixture_impossible_collage_v1",
    fixtureVersion: "impossible-collage-v1.0.0",
    seed: 21,
    scenarioId: "impossible-collage-v1",
    action: GOLDEN_ACTION_INPUT,
    expected: {
      initialWorldHead: 21,
      initialOutcome: "NO_VALID_OBSERVED_WORLD_CUT",
      lowerBound: 21,
      upperBound: 20,
      initialEffectsInSession: 0,
      refreshRoles: ["budget"],
      finalOutcome: "CONSISTENT_DENY",
      finalEffectsInSession: 0,
    },
    requiredFor: ["CORE", "REAL_MODEL"],
  },
] as const satisfies readonly ScenarioFixtureManifestEntry[];

const GOLDEN_TIMESTAMP = "2026-08-29T12:00:00.000Z";
const digestPlaceholder = `sha256:${"0".repeat(64)}`;
const goldenReceiptDependencySetHash = snapshotReceiptDependencySetHash(
  ROLES.map((role) => `receipt_${role}_1`),
);

function goldenAgent(
  role: Role,
  options: {
    from: number;
    until: number | null;
    observedAt: number;
    verdict?: Verdict;
    evidenceState?: "CURRENT" | "RETAINED" | "INVALID_AT_HEAD";
    runCount?: number;
  },
) {
  const title = role[0]?.toUpperCase() + role.slice(1);
  return {
    role,
    agentId: `agent_${role}`,
    agentNameAtAssignment: `${title} Agent`,
    runCount: options.runCount ?? 1,
    activeDecision: {
      certificateId: `decision_${role}_1`,
      runId: `run_${role}_1`,
      verdict: options.verdict ?? "ALLOW",
      factSummary: `${title} fixture fact`,
      evidenceState: options.evidenceState ?? "CURRENT",
      receipt: {
        receiptId: `receipt_${role}_1`,
        sourceRevision: options.observedAt,
        observedAtSeq: options.observedAt,
        validFromSeq: options.from,
        validUntilSeq: options.until,
      },
      runtimeProof: {
        assignmentId: `assignment_${role}_1`,
        threadId: `thread_${role}_1`,
        runtimeLabel: "ControlledRunner",
        roleProfileVersion: `${role}-v1`,
        promptTemplateVersion: "epoch-prompt-v1",
        agentsMdDigest: digestPlaceholder,
        evidencePackRelativePath: `.epochguard/sessions/session_golden/${role}/assignment_${role}_1.json`,
        evidencePackHash: digestPlaceholder,
        runStartedAt: GOLDEN_TIMESTAMP,
        runCompletedAt: GOLDEN_TIMESTAMP,
        outputDigest: digestPlaceholder,
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    },
    inFlightAttempt: null,
  };
}

const snapshotBase = {
  schemaVersion: 1 as const,
  contractVersion: CONTRACT_VERSION,
  contractDigest: CONTRACT_DIGEST,
  stateUpdatedAt: GOLDEN_TIMESTAMP,
  generatedAt: GOLDEN_TIMESTAMP,
  coordinationMode: "CONCURRENT" as const,
  action: {
    type: "PUBLISH_CAMPAIGN" as const,
    campaignId: GOLDEN_ACTION_INPUT.campaignId,
    requestedUnits: GOLDEN_ACTION_INPUT.requestedUnits,
    estimatedCostCents: GOLDEN_ACTION_INPUT.estimatedCostCents,
    market: GOLDEN_ACTION_INPUT.market,
  },
  actionHash: GOLDEN_ACTION_HASH,
};

export const NORMAL_READY_GOLDEN_SNAPSHOT = {
  ...snapshotBase,
  snapshotRevision: 11,
  sessionRevision: 5,
  sessionId: "session_normal_golden",
  scenarioId: "normal-world-v1",
  sessionState: "READY_AT_CURRENT_HEAD",
  worldHead: 10,
  gate: {
    state: "READY",
    reasonCode: null,
    effectsInSession: 0,
    permitId: "permit_normal_1",
    effectId: null,
  },
  metrics: {
    activeDecisions: 3,
    requiredDecisions: 3,
    allowDecisions: 3,
    denyDecisions: 0,
    reobservedAgents: 0,
    totalAgents: 3,
    rerunsAvoided: 0,
    verificationLatencyMs: 2,
  },
  agents: [
    goldenAgent("inventory", { from: 10, until: null, observedAt: 10 }),
    goldenAgent("budget", { from: 10, until: null, observedAt: 10 }),
    goldenAgent("policy", { from: 10, until: null, observedAt: 10 }),
  ],
  jointValidity: {
    state: "VALID_CURRENT",
    lowerBound: 10,
    upperBound: 11,
    currentHeadCovered: true,
    noCutProof: null,
  },
  refreshPlan: null,
  availableActions: ["COMMIT"],
  latestDiagnostics: [],
  events: [],
} as const;

export const NORMAL_RELEASED_GOLDEN_SNAPSHOT = {
  ...NORMAL_READY_GOLDEN_SNAPSHOT,
  snapshotRevision: 12,
  sessionRevision: 6,
  sessionState: "COMMITTED",
  gate: {
    state: "RELEASED",
    reasonCode: null,
    effectsInSession: 1,
    permitId: "permit_normal_1",
    effectId: "effect_normal_1",
  },
  availableActions: [],
} as const;

// Compatibility alias for consumers of the v1 Starter seam.
export const NORMAL_GOLDEN_SNAPSHOT = NORMAL_RELEASED_GOLDEN_SNAPSHOT;

export const IMPOSSIBLE_GOLDEN_SNAPSHOT = {
  ...snapshotBase,
  snapshotRevision: 21,
  sessionRevision: 5,
  sessionId: "session_impossible_golden",
  scenarioId: "impossible-collage-v1",
  sessionState: "BLOCKED_NO_CUT",
  worldHead: 21,
  gate: {
    state: "LOCKED",
    reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  },
  metrics: {
    activeDecisions: 3,
    requiredDecisions: 3,
    allowDecisions: 3,
    denyDecisions: 0,
    reobservedAgents: 0,
    totalAgents: 3,
    rerunsAvoided: 2,
    verificationLatencyMs: 3,
  },
  agents: [
    goldenAgent("inventory", { from: 18, until: null, observedAt: 18 }),
    goldenAgent("budget", {
      from: 19,
      until: 20,
      observedAt: 19,
      evidenceState: "INVALID_AT_HEAD",
    }),
    goldenAgent("policy", { from: 21, until: null, observedAt: 21 }),
  ],
  jointValidity: {
    state: "NO_CUT",
    lowerBound: 21,
    upperBound: 20,
    currentHeadCovered: false,
    noCutProof: {
      proofId: "proof_impossible_1",
      dependencySetHash: goldenReceiptDependencySetHash,
      lowerBound: 21,
      upperBound: 20,
      witness: [
        { role: "budget", receiptId: "receipt_budget_1", from: 19, until: 20 },
        { role: "policy", receiptId: "receipt_policy_1", from: 21, until: null },
      ],
    },
  },
  refreshPlan: {
    refreshPlanId: "refresh_impossible_1",
    status: "AVAILABLE",
    agentIds: ["agent_budget"],
    reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
  },
  availableActions: ["REOBSERVE_INVALID"],
  latestDiagnostics: [
    {
      diagnosticId: "diagnostic_impossible_1",
      kind: "EXPECTED_BLOCK",
      stage: "VALIDATE",
      reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
      role: null,
      relevantIds: [
        { kind: "PROOF", id: "proof_impossible_1" },
        { kind: "RECEIPT", id: "receipt_budget_1" },
        { kind: "RECEIPT", id: "receipt_policy_1" },
      ],
      auditSeq: 21,
      recommendedAction: "REOBSERVE_INVALID",
    },
  ],
  events: [],
} as const;

export const RECOVERED_GOLDEN_SNAPSHOT = {
  ...snapshotBase,
  snapshotRevision: 24,
  sessionRevision: 8,
  sessionId: "session_impossible_golden",
  scenarioId: "impossible-collage-v1",
  sessionState: "CONSISTENT_DENY",
  worldHead: 22,
  gate: {
    state: "LOCKED",
    reasonCode: "CONSISTENT_DENY",
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  },
  metrics: {
    activeDecisions: 3,
    requiredDecisions: 3,
    allowDecisions: 2,
    denyDecisions: 1,
    reobservedAgents: 1,
    totalAgents: 3,
    rerunsAvoided: 2,
    verificationLatencyMs: 2,
  },
  agents: [
    goldenAgent("inventory", {
      from: 18,
      until: null,
      observedAt: 18,
      evidenceState: "RETAINED",
    }),
    goldenAgent("budget", {
      from: 22,
      until: null,
      observedAt: 22,
      verdict: "DENY",
      runCount: 2,
    }),
    goldenAgent("policy", {
      from: 21,
      until: null,
      observedAt: 21,
      evidenceState: "RETAINED",
    }),
  ],
  jointValidity: {
    state: "VALID_CURRENT",
    lowerBound: 22,
    upperBound: 23,
    currentHeadCovered: true,
    noCutProof: null,
  },
  refreshPlan: {
    refreshPlanId: "refresh_impossible_1",
    status: "COMPLETED",
    agentIds: ["agent_budget"],
    reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
  },
  availableActions: [],
  latestDiagnostics: [],
  events: [],
} as const;

const CONTRACT_FIELD_MANIFEST = {
  contractVersion: CONTRACT_VERSION,
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  p0Semantics: {
    sameRoleAgentTripleConflict: "409_AGENTS_BUSY_BEFORE_DISPATCH",
    exactlyOnceScope: "SESSION_PLUS_ACTION",
  },
  enums: {
    roles: ROLES,
    sources: SOURCES,
    verdicts: VERDICTS,
    scenarioIds: SCENARIO_IDS,
    sessionStates: SESSION_STATES,
    attemptStates: ATTEMPT_STATES,
    assignmentStates: ASSIGNMENT_STATES,
    decisionStates: DECISION_STATES,
    validationOutcomes: VALIDATION_OUTCOMES,
    permitStates: PERMIT_STATES,
    refreshPlanStates: REFRESH_PLAN_STATES,
    coordinationModes: COORDINATION_MODES,
    gateStates: GATE_STATES,
    jointValidityStates: JOINT_VALIDITY_STATES,
    failureCodes: FAILURE_CODES,
    diagnosticKinds: DIAGNOSTIC_KINDS,
    diagnosticStages: DIAGNOSTIC_STAGES,
    artifactRefKinds: ARTIFACT_REF_KINDS,
  },
  artifactRefTargets: ARTIFACT_REF_TARGETS,
  errors: {
    staleView: {
      error: "STALE_VIEW",
      message: STALE_VIEW_MESSAGE,
      fields: [
        "error",
        "message",
        "sessionId",
        "expectedSessionRevision",
        "actualSessionRevision",
      ],
    },
    alreadyReobserving: {
      error: "ALREADY_REOBSERVING",
      message: ALREADY_REOBSERVING_MESSAGE,
      fields: ["error", "message", "sessionId", "refreshPlanId", "attemptId"],
    },
    agentsBusy: {
      error: "AGENTS_BUSY",
      message: AGENTS_BUSY_MESSAGE,
      fields: ["error", "message", "activeSessionId", "assignments"],
    },
  },
  canonicalization: {
    algorithm: "epochguard-canonical-json-v1:recursive-lexicographic-keys",
    actionCanonical: GOLDEN_ACTION_CANONICAL,
    actionHash: GOLDEN_ACTION_HASH,
    queryHashes: GOLDEN_QUERY_HASHES,
  },
  constraints: {
    evidencePackRelativePath:
      ".epochguard/sessions/<sessionId>/<role>/<assignmentId>.json",
    agentOrder: "inventory,budget,policy",
    snapshotDecisionMetrics: "allowDecisions+denyDecisions=activeDecisions",
  },
  schemaFields: {
    actionIntent: [
      "schemaVersion",
      "type",
      "campaignId",
      "requestedUnits",
      "estimatedCostCents",
      "market",
      "actionId",
      "sessionId",
      "actionHash",
      "idempotencyKey",
    ],
    roleQuerySpec: [
      "schemaVersion",
      "actionHash",
      "role",
      "source",
      "entityKey",
      "actionProjection",
      "queryHash",
    ],
    runAssignment: [
      "assignmentId",
      "sessionId",
      "actionHash",
      "agentId",
      "agentNameAtAssignment",
      "role",
      "receiptId",
      "queryHash",
      "roleProfileVersion",
      "promptTemplateVersion",
      "agentsMdDigest",
      "runtimeLabelAtDispatch",
      "evidencePackRelativePath",
      "evidencePackHash",
      "boundRunId",
      "status",
      "consumedByDecisionCertificateId",
      "createdAt",
      "boundAt",
      "consumedAt",
    ],
    agentAttempt: [
      "attemptId",
      "sessionId",
      "actionHash",
      "role",
      "agentId",
      "assignmentId",
      "runId",
      "status",
      "runStartedAt",
      "runCompletedAt",
      "threadId",
      "usage",
      "outputDigest",
    ],
    observationReceipt: [
      "schemaVersion",
      "receiptId",
      "sessionId",
      "actionHash",
      "agentId",
      "runAssignmentId",
      "role",
      "source",
      "entityKey",
      "queryHash",
      "sourceRevision",
      "valueHash",
      "observedAtSeq",
      "nonce",
      "issuer",
      "issuedAt",
      "integrityTag",
    ],
    agentDecisionEnvelope: [
      "schemaVersion",
      "sessionId",
      "actionHash",
      "runAssignmentId",
      "role",
      "receiptId",
      "nonce",
      "verdict",
      "reason",
    ],
    dependencyCertificate: [
      "certificateId",
      "sessionId",
      "actionHash",
      "agentId",
      "runAssignmentId",
      "runId",
      "role",
      "verdict",
      "receiptIds",
      "decisionDigest",
      "status",
      "supersededByCertificateId",
      "constructedBy",
      "createdAt",
    ],
    epochSession: [
      "sessionId",
      "scenarioId",
      "action",
      "actionHash",
      "state",
      "sessionRevision",
      "coordinationMode",
      "frozenAssignments",
      "activeDecisionCertificateIds",
      "activeAttemptIds",
      "activeValidationId",
      "activeRefreshPlanId",
      "activePermitId",
      "stateUpdatedAt",
      "createdAt",
    ],
    validationRecord: [
      "validationId",
      "sessionId",
      "actionHash",
      "baseSessionRevision",
      "decisionCertificateIds",
      "dependencySetHash",
      "validatedHead",
      "outcome",
      "lowerBound",
      "upperBound",
      "jointValidityCertificateId",
      "noCutProofId",
      "refreshPlanId",
      "verificationLatencyMs",
      "createdAt",
    ],
    jointValidityCertificate: [
      "certificateId",
      "validationId",
      "sessionId",
      "actionHash",
      "dependencySetHash",
      "validatedAtHead",
      "selectedCutSeq",
      "currentHeadCovered",
      "decisionCertificateIds",
      "intervals",
      "validatorVersion",
      "createdAt",
    ],
    effectPermit: [
      "permitId",
      "sessionId",
      "actionHash",
      "dependencySetHash",
      "jointValidityCertificateId",
      "validatedHead",
      "idempotencyKey",
      "status",
      "issuedAt",
      "consumedAt",
    ],
    noCutProof: [
      "proofId",
      "validationId",
      "reason",
      "sessionId",
      "actionHash",
      "dependencySetHash",
      "decisionCertificateIds",
      "validatedAtHead",
      "lowerBound",
      "upperBound",
      "latestStartingReceiptId",
      "earliestEndingReceiptId",
      "conflictWitnessReceiptIds",
      "refreshAgentIds",
      "createdAt",
    ],
    effectRecord: [
      "effectId",
      "type",
      "idempotencyKey",
      "permitId",
      "sessionId",
      "actionHash",
      "dependencySetHash",
      "jointValidityCertificateId",
      "createdAt",
    ],
    refreshPlan: [
      "refreshPlanId",
      "sessionId",
      "baseSessionRevision",
      "validatedHead",
      "dependencySetHash",
      "activeDecisionCertificateIds",
      "agentIds",
      "status",
      "claimedAttemptId",
    ],
    safetyDiagnostic: [
      "diagnosticId",
      "sessionId",
      "actionHash",
      "sessionRevision",
      "fixtureRef",
      "kind",
      "stage",
      "reasonCode",
      "role",
      "attemptId",
      "assignmentId",
      "runId",
      "artifactRefs",
      "causedByDiagnosticIds",
      "expected",
      "actual",
      "rejectedOutputArtifactId",
      "auditSeq",
      "recommendedAction",
    ],
    epochDatabase: [
      "schemaVersion",
      "snapshotRevision",
      "headSeq",
      "roleAgentRegistrations",
      "worldCommits",
      "resourceVersions",
      "roleQuerySpecs",
      "runAssignments",
      "receipts",
      "sessions",
      "attempts",
      "decisions",
      "validations",
      "jointValidityCertificates",
      "noCutProofs",
      "refreshPlans",
      "permits",
      "effects",
      "diagnostics",
      "rejectedOutputArtifacts",
      "auditEvents",
    ],
    sessionDashboardSnapshot: [
      "schemaVersion",
      "contractVersion",
      "contractDigest",
      "snapshotRevision",
      "sessionRevision",
      "stateUpdatedAt",
      "generatedAt",
      "sessionId",
      "scenarioId",
      "coordinationMode",
      "sessionState",
      "action",
      "actionHash",
      "worldHead",
      "gate",
      "metrics",
      "agents",
      "jointValidity",
      "refreshPlan",
      "availableActions",
      "latestDiagnostics",
      "events",
    ],
  },
  fixtureIds: GOLDEN_FIXTURE_MANIFEST.map((fixture) => fixture.fixtureId),
  snapshotSchema: "SessionDashboardSnapshot@1-strict",
} as const;

export const CONTRACT_SCHEMA_REGISTRY = {
  JsonValue: JsonValueSchema,
  Timestamp: TimestampSchema,
  OpaqueId: OpaqueIdSchema,
  Sha256Digest: Sha256DigestSchema,
  EvidencePackRelativePath: EvidencePackRelativePathSchema,
  Role: RoleSchema,
  Source: SourceSchema,
  Verdict: VerdictSchema,
  ScenarioId: ScenarioIdSchema,
  SessionState: SessionStateSchema,
  AttemptState: AttemptStateSchema,
  AssignmentState: AssignmentStateSchema,
  DecisionState: DecisionStateSchema,
  ValidationOutcome: ValidationOutcomeSchema,
  PermitState: PermitStateSchema,
  RefreshPlanState: RefreshPlanStateSchema,
  CoordinationMode: CoordinationModeSchema,
  GateState: GateStateSchema,
  JointValidityState: JointValidityStateSchema,
  FailureCode: FailureCodeSchema,
  DiagnosticKind: DiagnosticKindSchema,
  DiagnosticStage: DiagnosticStageSchema,
  RecommendedAction: RecommendedActionSchema,
  AvailableAction: AvailableActionSchema,
  ArtifactRefKind: ArtifactRefKindSchema,
  ActionCanonicalFields: ActionCanonicalFieldsSchema,
  ActionIntent: ActionIntentSchema,
  RoleQuerySpec: RoleQuerySpecSchema,
  RoleAgentRegistration: RoleAgentRegistrationSchema,
  WorldCommit: WorldCommitSchema,
  ResourceVersion: ResourceVersionSchema,
  RunUsage: RunUsageSchema,
  RunAssignment: RunAssignmentSchema,
  AgentAttempt: AgentAttemptSchema,
  ObservationReceipt: ObservationReceiptSchema,
  AgentDecisionEnvelope: AgentDecisionEnvelopeSchema,
  DependencyCertificate: DependencyCertificateSchema,
  ActiveDecisionCertificateIds: ActiveDecisionCertificateIdsSchema,
  EpochSession: EpochSessionSchema,
  ValidationRecord: ValidationRecordSchema,
  JointValidityCertificate: JointValidityCertificateSchema,
  EffectPermit: EffectPermitSchema,
  NoCutProof: NoCutProofSchema,
  EffectRecord: EffectRecordSchema,
  RefreshPlan: RefreshPlanSchema,
  RejectedOutputArtifact: RejectedOutputArtifactSchema,
  ArtifactRef: ArtifactRefSchema,
  SafetyDiagnostic: SafetyDiagnosticSchema,
  SafetyDiagnosticView: SafetyDiagnosticViewSchema,
  AuditEvent: AuditEventSchema,
  EpochDatabase: EpochDatabaseSchema,
  RedactedDashboardEvent: RedactedDashboardEventSchema,
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
  ScenarioFixtureManifestEntry: ScenarioFixtureManifestEntrySchema,
} as const satisfies Record<string, z.ZodType>;

export const SHARED_CONTRACT_SCHEMA_NAMES = [
  "OpaqueId",
  "Sha256Digest",
  "Role",
  "ScenarioId",
  "SessionState",
  "FailureCode",
  "ArtifactRefKind",
  "ArtifactRef",
  "SessionDashboardSnapshot",
  "CreateSessionRequest",
  "RefreshSessionRequest",
  "CommitSessionRequest",
  "StaleViewErrorBody",
  "AlreadyReobservingErrorBody",
  "AgentsBusyErrorBody",
  "MissingActionFieldsErrorBody",
  "SessionNotFoundErrorBody",
  "UnsupportedSchemaErrorBody",
  "ProjectionMismatchErrorBody",
  "ConflictErrorBody",
  "ApiErrorBody",
] as const;

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
  "Every active Receipt has validUntilSeq=null or >validFromSeq, validFromSeq<=observedAtSeq<(validUntilSeq??worldHead+1), and observedAtSeq<=worldHead",
  "Snapshot certificate, run, receipt, assignment, and attempt references are unique across Agents within each ID namespace",
  "Snapshot metrics equal active Decision verdicts, reobserved Agent runCounts, and refresh ownership",
  "Only BLOCKED_NO_CUT, HISTORICAL_STALE, CONSISTENT_DENY, READY_AT_CURRENT_HEAD, and COMMITTED have bidirectionally frozen projection products; other Session states retain only universal safety constraints",
  "RELEASED iff COMMITTED projects one Permit-bound Effect, effectsInSession=1, three current-valid ALLOW Decisions, and no mutation action or in-flight Attempt",
  "non-RELEASED Snapshot has zero Effects and no Effect ID",
  "LOCKED carries no Permit; Permit IDs are restricted to READY_AT_CURRENT_HEAD, COMMITTING, or COMMITTED",
  "VALID_CURRENT has no No-Cut proof and exact interval bounds covering worldHead",
  "NO_CUT has exact receipt-derived L/U with L>=U and a two-Receipt endpoint witness",
  "NO_CUT dependencySetHash equals sha256(canonicalJSON(sort(all three active receiptIds)))",
  "NO_CUT retains a RefreshPlan while its old proof may remain visible through non-authoritative refresh projections",
  "CURRENT and RETAINED evidence exactly mean the half-open Receipt covers worldHead; INVALID_AT_HEAD exactly means it does not",
  "AVAILABLE RefreshPlan exists only for BLOCKED_NO_CUT/HISTORICAL_STALE and owns exactly the current invalid-Receipt Agents; CLAIMED exposes no action",
  "REOBSERVING/COLLECTING/VALIDATING with CLAIMED Plan binds exactly the active in-flight owner Agent set and each owner's new Assignment; FAILED/INTERRUPTED terminal products remain unfrozen",
  "READY_AT_CURRENT_HEAD accepts an absent initial Plan or the exact COMPLETED selective-refresh Plan and always exposes exactly COMMIT",
  "FAILED with WAITING and null reason is rejected; side-effect-free FAILED/INTERRUPTED Gate and reason products otherwise remain unfrozen",
  "availableActions is exactly REOBSERVE_INVALID for blocked/historical AVAILABLE Plans, COMMIT for READY_AT_CURRENT_HEAD, and empty otherwise",
] as const;

export const CONTRACT_DIGEST_PLACEHOLDER =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const;
export const CONTRACT_DIGEST_ALGORITHM = {
  version: "epochguard-contract-digest-v2",
  canonicalization: "epochguard-canonical-json-v1:recursive-lexicographic-keys",
  jsonSchema: "Zod v4 draft-2020-12 JSON Schema with reused=ref",
  selfReference:
    "Before hashing, replace every string equal to the active CONTRACT_DIGEST, direct contractDigest values, and JSON Schema properties.contractDigest.const with CONTRACT_DIGEST_PLACEHOLDER; this also covers reused $defs.",
  goldenSnapshotHash:
    "sha256(canonicalJSON(snapshot normalized by the same contractDigest placeholder rule))",
} as const;

export function normalizeContractDigestReferences(
  value: JsonValue,
  pathSegments: readonly string[] = [],
): JsonValue {
  const last = pathSegments.at(-1);
  const isDirectDigest = last === "contractDigest";
  const isSchemaDigestConst =
    last === "const" &&
    pathSegments.at(-2) === "contractDigest" &&
    pathSegments.at(-3) === "properties";
  if (
    typeof value === "string" &&
    (value === CONTRACT_DIGEST || isDirectDigest || isSchemaDigestConst)
  ) {
    return CONTRACT_DIGEST_PLACEHOLDER;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      normalizeContractDigestReferences(item, [...pathSegments, String(index)]),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalizeContractDigestReferences(item, [...pathSegments, key]),
    ]),
  );
}

export const GOLDEN_SNAPSHOT_HASHES = {
  normalReady:
    "sha256:6881ef0374ff817f38d9de88136bd2a9c90c928f8c3e482587daad888f1355b5",
  normalReleased:
    "sha256:e90ddce04fbb1d4ca7271ddcaff4b7e1d8b96a46514ced43d4858cee37ab6f82",
  impossible:
    "sha256:f7485c02853a5c6df35f0db052b4c46ed05c5e992c5d038d0c18253a057b20bf",
  recovered:
    "sha256:76607b683f2e276d6b7b4ae063e6c5dc60c9f4f0a99f7495925233496c86e271",
} as const;

function contractJsonSchema(schema: z.ZodType): JsonValue {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    reused: "ref",
  }) as JsonValue;
}

export function buildContractJsonSchemas(): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(CONTRACT_SCHEMA_REGISTRY).map(([name, schema]) => [
      name,
      normalizeContractDigestReferences(contractJsonSchema(schema), [
        "schemas",
        name,
      ]),
    ]),
  );
}

export function buildContractDigestDocument(): JsonValue {
  const roleQueryGoldenVectors = Object.fromEntries(
    ROLES.map((role) => {
      const spec = buildRoleQuerySpec(GOLDEN_ACTION_INPUT, role);
      return [
        role,
        {
          spec,
          canonical: canonicalizeRoleQuery(spec),
          hash: queryHash(spec),
        },
      ];
    }),
  );
  const snapshots = normalizeContractDigestReferences({
    normalReady: NORMAL_READY_GOLDEN_SNAPSHOT,
    normalReleased: NORMAL_RELEASED_GOLDEN_SNAPSHOT,
    impossible: IMPOSSIBLE_GOLDEN_SNAPSHOT,
    recovered: RECOVERED_GOLDEN_SNAPSHOT,
  });
  if (snapshots === null || Array.isArray(snapshots) || typeof snapshots !== "object") {
    throw new Error("Golden Snapshot normalization produced an invalid document");
  }
  return {
    algorithm: CONTRACT_DIGEST_ALGORITHM,
    contractVersion: CONTRACT_VERSION,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    p0Semantics: CONTRACT_FIELD_MANIFEST.p0Semantics,
    schemas: buildContractJsonSchemas(),
    semanticInvariants: CONTRACT_SEMANTIC_INVARIANTS,
    authoritativeSnapshotProjectionRules:
      AUTHORITATIVE_SNAPSHOT_PROJECTION_RULES,
    snapshotUniversalSafetyRules: SNAPSHOT_UNIVERSAL_SAFETY_RULES,
    canonicalization: {
      actionInput: GOLDEN_ACTION_INPUT,
      actionCanonical: GOLDEN_ACTION_CANONICAL,
      actionHash: GOLDEN_ACTION_HASH,
      roleQueries: roleQueryGoldenVectors,
    },
    artifactRefTargets: ARTIFACT_REF_TARGETS,
    errorStatuses: API_ERROR_STATUS,
    exactErrorBodies: {
      staleView: makeStaleViewError("session_example", 4, 5),
      alreadyReobserving: makeAlreadyReobservingError(
        "session_example",
        "refresh_example",
        "attempt_example",
      ),
      agentsBusy: makeAgentsBusyError("session_active", {
        inventory: "agent_inventory",
        budget: "agent_budget",
        policy: "agent_policy",
      }),
      missingActionFields: makeMissingActionFieldsError(["campaignId"]),
      sessionNotFound: makeSessionNotFoundError("session_missing"),
      unsupportedSchema: makeUnsupportedSchemaError(2, "epochguard-contract-v1"),
      projectionMismatch: makeProjectionMismatchError("session_example", 7),
    },
    fixtures: GOLDEN_FIXTURE_MANIFEST,
    goldenSnapshots: snapshots,
    goldenSnapshotHashes: GOLDEN_SNAPSHOT_HASHES,
    schemaFieldIndex: CONTRACT_FIELD_MANIFEST.schemaFields,
  } as JsonValue;
}

export const CONTRACT_MANIFEST = buildContractDigestDocument();

export function computeContractDigest(
  manifest: JsonValue = buildContractDigestDocument(),
): string {
  return sha256Digest(
    canonicalJson(normalizeContractDigestReferences(manifest)),
  );
}

export function decodeSessionDashboardSnapshot(input: unknown): SessionDashboardSnapshot {
  const snapshot = SessionDashboardSnapshotSchema.parse(input);
  if (snapshot.contractDigest !== CONTRACT_DIGEST) {
    throw new Error(
      `Unsupported EpochGuard contract digest: ${snapshot.contractDigest}`,
    );
  }
  return snapshot;
}
