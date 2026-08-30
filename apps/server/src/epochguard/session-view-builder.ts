import {
  CONTRACT_DIGEST,
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_VERSION,
  EpochDatabaseSchema,
  ROLES,
  buildRoleQuerySpec,
  canonicalJson,
  decodeSessionDashboardSnapshot,
  sha256Digest,
  snapshotReceiptDependencySetHash,
  type AgentAttempt,
  type DependencyCertificate,
  type EpochDatabase,
  type EpochSession,
  type JsonValue,
  type ObservationReceipt,
  type RefreshPlan,
  type ResourceVersion,
  type Role,
  type RunAssignment,
  type SessionDashboardSnapshot,
  type ValidationRecord,
} from "./types.js";
import {
  SafetyDiagnosticIntegrityError,
  latestSafetyDiagnosticViews,
} from "./safety-diagnostics.js";

export type SessionViewBuilderErrorCode =
  | "SESSION_NOT_FOUND"
  | "UNSUPPORTED_SCHEMA"
  | "PROJECTION_MISMATCH";

export class SessionViewBuilderError extends Error {
  readonly name = "SessionViewBuilderError";

  constructor(
    readonly code: SessionViewBuilderErrorCode,
    readonly sessionId: string,
    readonly snapshotRevision: number | null,
    message: string,
  ) {
    super(message);
  }
}

export interface EpochStoreSnapshotPort {
  snapshot(): unknown;
}

export type SessionViewClock = () => string;

type AgentView = SessionDashboardSnapshot["agents"][number];
type ActiveDecisionView = NonNullable<AgentView["activeDecision"]>;
type InFlightAttemptView = NonNullable<AgentView["inFlightAttempt"]>;
type JointValidityView = SessionDashboardSnapshot["jointValidity"];
type RefreshPlanView = NonNullable<SessionDashboardSnapshot["refreshPlan"]>;

type ResolvedDecisionEvidence = {
  role: Role;
  agentId: string;
  decision: DependencyCertificate;
  assignment: RunAssignment;
  attempt: AgentAttempt;
  receipt: ObservationReceipt;
  version: ResourceVersion;
};

type ResolvedInFlightAttempt = {
  attempt: AgentAttempt & { status: InFlightAttemptView["status"] };
  assignment: RunAssignment;
};

type ProjectionContext = {
  database: EpochDatabase;
  session: EpochSession;
  agents: AgentView[];
  activeValidation: ValidationRecord | null;
  jointValidity: JointValidityView;
  refreshPlan: RefreshPlanView | null;
};

const ROLE_ASSIGNMENT_KEYS = {
  inventory: "inventoryAgentId",
  budget: "budgetAgentId",
  policy: "policyAgentId",
} as const satisfies Record<Role, keyof EpochSession["frozenAssignments"]>;

function projectionFailure(
  sessionId: string,
  snapshotRevision: number | null,
  message: string,
): never {
  throw new SessionViewBuilderError(
    "PROJECTION_MISMATCH",
    sessionId,
    snapshotRevision,
    message,
  );
}

function unique<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  sessionId: string,
  snapshotRevision: number,
  label: string,
): T {
  const matches = values.filter(predicate);
  if (matches.length !== 1 || matches[0] === undefined) {
    projectionFailure(
      sessionId,
      snapshotRevision,
      `${label} must resolve exactly once in the captured EpochStore snapshot.`,
    );
  }
  return matches[0];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SENSITIVE_TEXT_PATTERNS = [
  /(?:^|[\s"'=])[A-Za-z]:[\\/]/,
  /(?:^|[\s"'=])\\\\[^\\\s]+\\/,
  /(?:^|[\s"'=])\/(?:Users|home|root|tmp|var|etc|workspace|mnt)\//i,
  /(?:^|[\s"'=])\/(?!\/)[^\s]+/,
  /\b(?:ARK|OPENAI|VOLC|AWS|AZURE|GOOGLE)[A-Z0-9_]*(?:API_)?KEY\s*[:=]/i,
  /\b(?:password|secret|api[_-]?key|token|credential|private[_-]?key)\s*[:=]\s*\S+/i,
  /\b[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+/i,
  /\bBasic\s+[A-Za-z0-9+/=]+/i,
  /\b(?:Proxy-)?Authorization\s*[:=]\s*\S+(?:\s+\S+)?/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
  /\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{8,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\bLTAI[A-Za-z0-9]{16,}\b/,
  /\b(?:xox[baprs]-|glpat-|npm_|hf_|sk_live_|rk_live_)[A-Za-z0-9_-]{12,}\b/i,
  /\bprocess\.env\b/i,
  /<EPOCH_DECISION>/i,
  /\bYou are the (?:Inventory|Budget|Policy) Agent\b/i,
  /\b(?:system|developer|user)\s+prompt\s*[:=]/i,
  /\braw[_ -]?(?:prompt|output)\b/i,
  /\b(?:RAW_PROMPT|RAW_OUTPUT|ENV_DUMP|ABSOLUTE_PATH|SECRET|API_KEY)_SENTINEL\b/i,
] as const;

function tokenEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

type SensitiveTextContext = {
  readonly allowSystemId: boolean;
  readonly allowSha256Digest: boolean;
};

const FREE_TEXT_CONTEXT: SensitiveTextContext = {
  allowSystemId: false,
  allowSha256Digest: false,
};

const SYSTEM_ID_CONTEXT: SensitiveTextContext = {
  allowSystemId: true,
  allowSha256Digest: false,
};

function containsHighEntropySecret(
  value: string,
  context: SensitiveTextContext,
): boolean {
  for (const match of value.matchAll(/[A-Za-z0-9+_=-]{24,}/g)) {
    const token = match[0];
    const offset = match.index ?? 0;
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(token)) {
      if (context.allowSystemId) continue;
      return true;
    }
    if (
      /^[0-9a-f]{64}$/i.test(token) &&
      value.slice(Math.max(0, offset - 7), offset) === "sha256:"
    ) {
      if (context.allowSha256Digest) continue;
      return true;
    }
    const characterClasses = [
      /[a-z]/.test(token),
      /[A-Z]/.test(token),
      /[0-9]/.test(token),
      /[+_=-]/.test(token),
    ].filter(Boolean).length;
    const entropy = tokenEntropy(token);
    if (
      (characterClasses >= 3 && entropy >= 3.25) ||
      (characterClasses >= 2 && entropy >= 4.25)
    ) {
      return true;
    }
  }
  return false;
}

function containsSensitiveText(
  value: string,
  context: SensitiveTextContext = FREE_TEXT_CONTEXT,
): boolean {
  return (
    SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value)) ||
    containsHighEntropySecret(value, context)
  );
}

function sanitizeDisplayText(value: string, fallback: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    containsSensitiveText(normalized) ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._():+&-]*$/u.test(normalized)
  ) {
    return fallback;
  }
  return normalized;
}

function sanitizeEventToken(value: string, fallback: string): string {
  const normalized = sanitizeDisplayText(value, fallback);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(normalized) ? normalized : fallback;
}

function sanitizeOpaqueDisplayId(value: string, fallback: string): string {
  return containsSensitiveText(value, SYSTEM_ID_CONTEXT) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
    ? fallback
    : value;
}

function sanitizeThreadId(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return !containsSensitiveText(normalized, SYSTEM_ID_CONTEXT) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(normalized)
    ? normalized
    : null;
}

function isSafeStructuredEvidencePackPath(value: string): boolean {
  const match =
    /^\.epochguard\/sessions\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(inventory|budget|policy)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/.exec(
      value,
    );
  return (
    match !== null &&
    match[1] !== undefined &&
    match[3] !== undefined &&
    !containsSensitiveText(match[1], SYSTEM_ID_CONTEXT) &&
    !containsSensitiveText(match[3], SYSTEM_ID_CONTEXT)
  );
}

function assertSnapshotContainsNoSensitiveMaterial(
  snapshot: SessionDashboardSnapshot,
): void {
  const isSystemIdField = (
    key: string | null,
    parent: Record<string, unknown> | null,
  ): boolean =>
    key !== null &&
    (/Ids?$/.test(key) ||
      key === "roleProfileVersion" ||
      key === "promptTemplateVersion" ||
      (key === "id" &&
        typeof parent?.kind === "string" &&
        parent.kind !== "ENVELOPE_DIGEST"));
  const isDigestField = (
    key: string | null,
    parent: Record<string, unknown> | null,
  ): boolean =>
    key !== null &&
    (/(?:Hash|Digest)$/.test(key) ||
      (key === "id" && parent?.kind === "ENVELOPE_DIGEST"));
  const visit = (
    value: unknown,
    path: string,
    key: string | null,
    parent: Record<string, unknown> | null,
  ): void => {
    if (typeof value === "string") {
      if (
        !(
          key === "evidencePackRelativePath" &&
          isSafeStructuredEvidencePackPath(value)
        ) &&
        containsSensitiveText(value, {
          allowSystemId: isSystemIdField(key, parent),
          allowSha256Digest: isDigestField(key, parent),
        })
      ) {
        projectionFailure(
          snapshot.sessionId,
          snapshot.snapshotRevision,
          `Dashboard projection field ${path} contains sensitive or untrusted text.`,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        visit(item, `${path}[${index}]`, key, parent),
      );
      return;
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const [childKey, childValue] of Object.entries(record)) {
        visit(childValue, `${path}.${childKey}`, childKey, record);
      }
    }
  };
  visit(snapshot, "snapshot", null, null);
}

function parseDatabase(input: unknown, sessionId: string): EpochDatabase {
  const receivedSchemaVersion =
    input !== null && typeof input === "object" && "schemaVersion" in input
      ? (input as { schemaVersion?: unknown }).schemaVersion
      : null;
  const receivedSnapshotRevision =
    input !== null && typeof input === "object" && "snapshotRevision" in input
      ? (input as { snapshotRevision?: unknown }).snapshotRevision
      : null;
  if (receivedSchemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw new SessionViewBuilderError(
      "UNSUPPORTED_SCHEMA",
      sessionId,
      typeof receivedSnapshotRevision === "number"
        ? receivedSnapshotRevision
        : null,
      "EpochStore snapshot schema is unsupported.",
    );
  }
  const parsed = EpochDatabaseSchema.safeParse(input);
  if (!parsed.success) {
    projectionFailure(
      sessionId,
      typeof receivedSnapshotRevision === "number"
        ? receivedSnapshotRevision
        : null,
      "EpochStore snapshot failed contract-v6 validation.",
    );
  }
  return parsed.data;
}

function resolveReceiptVersion(
  database: EpochDatabase,
  session: EpochSession,
  receipt: ObservationReceipt,
): ResourceVersion {
  const query = unique(
    database.roleQuerySpecs,
    (candidate) => candidate.queryHash === receipt.queryHash,
    session.sessionId,
    database.snapshotRevision,
    "RoleQuerySpec",
  );
  if (
    canonicalJson(query) !==
      canonicalJson(buildRoleQuerySpec(session.action, receipt.role)) ||
    query.actionHash !== session.actionHash ||
    query.role !== receipt.role ||
    query.source !== receipt.source ||
    query.entityKey !== receipt.entityKey
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Receipt query provenance does not match its frozen Role Query.",
    );
  }

  const version = unique(
    database.resourceVersions,
    (candidate) =>
      candidate.sourceRevision === receipt.sourceRevision &&
      candidate.valueHash === receipt.valueHash,
    session.sessionId,
    database.snapshotRevision,
    "ResourceVersion",
  );
  if (sha256Digest(canonicalJson(version.value)) !== version.valueHash) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "ResourceVersion value hash is inconsistent.",
    );
  }
  const effectiveUntil = version.validUntilSeq ?? database.headSeq + 1;
  if (
    version.validFromSeq > receipt.observedAtSeq ||
    receipt.observedAtSeq >= effectiveUntil ||
    receipt.observedAtSeq > database.headSeq
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Receipt observation is outside its authoritative half-open interval.",
    );
  }
  return version;
}

function factSummary(
  role: Role,
  version: ResourceVersion,
  sourceRevision: number,
): string {
  if (isRecord(version.value)) {
    if (
      role === "inventory" &&
      typeof version.value.availableUnits === "number" &&
      Number.isInteger(version.value.availableUnits)
    ) {
      return `Available units: ${version.value.availableUnits}.`;
    }
    if (
      role === "budget" &&
      typeof version.value.remainingBudgetCents === "number" &&
      Number.isInteger(version.value.remainingBudgetCents)
    ) {
      return `Remaining budget: ${version.value.remainingBudgetCents} cents.`;
    }
    if (role === "policy" && typeof version.value.permitted === "boolean") {
      return version.value.permitted
        ? "Policy permits this campaign."
        : "Policy does not permit this campaign.";
    }
  }
  return `${role} evidence at source revision ${sourceRevision}.`;
}

function resolveDecisionEvidenceById(
  database: EpochDatabase,
  session: EpochSession,
  role: Role,
  certificateId: string,
  allowedStatuses: readonly DependencyCertificate["status"][],
): ResolvedDecisionEvidence {
  const agentId = session.frozenAssignments[ROLE_ASSIGNMENT_KEYS[role]];
  const decision = unique(
    database.decisions,
    (candidate) => candidate.certificateId === certificateId,
    session.sessionId,
    database.snapshotRevision,
    "active Decision",
  );
  if (
    decision.sessionId !== session.sessionId ||
    decision.actionHash !== session.actionHash ||
    decision.agentId !== agentId ||
    decision.role !== role ||
    !allowedStatuses.includes(decision.status)
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Active Decision crosses a frozen Session binding.",
    );
  }
  const assignment = unique(
    database.runAssignments,
    (candidate) => candidate.assignmentId === decision.runAssignmentId,
    session.sessionId,
    database.snapshotRevision,
    "Decision Assignment",
  );
  if (
    assignment.sessionId !== session.sessionId ||
    assignment.actionHash !== session.actionHash ||
    assignment.agentId !== agentId ||
    assignment.role !== role ||
    assignment.boundRunId !== decision.runId ||
    assignment.status !== "CONSUMED" ||
    assignment.consumedByDecisionCertificateId !== decision.certificateId
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Decision Assignment is not uniquely consumed by its active Certificate.",
    );
  }
  const attempt = unique(
    database.attempts,
    (candidate) =>
      candidate.assignmentId === assignment.assignmentId &&
      candidate.runId === decision.runId,
    session.sessionId,
    database.snapshotRevision,
    "accepted Decision Attempt",
  );
  if (
    attempt.sessionId !== session.sessionId ||
    attempt.actionHash !== session.actionHash ||
    attempt.agentId !== agentId ||
    attempt.role !== role ||
    attempt.status !== "ACCEPTED"
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Active Decision is not backed by an accepted Attempt mirror.",
    );
  }
  const receiptId = decision.receiptIds[0];
  const receipt = unique(
    database.receipts,
    (candidate) => candidate.receiptId === receiptId,
    session.sessionId,
    database.snapshotRevision,
    "Decision Receipt",
  );
  if (
    receipt.sessionId !== session.sessionId ||
    receipt.actionHash !== session.actionHash ||
    receipt.agentId !== agentId ||
    receipt.role !== role ||
    receipt.source !== role ||
    receipt.runAssignmentId !== assignment.assignmentId ||
    assignment.receiptId !== receipt.receiptId ||
    assignment.queryHash !== receipt.queryHash
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Active Decision Receipt crosses a frozen binding.",
    );
  }
  const version = resolveReceiptVersion(database, session, receipt);
  return { role, agentId, decision, assignment, attempt, receipt, version };
}

function resolveDecisionEvidence(
  database: EpochDatabase,
  session: EpochSession,
  role: Role,
): ResolvedDecisionEvidence | null {
  const certificateId = session.activeDecisionCertificateIds[role];
  return certificateId === null
    ? null
    : resolveDecisionEvidenceById(database, session, role, certificateId, [
        "ACTIVE",
      ]);
}

function resolveInFlightAttempt(
  database: EpochDatabase,
  session: EpochSession,
  role: Role,
  activeDecision: ResolvedDecisionEvidence | null,
): ResolvedInFlightAttempt | null {
  const attemptId = session.activeAttemptIds[role];
  if (attemptId === null) return null;
  const agentId = session.frozenAssignments[ROLE_ASSIGNMENT_KEYS[role]];
  const attempt = unique(
    database.attempts,
    (candidate) => candidate.attemptId === attemptId,
    session.sessionId,
    database.snapshotRevision,
    "active Attempt",
  );
  const assignment = unique(
    database.runAssignments,
    (candidate) => candidate.assignmentId === attempt.assignmentId,
    session.sessionId,
    database.snapshotRevision,
    "active Attempt Assignment",
  );
  const attemptStatus = attempt.status;
  if (attemptStatus === "ACCEPTED") {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "An accepted Attempt must be represented only by activeDecision.",
    );
  }
  if (
    attempt.sessionId !== session.sessionId ||
    attempt.actionHash !== session.actionHash ||
    attempt.agentId !== agentId ||
    attempt.role !== role ||
    assignment.sessionId !== session.sessionId ||
    assignment.actionHash !== session.actionHash ||
    assignment.agentId !== agentId ||
    assignment.role !== role ||
    assignment.boundRunId !== attempt.runId
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Active Attempt crosses a frozen Session/Assignment binding.",
    );
  }
  const terminalRejected = ["FAILED", "INTERRUPTED", "OUTPUT_REJECTED"].includes(
    attemptStatus,
  );
  const assignmentStateValid =
    assignment.consumedByDecisionCertificateId === null &&
    assignment.consumedAt === null &&
    (attempt.runId === null
      ? assignment.status === "CREATED" || assignment.status === "REJECTED"
      : terminalRejected
        ? assignment.status === "BOUND" || assignment.status === "REJECTED"
        : assignment.status === "BOUND");
  if (!assignmentStateValid) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Active Attempt Assignment lifecycle is not pre-consumption evidence.",
    );
  }
  if (
    activeDecision !== null &&
    (activeDecision.assignment.assignmentId === assignment.assignmentId ||
      (attempt.runId !== null && activeDecision.decision.runId === attempt.runId))
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "In-flight Attempt must not reuse the active Decision Run or Assignment.",
    );
  }
  return { attempt: { ...attempt, status: attemptStatus }, assignment };
}

function assignedAgentName(
  database: EpochDatabase,
  session: EpochSession,
  role: Role,
  decision: ResolvedDecisionEvidence | null,
  inFlight: ResolvedInFlightAttempt | null,
): string {
  const agentId = session.frozenAssignments[ROLE_ASSIGNMENT_KEYS[role]];
  const rawName =
    decision?.assignment.agentNameAtAssignment ??
    inFlight?.assignment.agentNameAtAssignment ??
    unique(
      database.roleAgentRegistrations,
      (registration) =>
        registration.role === role && registration.agentId === agentId,
      session.sessionId,
      database.snapshotRevision,
      "Role registration",
    ).agentNameAtRegistration;
  return sanitizeDisplayText(rawName, `${role} Agent`);
}

function receiptCoversHead(
  receipt: ActiveDecisionView["receipt"],
  head: number,
): boolean {
  return (
    receipt.validFromSeq <= head &&
    (receipt.validUntilSeq === null || head < receipt.validUntilSeq)
  );
}

function buildAgents(
  database: EpochDatabase,
  session: EpochSession,
): { agents: AgentView[]; evidence: Map<Role, ResolvedDecisionEvidence> } {
  const evidence = new Map<Role, ResolvedDecisionEvidence>();
  const runCounts = new Map<Role, number>();
  for (const role of ROLES) {
    const agentId = session.frozenAssignments[ROLE_ASSIGNMENT_KEYS[role]];
    runCounts.set(
      role,
      database.attempts.filter(
        (attempt) =>
          attempt.sessionId === session.sessionId &&
          attempt.actionHash === session.actionHash &&
          attempt.role === role &&
          attempt.agentId === agentId,
      ).length,
    );
  }
  const anyReobserved = [...runCounts.values()].some((count) => count > 1);

  const agents = ROLES.map((role): AgentView => {
    const agentId = session.frozenAssignments[ROLE_ASSIGNMENT_KEYS[role]];
    const decision = resolveDecisionEvidence(database, session, role);
    if (decision !== null) evidence.set(role, decision);
    const inFlight = resolveInFlightAttempt(
      database,
      session,
      role,
      decision,
    );
    const runCount = runCounts.get(role) ?? 0;
    const activeDecision: ActiveDecisionView | null =
      decision === null
        ? null
        : (() => {
            const receipt = {
              receiptId: decision.receipt.receiptId,
              sourceRevision: decision.receipt.sourceRevision,
              observedAtSeq: decision.receipt.observedAtSeq,
              validFromSeq: decision.version.validFromSeq,
              validUntilSeq: decision.version.validUntilSeq,
            };
            const coversHead = receiptCoversHead(receipt, database.headSeq);
            const evidenceState: ActiveDecisionView["evidenceState"] =
              !coversHead
                ? "INVALID_AT_HEAD"
                : anyReobserved && runCount === 1
                  ? "RETAINED"
                  : "CURRENT";
            return {
              certificateId: decision.decision.certificateId,
              runId: decision.decision.runId,
              verdict: decision.decision.verdict,
              factSummary: factSummary(
                role,
                decision.version,
                decision.receipt.sourceRevision,
              ),
              evidenceState,
              receipt,
              runtimeProof: {
                assignmentId: decision.assignment.assignmentId,
                threadId: sanitizeThreadId(decision.attempt.threadId),
                runtimeLabel: sanitizeDisplayText(
                  decision.assignment.runtimeLabelAtDispatch,
                  "redacted-runtime",
                ),
                roleProfileVersion: sanitizeOpaqueDisplayId(
                  decision.assignment.roleProfileVersion,
                  "redacted-role-profile",
                ),
                promptTemplateVersion: sanitizeOpaqueDisplayId(
                  decision.assignment.promptTemplateVersion,
                  "redacted-prompt-template",
                ),
                agentsMdDigest: decision.assignment.agentsMdDigest,
                evidencePackRelativePath:
                  decision.assignment.evidencePackRelativePath,
                evidencePackHash: decision.assignment.evidencePackHash,
                runStartedAt: decision.attempt.runStartedAt,
                runCompletedAt: decision.attempt.runCompletedAt,
                outputDigest: decision.attempt.outputDigest,
                usage: decision.attempt.usage,
              },
            };
          })();
    const inFlightAttempt: InFlightAttemptView | null =
      inFlight === null
        ? null
        : {
            attemptId: inFlight.attempt.attemptId,
            assignmentId: inFlight.assignment.assignmentId,
            runId: inFlight.attempt.runId,
            status: inFlight.attempt.status,
            runStartedAt: inFlight.attempt.runStartedAt,
            runCompletedAt: inFlight.attempt.runCompletedAt,
          };
    return {
      role,
      agentId,
      agentNameAtAssignment: assignedAgentName(
        database,
        session,
        role,
        decision,
        inFlight,
      ),
      runCount,
      activeDecision,
      inFlightAttempt,
    };
  });
  return { agents, evidence };
}

function activeDecisionIds(session: EpochSession): string[] {
  return ROLES.flatMap((role) => {
    const id = session.activeDecisionCertificateIds[role];
    return id === null ? [] : [id];
  });
}

function computeBounds(
  agents: readonly AgentView[],
  head: number,
): { lower: number; upper: number } | null {
  const receipts = agents.flatMap((agent) =>
    agent.activeDecision === null ? [] : [agent.activeDecision.receipt],
  );
  if (receipts.length !== 3) return null;
  return {
    lower: Math.max(...receipts.map((receipt) => receipt.validFromSeq)),
    upper: Math.min(
      ...receipts.map((receipt) => receipt.validUntilSeq ?? head + 1),
    ),
  };
}

function resolveActiveValidation(
  database: EpochDatabase,
  session: EpochSession,
): ValidationRecord | null {
  if (session.activeValidationId === null) return null;
  const validation = unique(
    database.validations,
    (candidate) => candidate.validationId === session.activeValidationId,
    session.sessionId,
    database.snapshotRevision,
    "active Validation",
  );
  if (
    validation.sessionId !== session.sessionId ||
    validation.actionHash !== session.actionHash ||
    validation.validatedHead > database.headSeq
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Active Validation crosses a frozen Session or future head.",
    );
  }
  if (
    (validation.outcome === "VALID_CURRENT_ALLOW" ||
      validation.outcome === "CONSISTENT_DENY") &&
    validation.jointValidityCertificateId === null
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Current-valid Validation requires a Joint Validity Certificate.",
    );
  }
  return validation;
}

function pendingJointValidity(): JointValidityView {
  return {
    state: "PENDING",
    lowerBound: null,
    upperBound: null,
    currentHeadCovered: null,
    noCutProof: null,
  };
}

function buildJointValidity(
  database: EpochDatabase,
  session: EpochSession,
  agents: AgentView[],
  validation: ValidationRecord | null,
): JointValidityView {
  if (validation === null) return pendingJointValidity();
  const ids = activeDecisionIds(session);
  const validationMatchesActive =
    ids.length === 3 && sameIds(validation.decisionCertificateIds, ids);
  if (
    session.state === "CREATED" ||
    session.state === "DISPATCHING" ||
    session.state === "VALIDATING" ||
    session.state === "COMMIT_RACE" ||
    session.state === "UNSTABLE_WORLD" ||
    (session.state === "COLLECTING" && !validationMatchesActive)
  ) {
    return pendingJointValidity();
  }
  if (!validationMatchesActive) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Active Validation does not bind the active Decision tuple.",
    );
  }
  const receipts = agents.flatMap((agent) =>
    agent.activeDecision === null ? [] : [agent.activeDecision.receipt],
  );
  const bounds = computeBounds(agents, database.headSeq);
  if (bounds === null || receipts.length !== 3) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Validated projection requires exactly three active Receipt intervals.",
    );
  }
  const dependencySetHash = snapshotReceiptDependencySetHash(
    receipts.map((receipt) => receipt.receiptId),
  );
  if (
    validation.dependencySetHash !== dependencySetHash ||
    validation.lowerBound !== bounds.lower ||
    validation.upperBound !== bounds.upper ||
    validation.validatedHead !== database.headSeq
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Validation bounds, dependency set, or current-head fence are stale.",
    );
  }

  if (validation.outcome === "NO_VALID_OBSERVED_WORLD_CUT") {
    if (
      bounds.lower < bounds.upper ||
      validation.noCutProofId === null ||
      validation.jointValidityCertificateId !== null
    ) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "No-Cut Validation does not carry a closed conflict proof.",
      );
    }
    const proof = unique(
      database.noCutProofs,
      (candidate) => candidate.proofId === validation.noCutProofId,
      session.sessionId,
      database.snapshotRevision,
      "No-Cut Proof",
    );
    const entries = agents.flatMap((agent) =>
      agent.activeDecision === null
        ? []
        : [{ role: agent.role, receipt: agent.activeDecision.receipt }],
    );
    const compareIds = (left: string, right: string): number =>
      left < right ? -1 : left > right ? 1 : 0;
    const earliestEnding = entries
      .filter(
        (entry) =>
          (entry.receipt.validUntilSeq ?? database.headSeq + 1) ===
          bounds.upper,
      )
      .sort((left, right) =>
        compareIds(left.receipt.receiptId, right.receipt.receiptId),
      )[0];
    const latestStarting = entries
      .filter((entry) => entry.receipt.validFromSeq === bounds.lower)
      .sort((left, right) =>
        compareIds(left.receipt.receiptId, right.receipt.receiptId),
      )[0];
    if (earliestEnding === undefined || latestStarting === undefined) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "Canonical conflict witness endpoints are missing.",
      );
    }
    const invalidAgentIds = agents
      .filter(
        (agent) =>
          agent.activeDecision !== null &&
          !receiptCoversHead(agent.activeDecision.receipt, database.headSeq),
      )
      .map((agent) => agent.agentId);
    if (
      proof.validationId !== validation.validationId ||
      proof.sessionId !== session.sessionId ||
      proof.actionHash !== session.actionHash ||
      proof.dependencySetHash !== dependencySetHash ||
      !sameIds(proof.decisionCertificateIds, ids) ||
      proof.validatedAtHead !== database.headSeq ||
      proof.lowerBound !== bounds.lower ||
      proof.upperBound !== bounds.upper ||
      proof.earliestEndingReceiptId !== earliestEnding.receipt.receiptId ||
      proof.latestStartingReceiptId !== latestStarting.receipt.receiptId ||
      !sameIds(proof.conflictWitnessReceiptIds, [
        earliestEnding.receipt.receiptId,
        latestStarting.receipt.receiptId,
      ]) ||
      !sameIdSet(proof.refreshAgentIds, invalidAgentIds)
    ) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "Stored No-Cut Proof does not match the canonical server-derived witness.",
      );
    }
    return {
      state: "NO_CUT",
      lowerBound: bounds.lower,
      upperBound: bounds.upper,
      currentHeadCovered: false,
      noCutProof: {
        proofId: proof.proofId,
        dependencySetHash,
        lowerBound: bounds.lower,
        upperBound: bounds.upper,
        witness: [
          {
            role: earliestEnding.role,
            receiptId: earliestEnding.receipt.receiptId,
            from: earliestEnding.receipt.validFromSeq,
            until: earliestEnding.receipt.validUntilSeq,
          },
          {
            role: latestStarting.role,
            receiptId: latestStarting.receipt.receiptId,
            from: latestStarting.receipt.validFromSeq,
            until: latestStarting.receipt.validUntilSeq,
          },
        ],
      },
    };
  }

  if (validation.outcome === "HISTORICAL_BUT_STALE_NOW") {
    const currentCovered =
      bounds.lower <= database.headSeq && database.headSeq < bounds.upper;
    if (
      bounds.lower >= bounds.upper ||
      currentCovered ||
      validation.noCutProofId !== null ||
      validation.jointValidityCertificateId !== null
    ) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "Historical-stale Validation does not describe a coherent past cut.",
      );
    }
    return {
      state: "HISTORICAL_STALE",
      lowerBound: bounds.lower,
      upperBound: bounds.upper,
      currentHeadCovered: false,
      noCutProof: null,
    };
  }

  if (
    validation.outcome === "VALID_CURRENT_ALLOW" ||
    validation.outcome === "CONSISTENT_DENY"
  ) {
    const currentCovered =
      bounds.lower < bounds.upper &&
      bounds.lower <= database.headSeq &&
      database.headSeq < bounds.upper &&
      agents.every(
        (agent) =>
          agent.activeDecision !== null &&
          receiptCoversHead(agent.activeDecision.receipt, database.headSeq),
      );
    const verdicts = agents.flatMap((agent) =>
      agent.activeDecision === null ? [] : [agent.activeDecision.verdict],
    );
    if (
      !currentCovered ||
      validation.noCutProofId !== null ||
      (validation.outcome === "VALID_CURRENT_ALLOW" &&
        !verdicts.every((verdict) => verdict === "ALLOW")) ||
      (validation.outcome === "CONSISTENT_DENY" &&
        !verdicts.includes("DENY"))
    ) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "Current Validation does not match active evidence and Verdicts.",
      );
    }
    if (validation.jointValidityCertificateId !== null) {
      const certificate = unique(
        database.jointValidityCertificates,
        (candidate) =>
          candidate.certificateId === validation.jointValidityCertificateId,
        session.sessionId,
        database.snapshotRevision,
        "Joint Validity Certificate",
      );
      const intervalsByReceipt = new Map(
        certificate.intervals.map((interval) => [interval.receiptId, interval]),
      );
      if (
        certificate.validationId !== validation.validationId ||
        certificate.sessionId !== session.sessionId ||
        certificate.actionHash !== session.actionHash ||
        certificate.dependencySetHash !== dependencySetHash ||
        certificate.validatedAtHead !== database.headSeq ||
        certificate.selectedCutSeq !== database.headSeq ||
        certificate.currentHeadCovered !== true ||
        !sameIds(certificate.decisionCertificateIds, ids) ||
        agents.some((agent) => {
          const receipt = agent.activeDecision?.receipt;
          const interval =
            receipt === undefined
              ? undefined
              : intervalsByReceipt.get(receipt.receiptId);
          return (
            receipt === undefined ||
            interval === undefined ||
            interval.source !== agent.role ||
            interval.sourceRevision !== receipt.sourceRevision ||
            interval.from !== receipt.validFromSeq ||
            interval.until !== receipt.validUntilSeq
          );
        })
      ) {
        projectionFailure(
          session.sessionId,
          database.snapshotRevision,
          "Joint Validity Certificate does not match active evidence.",
        );
      }
    }
    return {
      state: "VALID_CURRENT",
      lowerBound: bounds.lower,
      upperBound: bounds.upper,
      currentHeadCovered: true,
      noCutProof: null,
    };
  }
  return pendingJointValidity();
}

function decisionEvidenceForIds(
  database: EpochDatabase,
  session: EpochSession,
  decisionIds: readonly string[],
): ResolvedDecisionEvidence[] {
  return ROLES.map((role, index) => {
    const decisionId = decisionIds[index];
    if (decisionId === undefined) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "Refresh origin is missing a Role Decision.",
      );
    }
    return resolveDecisionEvidenceById(database, session, role, decisionId, [
      "ACTIVE",
      "SUPERSEDED",
    ]);
  });
}

function buildRefreshPlan(
  database: EpochDatabase,
  session: EpochSession,
  agents: AgentView[],
): RefreshPlanView | null {
  if (session.activeRefreshPlanId === null) return null;
  const plan = unique(
    database.refreshPlans,
    (candidate) => candidate.refreshPlanId === session.activeRefreshPlanId,
    session.sessionId,
    database.snapshotRevision,
    "active RefreshPlan",
  );
  if (plan.sessionId !== session.sessionId || plan.status === "INVALIDATED") {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Active RefreshPlan is invalidated or crosses a Session boundary.",
    );
  }
  const originValidation = unique(
    database.validations,
    (validation) =>
      validation.refreshPlanId === plan.refreshPlanId &&
      (validation.outcome === "NO_VALID_OBSERVED_WORLD_CUT" ||
        validation.outcome === "HISTORICAL_BUT_STALE_NOW"),
    session.sessionId,
    database.snapshotRevision,
    "RefreshPlan origin Validation",
  );
  if (
    originValidation.sessionId !== session.sessionId ||
    originValidation.actionHash !== session.actionHash ||
    plan.baseSessionRevision !== originValidation.baseSessionRevision ||
    plan.validatedHead !== originValidation.validatedHead ||
    plan.dependencySetHash !== originValidation.dependencySetHash ||
    !sameIds(
      plan.activeDecisionCertificateIds,
      originValidation.decisionCertificateIds,
    )
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "RefreshPlan does not bind its origin Validation.",
    );
  }
  const originEvidence = decisionEvidenceForIds(
    database,
    session,
    originValidation.decisionCertificateIds,
  );
  const invalidOwnerIds = originEvidence
    .filter(
      (evidence) =>
        evidence.version.validFromSeq > plan.validatedHead ||
        (evidence.version.validUntilSeq !== null &&
          plan.validatedHead >= evidence.version.validUntilSeq),
    )
    .map((evidence) => evidence.agentId);
  if (!sameIdSet(plan.agentIds, invalidOwnerIds)) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "RefreshPlan owners are not the server-derived invalid evidence owners.",
    );
  }
  if (plan.status === "CLAIMED") {
    if (plan.claimedAttemptId === null) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "Claimed RefreshPlan is missing its owner Attempt.",
      );
    }
    const claimedAttempt = unique(
      database.attempts,
      (attempt) => attempt.attemptId === plan.claimedAttemptId,
      session.sessionId,
      database.snapshotRevision,
      "claimed RefreshPlan Attempt",
    );
    const expectedAgentId =
      session.frozenAssignments[ROLE_ASSIGNMENT_KEYS[claimedAttempt.role]];
    const projectedOwner = agents.find(
      (agent) =>
        agent.role === claimedAttempt.role &&
        agent.agentId === claimedAttempt.agentId,
    );
    if (
      claimedAttempt.sessionId !== session.sessionId ||
      claimedAttempt.actionHash !== session.actionHash ||
      claimedAttempt.agentId !== expectedAgentId ||
      claimedAttempt.status === "ACCEPTED" ||
      !plan.agentIds.includes(claimedAttempt.agentId) ||
      session.activeAttemptIds[claimedAttempt.role] !==
        claimedAttempt.attemptId ||
      projectedOwner?.inFlightAttempt?.attemptId !== claimedAttempt.attemptId
    ) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "Claimed RefreshPlan Attempt is not the active in-flight owner Attempt.",
      );
    }
  } else if (plan.status === "AVAILABLE" && plan.claimedAttemptId !== null) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Available RefreshPlan cannot already claim an Attempt.",
    );
  }
  const orderedOwners = agents
    .filter((agent) => invalidOwnerIds.includes(agent.agentId))
    .map((agent) => agent.agentId);
  return {
    refreshPlanId: plan.refreshPlanId,
    status: plan.status,
    agentIds: orderedOwners,
    reasonCode:
      originValidation.outcome === "NO_VALID_OBSERVED_WORLD_CUT"
        ? "NO_VALID_OBSERVED_WORLD_CUT"
        : "HISTORICAL_BUT_STALE_NOW",
  };
}

function activePermit(
  database: EpochDatabase,
  session: EpochSession,
): EpochDatabase["permits"][number] | null {
  if (session.activePermitId === null) return null;
  const permit = unique(
    database.permits,
    (candidate) => candidate.permitId === session.activePermitId,
    session.sessionId,
    database.snapshotRevision,
    "active Permit",
  );
  if (
    permit.sessionId !== session.sessionId ||
    permit.actionHash !== session.actionHash
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Active Permit crosses a frozen Session binding.",
    );
  }
  return permit;
}

function assertEffectLedgerClosure(
  database: EpochDatabase,
  session: EpochSession,
): void {
  const sessionPermits = database.permits.filter(
    (permit) => permit.sessionId === session.sessionId,
  );
  const sessionEffects = database.effects.filter(
    (effect) => effect.sessionId === session.sessionId,
  );
  for (const permit of sessionPermits) {
    const linkedEffects = database.effects.filter(
      (effect) => effect.permitId === permit.permitId,
    );
    const consumed = permit.status === "CONSUMED";
    const effect = linkedEffects[0] ?? null;
    if (
      permit.actionHash !== session.actionHash ||
      permit.idempotencyKey !== session.action.idempotencyKey ||
      consumed !== (permit.consumedAt !== null) ||
      linkedEffects.length !== (consumed ? 1 : 0) ||
      (permit.consumedAt !== null &&
        Date.parse(permit.consumedAt) < Date.parse(permit.issuedAt)) ||
      (effect !== null &&
        (permit.consumedAt === null ||
          effect.sessionId !== session.sessionId ||
          effect.actionHash !== session.actionHash ||
          effect.idempotencyKey !== session.action.idempotencyKey ||
          effect.idempotencyKey !== permit.idempotencyKey ||
          effect.dependencySetHash !== permit.dependencySetHash ||
          effect.jointValidityCertificateId !==
            permit.jointValidityCertificateId ||
          effect.createdAt !== permit.consumedAt))
    ) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "Effect ledger contains a Permit without an exact atomic consumption closure.",
      );
    }
  }
  if (
    sessionEffects.some(
      (effect) =>
        sessionPermits.filter((permit) => permit.permitId === effect.permitId)
          .length !== 1,
    )
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Effect ledger contains an Effect outside the Session's Permit chain.",
    );
  }
}

function buildGate(
  context: ProjectionContext,
  latestReason: SessionDashboardSnapshot["gate"]["reasonCode"],
): SessionDashboardSnapshot["gate"] {
  const { database, session, jointValidity } = context;
  assertEffectLedgerClosure(database, session);
  const permit = activePermit(database, session);
  const effects = database.effects.filter(
    (effect) => effect.sessionId === session.sessionId,
  );
  if (effects.length > 1) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "A Session cannot project more than one Effect.",
    );
  }
  const effect = effects[0] ?? null;
  const permitAllowed = [
    "READY_AT_CURRENT_HEAD",
    "COMMITTING",
    "COMMITTED",
  ].includes(session.state);
  if (permitAllowed && permit === null) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Ready/commit projection is missing its active Permit.",
    );
  }
  if (permit !== null && permitAllowed) {
    const permitEffects = database.effects.filter(
      (candidate) => candidate.permitId === permit.permitId,
    );
    const idempotentEffects = database.effects.filter(
      (candidate) =>
        candidate.idempotencyKey === session.action.idempotencyKey,
    );
    const consumed = permit.status === "CONSUMED";
    if (
      permit.validatedHead !== database.headSeq ||
      permit.status !== (session.state === "COMMITTED" ? "CONSUMED" : "ISSUED") ||
      permit.idempotencyKey !== session.action.idempotencyKey ||
      consumed !== (permit.consumedAt !== null) ||
      (permit.consumedAt !== null &&
        Date.parse(permit.consumedAt) < Date.parse(permit.issuedAt)) ||
      permitEffects.length !== (session.state === "COMMITTED" ? 1 : 0) ||
      idempotentEffects.length !== (session.state === "COMMITTED" ? 1 : 0) ||
      context.activeValidation?.jointValidityCertificateId !==
        permit.jointValidityCertificateId ||
      context.activeValidation?.dependencySetHash !== permit.dependencySetHash
    ) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "Permit does not match current Validation or lifecycle state.",
      );
    }
  }
  if (session.state === "COMMITTED") {
    if (
      effect === null ||
      permit === null ||
      permit.consumedAt === null ||
      effect.permitId !== permit.permitId ||
      effect.sessionId !== session.sessionId ||
      effect.actionHash !== session.actionHash ||
      effect.idempotencyKey !== session.action.idempotencyKey ||
      effect.idempotencyKey !== permit.idempotencyKey ||
      effect.dependencySetHash !== permit.dependencySetHash ||
      effect.jointValidityCertificateId !== permit.jointValidityCertificateId ||
      effect.createdAt !== permit.consumedAt
    ) {
      projectionFailure(
        session.sessionId,
        database.snapshotRevision,
        "Committed Session is missing its unique Permit-bound Effect.",
      );
    }
  } else if (effect !== null) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Non-committed Session cannot project an Effect.",
    );
  }

  const gateByState: Record<
    EpochSession["state"],
    { state: SessionDashboardSnapshot["gate"]["state"]; reasonCode: SessionDashboardSnapshot["gate"]["reasonCode"] }
  > = {
    CREATED: { state: "WAITING", reasonCode: null },
    DISPATCHING: { state: "WAITING", reasonCode: null },
    COLLECTING: { state: "WAITING", reasonCode: null },
    VALIDATING: { state: "CHECKING", reasonCode: null },
    BLOCKED_NO_CUT: {
      state: "LOCKED",
      reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
    },
    HISTORICAL_STALE: {
      state: "LOCKED",
      reasonCode: "HISTORICAL_BUT_STALE_NOW",
    },
    REOBSERVING: {
      state: "LOCKED",
      reasonCode:
        jointValidity.state === "HISTORICAL_STALE"
          ? "HISTORICAL_BUT_STALE_NOW"
          : "NO_VALID_OBSERVED_WORLD_CUT",
    },
    UNSTABLE_WORLD: { state: "LOCKED", reasonCode: "UNSTABLE_WORLD" },
    CONSISTENT_DENY: { state: "LOCKED", reasonCode: "CONSISTENT_DENY" },
    READY_AT_CURRENT_HEAD: { state: "READY", reasonCode: null },
    COMMITTING: { state: "CHECKING", reasonCode: null },
    COMMITTED: { state: "RELEASED", reasonCode: null },
    COMMIT_RACE: { state: "LOCKED", reasonCode: "COMMIT_RACE" },
    FAILED: { state: "FAILED", reasonCode: latestReason },
    INTERRUPTED: { state: "FAILED", reasonCode: latestReason },
  };
  const derived = gateByState[session.state];
  if (
    (session.state === "FAILED" || session.state === "INTERRUPTED") &&
    derived.reasonCode === null
  ) {
    projectionFailure(
      session.sessionId,
      database.snapshotRevision,
      "Failed/Interrupted Session requires a structured Diagnostic reason.",
    );
  }
  return {
    state: derived.state,
    reasonCode: derived.reasonCode,
    effectsInSession: effects.length,
    permitId: permitAllowed ? (permit?.permitId ?? null) : null,
    effectId: effect?.effectId ?? null,
  };
}

function buildEvents(
  database: EpochDatabase,
  session: EpochSession,
): SessionDashboardSnapshot["events"] {
  return database.auditEvents
    .filter(
      (event) =>
        event.sessionId === session.sessionId &&
        event.actionHash === session.actionHash,
    )
    .sort(
      (left, right) =>
        left.auditSeq - right.auditSeq ||
        (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0),
    )
    .slice(-6)
    .map((event) => {
      const type = sanitizeEventToken(event.type, "EVENT");
      const status = sanitizeEventToken(event.status, "REDACTED");
      return {
        eventId: event.eventId,
        sequence: event.auditSeq,
        type,
        status,
        role: event.role,
        summary: `${event.role === null ? "Session" : event.role}: ${type} ${status}`,
        createdAt: event.createdAt,
      };
    });
}

function availableActions(
  session: EpochSession,
  refreshPlan: RefreshPlanView | null,
): SessionDashboardSnapshot["availableActions"] {
  if (
    (session.state === "BLOCKED_NO_CUT" ||
      session.state === "HISTORICAL_STALE") &&
    refreshPlan?.status === "AVAILABLE"
  ) {
    return ["REOBSERVE_INVALID"];
  }
  if (session.state === "READY_AT_CURRENT_HEAD") return ["COMMIT"];
  return [];
}

function projectSessionDashboardSnapshot(
  database: EpochDatabase,
  sessionId: string,
  generatedAt: string,
): SessionDashboardSnapshot {
  const sessionMatches = database.sessions.filter(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (sessionMatches.length === 0) {
    throw new SessionViewBuilderError(
      "SESSION_NOT_FOUND",
      sessionId,
      database.snapshotRevision,
      "EpochGuard Session was not found in the captured snapshot.",
    );
  }
  if (sessionMatches.length !== 1 || sessionMatches[0] === undefined) {
    projectionFailure(
      sessionId,
      database.snapshotRevision,
      "EpochGuard Session identity is not unique.",
    );
  }
  const session = sessionMatches[0];
  if (
    session.actionHash !== session.action.actionHash ||
    session.action.sessionId !== session.sessionId ||
    new Set(Object.values(session.frozenAssignments)).size !== 3
  ) {
    projectionFailure(
      sessionId,
      database.snapshotRevision,
      "Session Action or frozen Agent assignment is inconsistent.",
    );
  }

  const { agents } = buildAgents(database, session);
  const activeValidation = resolveActiveValidation(database, session);
  const jointValidity = buildJointValidity(
    database,
    session,
    agents,
    activeValidation,
  );
  const refreshPlan = buildRefreshPlan(database, session, agents);
  let latestDiagnostics: SessionDashboardSnapshot["latestDiagnostics"];
  try {
    latestDiagnostics = latestSafetyDiagnosticViews(database, sessionId);
  } catch (error) {
    if (error instanceof SafetyDiagnosticIntegrityError) {
      projectionFailure(
        sessionId,
        database.snapshotRevision,
        "SafetyDiagnostic graph failed closed reconciliation.",
      );
    }
    throw error;
  }
  const context: ProjectionContext = {
    database,
    session,
    agents,
    activeValidation,
    jointValidity,
    refreshPlan,
  };
  const gate = buildGate(
    context,
    latestDiagnostics[0]?.reasonCode ?? null,
  );
  const activeDecisions = agents.flatMap((agent) =>
    agent.activeDecision === null ? [] : [agent.activeDecision],
  );
  const reobservedAgents = agents.filter((agent) => agent.runCount > 1).length;
  const candidate = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    contractDigest: CONTRACT_DIGEST,
    snapshotRevision: database.snapshotRevision,
    sessionRevision: session.sessionRevision,
    stateUpdatedAt: session.stateUpdatedAt,
    generatedAt,
    sessionId: session.sessionId,
    scenarioId: session.scenarioId,
    coordinationMode: session.coordinationMode,
    sessionState: session.state,
    action: {
      type: session.action.type,
      campaignId: session.action.campaignId,
      requestedUnits: session.action.requestedUnits,
      estimatedCostCents: session.action.estimatedCostCents,
      market: session.action.market,
    },
    actionHash: session.actionHash,
    worldHead: database.headSeq,
    gate,
    metrics: {
      activeDecisions: activeDecisions.length,
      requiredDecisions: 3,
      allowDecisions: activeDecisions.filter(
        (decision) => decision.verdict === "ALLOW",
      ).length,
      denyDecisions: activeDecisions.filter(
        (decision) => decision.verdict === "DENY",
      ).length,
      reobservedAgents,
      totalAgents: 3,
      rerunsAvoided:
        refreshPlan === null ? 0 : 3 - refreshPlan.agentIds.length,
      verificationLatencyMs: activeValidation?.verificationLatencyMs ?? null,
    },
    agents,
    jointValidity,
    refreshPlan,
    availableActions: availableActions(session, refreshPlan),
    latestDiagnostics,
    events: buildEvents(database, session),
  };

  let decoded: SessionDashboardSnapshot;
  try {
    decoded = decodeSessionDashboardSnapshot(candidate);
  } catch {
    projectionFailure(
      sessionId,
      database.snapshotRevision,
      "Dashboard candidate was rejected by the contract-v6 decoder.",
    );
  }
  assertSnapshotContainsNoSensitiveMaterial(decoded);
  return decoded;
}

export function buildSessionDashboardSnapshotFromSnapshot(
  input: unknown,
  sessionId: string,
  generatedAt: string = new Date().toISOString(),
): SessionDashboardSnapshot {
  const databaseClone = parseDatabase(input, sessionId);
  return projectSessionDashboardSnapshot(databaseClone, sessionId, generatedAt);
}

export class SessionViewBuilder {
  constructor(
    private readonly store: EpochStoreSnapshotPort,
    private readonly clock: SessionViewClock = () => new Date().toISOString(),
  ) {}

  build(sessionId: string): SessionDashboardSnapshot {
    // The complete request performs one Store read. Contract parsing immediately
    // deep-clones that result before any other injected collaborator can run.
    const capturedSnapshot = this.store.snapshot();
    const databaseClone = parseDatabase(capturedSnapshot, sessionId);
    return projectSessionDashboardSnapshot(
      databaseClone,
      sessionId,
      this.clock(),
    );
  }
}
