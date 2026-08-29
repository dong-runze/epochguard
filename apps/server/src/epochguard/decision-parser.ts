import { randomUUID } from "node:crypto";
import {
  AgentDecisionEnvelopeSchema,
  DependencyCertificateSchema,
  actionHash,
  buildRoleQuerySpec,
  canonicalJson,
  sha256Digest,
  type AgentAttempt,
  type AgentDecisionEnvelope,
  type DependencyCertificate,
  type EpochDatabase,
  type EpochSession,
  type FailureCode,
  type ObservationReceipt,
  type Role,
  type RunAssignment,
} from "./types.js";

export const EPOCH_DECISION_OPEN_MARKER = "<EPOCH_DECISION>" as const;
export const EPOCH_DECISION_CLOSE_MARKER = "</EPOCH_DECISION>" as const;
export const MAX_DECISION_OUTPUT_BYTES = 16 * 1_024;

export class DecisionNormalizationError extends Error {
  constructor(
    public readonly reasonCode: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = "DecisionNormalizationError";
  }
}

export type DecisionNormalizationOptions = {
  certificateId?: string;
  createdAt?: string;
};

export type BoundDecision = {
  decision: DependencyCertificate;
  assignment: RunAssignment;
  attempt: AgentAttempt;
  receipt: ObservationReceipt;
};

function fail(reasonCode: FailureCode, message: string): never {
  throw new DecisionNormalizationError(reasonCode, message);
}

function countLiteral(value: string, literal: string): number {
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = value.indexOf(literal, cursor);
    if (found === -1) return count;
    count += 1;
    cursor = found + literal.length;
  }
}

function requireUnique<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  label: string,
): T {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    fail("DECISION_INVALID", `${label} must resolve to exactly one record`);
  }
  return matches[0] as T;
}

function frozenAgentId(session: EpochSession, role: Role): string {
  switch (role) {
    case "inventory":
      return session.frozenAssignments.inventoryAgentId;
    case "budget":
      return session.frozenAssignments.budgetAgentId;
    case "policy":
      return session.frozenAssignments.policyAgentId;
  }
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  label: string,
  reasonCode: FailureCode = "BINDING_MISMATCH",
): void {
  if (actual !== expected) {
    fail(reasonCode, `${label} does not match the authoritative binding`);
  }
}

function assertCanonicalAction(session: EpochSession): void {
  const canonicalHash = actionHash(session.action);
  assertEqual(
    session.action.sessionId,
    session.sessionId,
    "Action Session",
  );
  assertEqual(
    session.action.actionHash,
    canonicalHash,
    "Action canonical hash",
    "ACTION_HASH_MISMATCH",
  );
  assertEqual(
    session.actionHash,
    canonicalHash,
    "Session Action hash",
    "ACTION_HASH_MISMATCH",
  );
  assertEqual(
    session.action.idempotencyKey,
    `${session.sessionId}:${canonicalHash}`,
    "Action idempotency key",
    "ACTION_HASH_MISMATCH",
  );
}

function assertRoleQueryBinding(
  database: Readonly<EpochDatabase>,
  session: EpochSession,
  assignment: RunAssignment,
  receipt: ObservationReceipt,
): void {
  const expectedSpec = buildRoleQuerySpec(session.action, assignment.role);
  assertEqual(
    assignment.queryHash,
    expectedSpec.queryHash,
    "Assignment query hash",
    "QUERY_HASH_MISMATCH",
  );
  assertEqual(
    receipt.queryHash,
    expectedSpec.queryHash,
    "Receipt query hash",
    "QUERY_HASH_MISMATCH",
  );
  assertEqual(receipt.source, expectedSpec.source, "Receipt source");
  assertEqual(receipt.entityKey, expectedSpec.entityKey, "Receipt entity key");

  const storedSpec = requireUnique(
    database.roleQuerySpecs,
    (candidate) =>
      candidate.actionHash === expectedSpec.actionHash &&
      candidate.role === expectedSpec.role,
    "Role Query Spec",
  );
  if (canonicalJson(storedSpec) !== canonicalJson(expectedSpec)) {
    fail(
      "QUERY_HASH_MISMATCH",
      "Stored Role Query Spec does not match the canonical Action projection",
    );
  }
}

function assertRegistrationBinding(
  database: Readonly<EpochDatabase>,
  session: EpochSession,
  assignment: RunAssignment,
): void {
  const registration = requireUnique(
    database.roleAgentRegistrations,
    (candidate) => candidate.role === assignment.role,
    "Role Agent Registration",
  );
  assertEqual(registration.agentId, assignment.agentId, "Registered Agent");
  assertEqual(
    registration.agentId,
    frozenAgentId(session, assignment.role),
    "Frozen Role Agent",
  );
  assertEqual(
    registration.roleProfileVersion,
    assignment.roleProfileVersion,
    "Role Profile version",
    "ROLE_PROFILE_MISMATCH",
  );
  assertEqual(
    registration.agentsMdDigest,
    assignment.agentsMdDigest,
    "Role Profile digest",
    "ROLE_PROFILE_MISMATCH",
  );
}

function assertAttemptAndAssignmentBinding(
  session: EpochSession,
  attempt: AgentAttempt,
  assignment: RunAssignment,
): void {
  assertEqual(attempt.assignmentId, assignment.assignmentId, "Attempt Assignment");
  assertEqual(attempt.sessionId, session.sessionId, "Attempt Session");
  assertEqual(attempt.actionHash, session.actionHash, "Attempt Action");
  assertEqual(attempt.agentId, assignment.agentId, "Attempt Agent");
  assertEqual(attempt.role, assignment.role, "Attempt Role");
  assertEqual(assignment.sessionId, session.sessionId, "Assignment Session");
  assertEqual(assignment.actionHash, session.actionHash, "Assignment Action");
  assertEqual(
    assignment.agentId,
    frozenAgentId(session, assignment.role),
    "Assignment frozen Agent",
  );
  assertEqual(assignment.boundRunId, attempt.runId, "Assignment Run");
  if (attempt.runId === null || assignment.boundRunId === null) {
    fail("DECISION_INVALID", "Decision requires an Assignment bound to a real Run");
  }
}

function assertReceiptBinding(
  assignment: RunAssignment,
  receipt: ObservationReceipt,
): void {
  assertEqual(receipt.receiptId, assignment.receiptId, "Assignment Receipt");
  assertEqual(
    receipt.runAssignmentId,
    assignment.assignmentId,
    "Receipt Assignment",
  );
  assertEqual(receipt.sessionId, assignment.sessionId, "Receipt Session");
  assertEqual(receipt.actionHash, assignment.actionHash, "Receipt Action");
  assertEqual(receipt.agentId, assignment.agentId, "Receipt Agent");
  assertEqual(receipt.role, assignment.role, "Receipt Role");
  assertEqual(receipt.source, assignment.role, "Receipt source Role");
}

export function parseDecisionEnvelope(rawOutput: string): AgentDecisionEnvelope {
  if (Buffer.byteLength(rawOutput, "utf8") > MAX_DECISION_OUTPUT_BYTES) {
    fail(
      "OUTPUT_MALFORMED",
      `Decision output exceeds ${MAX_DECISION_OUTPUT_BYTES} UTF-8 bytes`,
    );
  }

  if (
    countLiteral(rawOutput, EPOCH_DECISION_OPEN_MARKER) !== 1 ||
    countLiteral(rawOutput, EPOCH_DECISION_CLOSE_MARKER) !== 1
  ) {
    fail("OUTPUT_MALFORMED", "Decision output must contain exactly one marker envelope");
  }

  const trimmed = rawOutput.trim();
  if (
    !trimmed.startsWith(EPOCH_DECISION_OPEN_MARKER) ||
    !trimmed.endsWith(EPOCH_DECISION_CLOSE_MARKER)
  ) {
    fail(
      "OUTPUT_MALFORMED",
      "Decision envelope cannot have leading or trailing free text",
    );
  }

  const jsonText = trimmed
    .slice(
      EPOCH_DECISION_OPEN_MARKER.length,
      trimmed.length - EPOCH_DECISION_CLOSE_MARKER.length,
    )
    .trim();
  let candidate: unknown;
  try {
    candidate = JSON.parse(jsonText);
  } catch {
    fail("OUTPUT_MALFORMED", "Decision envelope contains invalid JSON");
  }

  const parsed = AgentDecisionEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    fail("OUTPUT_MALFORMED", "Decision envelope failed the strict contract schema");
  }
  return parsed.data;
}

export function resolveBoundDecision(
  database: Readonly<EpochDatabase>,
  session: EpochSession,
  decision: DependencyCertificate,
): BoundDecision {
  assertCanonicalAction(session);
  assertEqual(decision.sessionId, session.sessionId, "Decision Session");
  assertEqual(
    decision.actionHash,
    session.actionHash,
    "Decision Action",
    "ACTION_HASH_MISMATCH",
  );
  if (decision.status !== "ACTIVE") {
    fail("DECISION_INVALID", "Only an ACTIVE Decision can be validated");
  }
  if (decision.receiptIds.length !== 1) {
    fail("DECISION_INVALID", "Each Decision must bind exactly one Receipt");
  }

  const assignment = requireUnique(
    database.runAssignments,
    (candidate) => candidate.assignmentId === decision.runAssignmentId,
    "Decision Assignment",
  );
  const attempt = requireUnique(
    database.attempts,
    (candidate) => candidate.assignmentId === assignment.assignmentId,
    "Decision Attempt",
  );
  const receipt = requireUnique(
    database.receipts,
    (candidate) => candidate.receiptId === decision.receiptIds[0],
    "Decision Receipt",
  );

  if (
    assignment.status !== "CONSUMED" ||
    assignment.consumedByDecisionCertificateId !== decision.certificateId ||
    assignment.consumedAt === null
  ) {
    fail("DECISION_INVALID", "Decision Assignment was not consumed exactly once");
  }
  if (
    attempt.status !== "ACCEPTED" ||
    attempt.runId === null ||
    attempt.outputDigest === null
  ) {
    fail("DECISION_INVALID", "Decision does not have accepted terminal Run evidence");
  }

  assertAttemptAndAssignmentBinding(session, attempt, assignment);
  assertReceiptBinding(assignment, receipt);
  assertRegistrationBinding(database, session, assignment);
  assertRoleQueryBinding(database, session, assignment, receipt);
  assertEqual(decision.agentId, assignment.agentId, "Decision Agent");
  assertEqual(decision.role, assignment.role, "Decision Role");
  assertEqual(decision.runId, assignment.boundRunId, "Decision Run");
  assertEqual(decision.receiptIds[0], assignment.receiptId, "Decision Receipt");

  return { decision, assignment, attempt, receipt };
}

/**
 * This synchronous check-and-mutate operation must be invoked inside the caller's
 * single-writer EpochStore mutation. It never awaits, so Assignment consumption,
 * Decision creation, supersession, and active-pointer replacement form one CAS.
 */
export function normalizeAndConsumeDecision(
  database: EpochDatabase,
  attemptId: string,
  rawOutput: string,
  options: DecisionNormalizationOptions = {},
): DependencyCertificate {
  const envelope = parseDecisionEnvelope(rawOutput);
  const attempt = requireUnique(
    database.attempts,
    (candidate) => candidate.attemptId === attemptId,
    "Decision Attempt",
  );
  const assignment = requireUnique(
    database.runAssignments,
    (candidate) => candidate.assignmentId === attempt.assignmentId,
    "Decision Assignment",
  );
  const session = requireUnique(
    database.sessions,
    (candidate) => candidate.sessionId === assignment.sessionId,
    "Decision Session",
  );
  const receipt = requireUnique(
    database.receipts,
    (candidate) => candidate.receiptId === assignment.receiptId,
    "Decision Receipt",
  );

  assertCanonicalAction(session);
  if (
    assignment.status !== "BOUND" ||
    assignment.boundRunId === null ||
    assignment.consumedByDecisionCertificateId !== null ||
    assignment.consumedAt !== null
  ) {
    fail("DECISION_INVALID", "Assignment is not available for one-time consumption");
  }
  if (
    attempt.status !== "COMPLETED" ||
    attempt.runId === null ||
    attempt.runStartedAt === null ||
    attempt.runCompletedAt === null ||
    attempt.outputDigest === null
  ) {
    fail("DECISION_INVALID", "Attempt is not a completed authoritative Run");
  }
  assertEqual(
    attempt.outputDigest,
    sha256Digest(rawOutput),
    "Run output digest",
  );
  assertAttemptAndAssignmentBinding(session, attempt, assignment);
  assertRegistrationBinding(database, session, assignment);
  assertReceiptBinding(assignment, receipt);
  assertRoleQueryBinding(database, session, assignment, receipt);
  assertEqual(
    session.activeAttemptIds[assignment.role],
    attempt.attemptId,
    "Session active Attempt",
  );

  assertEqual(envelope.sessionId, assignment.sessionId, "Envelope Session");
  assertEqual(
    envelope.actionHash,
    assignment.actionHash,
    "Envelope Action",
    "ACTION_HASH_MISMATCH",
  );
  assertEqual(
    envelope.runAssignmentId,
    assignment.assignmentId,
    "Envelope Assignment",
  );
  assertEqual(envelope.role, assignment.role, "Envelope Role");
  assertEqual(envelope.receiptId, receipt.receiptId, "Envelope Receipt");
  assertEqual(envelope.nonce, receipt.nonce, "Envelope nonce");

  const certificateId = options.certificateId ?? randomUUID();
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (database.decisions.some((decision) => decision.certificateId === certificateId)) {
    fail("DECISION_INVALID", "Decision Certificate ID already exists");
  }
  const existingActiveId = session.activeDecisionCertificateIds[assignment.role];
  const existingActive =
    existingActiveId === null
      ? null
      : requireUnique(
          database.decisions,
          (decision) => decision.certificateId === existingActiveId,
          "Active Decision",
        );
  if (
    existingActive !== null &&
    (existingActive.status !== "ACTIVE" ||
      existingActive.role !== assignment.role ||
      existingActive.sessionId !== session.sessionId ||
      existingActive.actionHash !== session.actionHash)
  ) {
    fail("DECISION_INVALID", "Existing active Decision is not supersedable");
  }

  const certificate = DependencyCertificateSchema.parse({
    certificateId,
    sessionId: assignment.sessionId,
    actionHash: assignment.actionHash,
    agentId: assignment.agentId,
    runAssignmentId: assignment.assignmentId,
    runId: assignment.boundRunId,
    role: assignment.role,
    verdict: envelope.verdict,
    receiptIds: [receipt.receiptId],
    decisionDigest: sha256Digest(canonicalJson(envelope)),
    status: "ACTIVE",
    supersededByCertificateId: null,
    constructedBy: "epochguard",
    createdAt,
  });

  assignment.status = "CONSUMED";
  assignment.consumedByDecisionCertificateId = certificate.certificateId;
  assignment.consumedAt = createdAt;
  attempt.status = "ACCEPTED";
  if (existingActive !== null) {
    existingActive.status = "SUPERSEDED";
    existingActive.supersededByCertificateId = certificate.certificateId;
  }
  database.decisions.push(certificate);
  session.activeDecisionCertificateIds[assignment.role] = certificate.certificateId;
  session.activeAttemptIds[assignment.role] = null;

  return certificate;
}
