import {
  ArtifactRefSchema,
  ROLES,
  SafetyDiagnosticSchema,
  SafetyDiagnosticViewSchema,
  buildRoleQuerySpec,
  canonicalJson,
  sha256Digest,
  snapshotReceiptDependencySetHash,
  type ArtifactRef,
  type EpochDatabase,
  type RefreshPlan,
  type SafetyDiagnostic,
  type SafetyDiagnosticView,
  type ValidationRecord,
} from "./types.js";

export type SafetyDiagnosticIntegrityCode =
  | "INVALID_DIAGNOSTIC"
  | "INVALID_DIAGNOSTIC_CAUSAL_CHAIN"
  | "UNRESOLVED_ARTIFACT_REF";

export class SafetyDiagnosticIntegrityError extends Error {
  readonly name = "SafetyDiagnosticIntegrityError";

  constructor(
    readonly code: SafetyDiagnosticIntegrityCode,
    message: string,
  ) {
    super(message);
  }
}

const refKey = (reference: ArtifactRef): string =>
  `${reference.kind}:${reference.id}`;

const ROLE_ASSIGNMENT_KEYS = {
  inventory: "inventoryAgentId",
  budget: "budgetAgentId",
  policy: "policyAgentId",
} as const;

function integrityFailure(
  code: SafetyDiagnosticIntegrityCode,
  message: string,
): never {
  throw new SafetyDiagnosticIntegrityError(code, message);
}

function hasRef(
  diagnostic: SafetyDiagnostic,
  kind: ArtifactRef["kind"],
  id?: string,
): boolean {
  return diagnostic.artifactRefs.some(
    (reference) =>
      reference.kind === kind && (id === undefined || reference.id === id),
  );
}

function requireRef(
  diagnostic: SafetyDiagnostic,
  kind: ArtifactRef["kind"],
  id?: string,
): void {
  if (!hasRef(diagnostic, kind, id)) {
    integrityFailure(
      "INVALID_DIAGNOSTIC",
      `Diagnostic is missing its required ${kind} reference.`,
    );
  }
}

function assertDiagnosticShapeSemantics(diagnostic: SafetyDiagnostic): void {
  const uniqueReferences = new Set(diagnostic.artifactRefs.map(refKey));
  if (uniqueReferences.size !== diagnostic.artifactRefs.length) {
    integrityFailure(
      "INVALID_DIAGNOSTIC",
      "Diagnostic ArtifactRefs must be unique.",
    );
  }
  if (
    new Set(diagnostic.causedByDiagnosticIds).size !==
    diagnostic.causedByDiagnosticIds.length
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic causes must be unique.",
    );
  }
  if (diagnostic.causedByDiagnosticIds.includes(diagnostic.diagnosticId)) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "A Diagnostic cannot cause itself.",
    );
  }

  if (diagnostic.attemptId !== null) {
    requireRef(diagnostic, "ATTEMPT", diagnostic.attemptId);
  }
  if (diagnostic.assignmentId !== null) {
    requireRef(diagnostic, "ASSIGNMENT", diagnostic.assignmentId);
  }
  if (diagnostic.runId !== null) {
    requireRef(diagnostic, "RUN", diagnostic.runId);
  }
  if (diagnostic.rejectedOutputArtifactId !== null) {
    requireRef(
      diagnostic,
      "REJECTED_OUTPUT",
      diagnostic.rejectedOutputArtifactId,
    );
  }

  if (diagnostic.stage === "RUN") {
    if (
      diagnostic.kind !== "SYSTEM_FAILURE" ||
      (diagnostic.reasonCode !== "RUN_FAILED" &&
        diagnostic.reasonCode !== "RUN_TIMEOUT") ||
      diagnostic.role === null ||
      diagnostic.attemptId === null ||
      diagnostic.assignmentId === null ||
      diagnostic.runId === null
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC",
        "RUN Diagnostics require terminal Run, Attempt, Assignment, Role, and failure semantics.",
      );
    }
  }

  if (diagnostic.reasonCode === "OUTPUT_MALFORMED") {
    if (
      diagnostic.kind !== "SYSTEM_FAILURE" ||
      diagnostic.stage !== "PARSE" ||
      diagnostic.attemptId === null ||
      diagnostic.assignmentId === null ||
      diagnostic.rejectedOutputArtifactId === null
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC",
        "Malformed output must carry PARSE provenance and its rejected-output Artifact.",
      );
    }
  }

  if (diagnostic.reasonCode === "NO_VALID_OBSERVED_WORLD_CUT") {
    if (
      diagnostic.kind !== "EXPECTED_BLOCK" ||
      diagnostic.stage !== "VALIDATE" ||
      diagnostic.role !== null ||
      diagnostic.recommendedAction !== "REOBSERVE_INVALID"
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC",
        "No-Cut Diagnostics must be an expected VALIDATE block with selective re-observation.",
      );
    }
    requireRef(diagnostic, "VALIDATION");
    requireRef(diagnostic, "PROOF");
    if (
      diagnostic.artifactRefs.filter(
        (reference) => reference.kind === "RECEIPT",
      ).length < 2
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC",
        "No-Cut Diagnostics require both witness Receipt references.",
      );
    }
  }

  if (diagnostic.reasonCode === "HISTORICAL_BUT_STALE_NOW") {
    if (
      diagnostic.kind !== "EXPECTED_BLOCK" ||
      diagnostic.stage !== "VALIDATE" ||
      diagnostic.recommendedAction !== "REOBSERVE_INVALID"
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC",
        "Historical-stale Diagnostics must be an expected VALIDATE block.",
      );
    }
    requireRef(diagnostic, "VALIDATION");
  }

  if (diagnostic.reasonCode === "CONSISTENT_DENY") {
    if (
      diagnostic.kind !== "EXPECTED_BLOCK" ||
      diagnostic.stage !== "VALIDATE"
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC",
        "Consistent DENY must be recorded as an expected VALIDATE block.",
      );
    }
    requireRef(diagnostic, "VALIDATION");
  }

  if (diagnostic.reasonCode === "COMMIT_RACE") {
    if (
      diagnostic.kind !== "TRANSIENT_RACE" ||
      diagnostic.stage !== "COMMIT"
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC",
        "Commit races must be TRANSIENT_RACE/COMMIT Diagnostics.",
      );
    }
    requireRef(diagnostic, "VALIDATION");
    requireRef(diagnostic, "PERMIT");
  }
}

export function buildSafetyDiagnostic(input: unknown): SafetyDiagnostic {
  const parsed = SafetyDiagnosticSchema.safeParse(input);
  if (!parsed.success) {
    integrityFailure(
      "INVALID_DIAGNOSTIC",
      "SafetyDiagnostic does not satisfy epochguard-contract-v6.",
    );
  }
  assertDiagnosticShapeSemantics(parsed.data);
  return parsed.data;
}

function singleMatch<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): T | null {
  const matches = values.filter(predicate);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function artifactRefResolves(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
  reference: ArtifactRef,
): boolean {
  const sameSessionAction = (value: {
    sessionId: string;
    actionHash: string;
  }): boolean =>
    value.sessionId === diagnostic.sessionId &&
    value.actionHash === diagnostic.actionHash;

  switch (reference.kind) {
    case "ATTEMPT":
      return (
        singleMatch(
          database.attempts,
          (attempt) =>
            attempt.attemptId === reference.id && sameSessionAction(attempt),
        ) !== null
      );
    case "ASSIGNMENT":
      return (
        singleMatch(
          database.runAssignments,
          (assignment) =>
            assignment.assignmentId === reference.id &&
            sameSessionAction(assignment),
        ) !== null
      );
    case "RUN":
      // Run state is deliberately resolved only through the authoritative
      // AgentAttempt mirror in EpochStore. This module never reads launchpad.json.
      return (
        singleMatch(
          database.attempts,
          (attempt) =>
            attempt.runId === reference.id && sameSessionAction(attempt),
        ) !== null
      );
    case "ENVELOPE_DIGEST":
      return (
        singleMatch(
          database.attempts,
          (attempt) =>
            attempt.outputDigest === reference.id && sameSessionAction(attempt),
        ) !== null
      );
    case "REJECTED_OUTPUT": {
      const artifact = singleMatch(
        database.rejectedOutputArtifacts,
        (candidate) =>
          candidate.artifactId === reference.id &&
          candidate.sessionId === diagnostic.sessionId,
      );
      return (
        artifact !== null &&
        database.attempts.some(
          (attempt) =>
            attempt.attemptId === artifact.attemptId && sameSessionAction(attempt),
        )
      );
    }
    case "RECEIPT":
      return (
        singleMatch(
          database.receipts,
          (receipt) =>
            receipt.receiptId === reference.id && sameSessionAction(receipt),
        ) !== null
      );
    case "SOURCE_VERSION": {
      const version = singleMatch(
        database.resourceVersions,
        (candidate) => candidate.id === reference.id,
      );
      return (
        version !== null &&
        database.receipts.some(
          (receipt) =>
            sameSessionAction(receipt) &&
            receipt.sourceRevision === version.sourceRevision &&
            receipt.valueHash === version.valueHash
        )
      );
    }
    case "VALIDATION":
      return (
        singleMatch(
          database.validations,
          (validation) =>
            validation.validationId === reference.id &&
            sameSessionAction(validation),
        ) !== null
      );
    case "PROOF":
      return (
        singleMatch(
          database.noCutProofs,
          (proof) => proof.proofId === reference.id && sameSessionAction(proof),
        ) !== null
      );
    case "REFRESH_PLAN":
      return (
        singleMatch(
          database.refreshPlans,
          (plan) =>
            plan.refreshPlanId === reference.id &&
            plan.sessionId === diagnostic.sessionId,
        ) !== null
      );
    case "PERMIT":
      return (
        singleMatch(
          database.permits,
          (permit) =>
            permit.permitId === reference.id && sameSessionAction(permit),
        ) !== null
      );
    case "EFFECT":
      return (
        singleMatch(
          database.effects,
          (effect) =>
            effect.effectId === reference.id && sameSessionAction(effect),
        ) !== null
      );
  }
}

function sameOrderedIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
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

function refsOfKind(
  diagnostic: SafetyDiagnostic,
  kind: ArtifactRef["kind"],
): ArtifactRef[] {
  return diagnostic.artifactRefs.filter((reference) => reference.kind === kind);
}

function requireExactRef(
  diagnostic: SafetyDiagnostic,
  kind: ArtifactRef["kind"],
): ArtifactRef {
  const references = refsOfKind(diagnostic, kind);
  if (references.length !== 1 || references[0] === undefined) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      `Diagnostic must carry exactly one authoritative ${kind} reference.`,
    );
  }
  return references[0];
}

function assertOnlyRefKinds(
  diagnostic: SafetyDiagnostic,
  allowedKinds: readonly ArtifactRef["kind"][],
): void {
  if (
    diagnostic.artifactRefs.some(
      (reference) => !allowedKinds.includes(reference.kind),
    )
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic contains an unrelated ArtifactRef outside its authoritative causal closure.",
    );
  }
}

function resolveDecisionReceiptEvidence(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
  decisionId: string,
  expectedRoleIndex: number,
) {
  const decision = singleMatch(
    database.decisions,
    (candidate) => candidate.certificateId === decisionId,
  );
  if (
    decision === null ||
    decision.sessionId !== diagnostic.sessionId ||
    decision.actionHash !== diagnostic.actionHash ||
    decision.role !== ROLES[expectedRoleIndex] ||
    (decision.status !== "ACTIVE" && decision.status !== "SUPERSEDED")
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic Validation contains a cross-boundary or misordered Decision.",
    );
  }
  const assignment = singleMatch(
    database.runAssignments,
    (candidate) => candidate.assignmentId === decision.runAssignmentId,
  );
  const attempt = singleMatch(
    database.attempts,
    (candidate) =>
      candidate.assignmentId === decision.runAssignmentId &&
      candidate.runId === decision.runId,
  );
  if (
    assignment === null ||
    attempt === null ||
    assignment.sessionId !== diagnostic.sessionId ||
    assignment.actionHash !== diagnostic.actionHash ||
    assignment.agentId !== decision.agentId ||
    assignment.role !== decision.role ||
    assignment.boundRunId !== decision.runId ||
    assignment.status !== "CONSUMED" ||
    assignment.consumedByDecisionCertificateId !== decision.certificateId ||
    assignment.consumedAt === null ||
    attempt.sessionId !== diagnostic.sessionId ||
    attempt.actionHash !== diagnostic.actionHash ||
    attempt.agentId !== decision.agentId ||
    attempt.role !== decision.role ||
    attempt.status !== "ACCEPTED" ||
    attempt.runCompletedAt === null
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic Decision does not close over its consumed Assignment and accepted Attempt.",
    );
  }
  const receiptId = decision.receiptIds[0];
  const receipt = singleMatch(
    database.receipts,
    (candidate) => candidate.receiptId === receiptId,
  );
  if (
    receipt === null ||
    receipt.sessionId !== diagnostic.sessionId ||
    receipt.actionHash !== diagnostic.actionHash ||
    receipt.agentId !== decision.agentId ||
    receipt.role !== decision.role ||
    receipt.runAssignmentId !== decision.runAssignmentId ||
    assignment.receiptId !== receipt.receiptId ||
    assignment.queryHash !== receipt.queryHash
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic Decision does not close over its authoritative Receipt.",
    );
  }
  const session = singleMatch(
    database.sessions,
    (candidate) => candidate.sessionId === diagnostic.sessionId,
  );
  const query = singleMatch(
    database.roleQuerySpecs,
    (candidate) => candidate.queryHash === receipt.queryHash,
  );
  const registration = singleMatch(
    database.roleAgentRegistrations,
    (candidate) =>
      candidate.role === decision.role &&
      candidate.agentId === decision.agentId,
  );
  if (
    session === null ||
    query === null ||
    registration === null ||
    session.actionHash !== diagnostic.actionHash ||
    session.action.sessionId !== diagnostic.sessionId ||
    session.action.actionHash !== diagnostic.actionHash ||
    session.frozenAssignments[ROLE_ASSIGNMENT_KEYS[decision.role]] !==
      decision.agentId ||
    assignment.roleProfileVersion !== registration.roleProfileVersion ||
    assignment.agentsMdDigest !== registration.agentsMdDigest ||
    canonicalJson(query) !==
      canonicalJson(buildRoleQuerySpec(session.action, receipt.role)) ||
    query.actionHash !== diagnostic.actionHash ||
    query.role !== receipt.role ||
    query.source !== receipt.source ||
    query.entityKey !== receipt.entityKey
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic Receipt does not close over its frozen Role Query.",
    );
  }
  const version = singleMatch(
    database.resourceVersions,
    (candidate) =>
      candidate.sourceRevision === receipt.sourceRevision &&
      candidate.valueHash === receipt.valueHash,
  );
  const effectiveUntil = version?.validUntilSeq ?? database.headSeq + 1;
  if (
    version === null ||
    sha256Digest(canonicalJson(version.value)) !== version.valueHash ||
    version.validFromSeq > receipt.observedAtSeq ||
    receipt.observedAtSeq >= effectiveUntil ||
    receipt.observedAtSeq > database.headSeq
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic Receipt does not close over one authoritative ResourceVersion.",
    );
  }
  return { assignment, attempt, decision, receipt, registration, version };
}

type ResolvedDiagnosticEvidence = ReturnType<
  typeof resolveDecisionReceiptEvidence
>;

type ValidationEvidenceClosure = {
  readonly evidence: ResolvedDiagnosticEvidence[];
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly invalidAgentIds: string[];
};

function intervalUntilAtHead(
  version: ResolvedDiagnosticEvidence["version"],
  head: number,
): number | null {
  return version.validUntilSeq !== null && version.validUntilSeq <= head
    ? version.validUntilSeq
    : null;
}

function resolveValidationEvidenceClosure(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
  validation: ValidationRecord,
): ValidationEvidenceClosure {
  if (
    validation.sessionId !== diagnostic.sessionId ||
    validation.actionHash !== diagnostic.actionHash ||
    validation.validatedHead > database.headSeq
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic Validation crosses its Session/Action or references a future head.",
    );
  }
  const evidence = validation.decisionCertificateIds.map((decisionId, index) =>
    resolveDecisionReceiptEvidence(database, diagnostic, decisionId, index),
  );
  if (
    evidence.some(
      ({ receipt, version }) =>
        receipt.observedAtSeq > validation.validatedHead ||
        version.validFromSeq > validation.validatedHead,
    )
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic Validation depends on evidence from after its validated head.",
    );
  }
  const receiptIds = evidence.map(({ receipt }) => receipt.receiptId);
  const lowerBound = Math.max(
    ...evidence.map(({ version }) => version.validFromSeq),
  );
  const upperBound = Math.min(
    ...evidence.map(({ version }) =>
      intervalUntilAtHead(version, validation.validatedHead) ??
      validation.validatedHead + 1,
    ),
  );
  if (
    validation.dependencySetHash !==
      snapshotReceiptDependencySetHash(receiptIds) ||
    validation.lowerBound !== lowerBound ||
    validation.upperBound !== upperBound
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic Validation does not match its Receipt dependency set and interval bounds.",
    );
  }
  const invalidAgentIds = evidence
    .filter(
      ({ version }) =>
        version.validFromSeq > validation.validatedHead ||
        (version.validUntilSeq !== null &&
          validation.validatedHead >= version.validUntilSeq),
    )
    .map(({ decision }) => decision.agentId);
  return { evidence, lowerBound, upperBound, invalidAgentIds };
}

function assertJointValidityCertificateClosure(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
  validation: ValidationRecord,
  closure: ValidationEvidenceClosure,
): EpochDatabase["jointValidityCertificates"][number] {
  if (validation.jointValidityCertificateId === null) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Current-world Diagnostic Validation is missing its JointValidityCertificate.",
    );
  }
  const certificate = singleMatch(
    database.jointValidityCertificates,
    (candidate) =>
      candidate.certificateId === validation.jointValidityCertificateId,
  );
  if (
    certificate === null ||
    certificate.validationId !== validation.validationId ||
    certificate.sessionId !== diagnostic.sessionId ||
    certificate.actionHash !== diagnostic.actionHash ||
    certificate.dependencySetHash !== validation.dependencySetHash ||
    certificate.validatedAtHead !== validation.validatedHead ||
    certificate.selectedCutSeq !== validation.validatedHead ||
    certificate.currentHeadCovered !== true ||
    certificate.selectedCutSeq < closure.lowerBound ||
    certificate.selectedCutSeq >= closure.upperBound ||
    !sameOrderedIds(
      certificate.decisionCertificateIds,
      validation.decisionCertificateIds,
    ) ||
    certificate.intervals.length !== closure.evidence.length ||
    certificate.intervals.some((interval, index) => {
      const item = closure.evidence[index];
      return (
        item === undefined ||
        interval.receiptId !== item.receipt.receiptId ||
        interval.source !== item.receipt.source ||
        interval.sourceRevision !== item.receipt.sourceRevision ||
        interval.from !== item.version.validFromSeq ||
        interval.until !==
          intervalUntilAtHead(item.version, validation.validatedHead)
      );
    })
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic JointValidityCertificate does not close over its current-world Validation.",
    );
  }
  return certificate;
}

function assertOriginRefreshPlanClosure(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
  validation: ValidationRecord,
  closure: ValidationEvidenceClosure,
): RefreshPlan {
  const refreshRef = requireExactRef(diagnostic, "REFRESH_PLAN");
  if (
    validation.refreshPlanId === null ||
    refreshRef.id !== validation.refreshPlanId
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic RefreshPlan reference does not match its origin Validation.",
    );
  }
  const plan = singleMatch(
    database.refreshPlans,
    (candidate) => candidate.refreshPlanId === validation.refreshPlanId,
  );
  if (
    plan === null ||
    plan.sessionId !== diagnostic.sessionId ||
    plan.baseSessionRevision !== validation.baseSessionRevision + 1 ||
    plan.validatedHead !== validation.validatedHead ||
    plan.dependencySetHash !== validation.dependencySetHash ||
    !sameOrderedIds(
      plan.activeDecisionCertificateIds,
      validation.decisionCertificateIds,
    ) ||
    !sameIdSet(plan.agentIds, closure.invalidAgentIds) ||
    (plan.status === "AVAILABLE" && plan.claimedAttemptId !== null) ||
    ((plan.status === "CLAIMED" || plan.status === "COMPLETED") &&
      plan.claimedAttemptId === null)
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic RefreshPlan does not bind its revision, head, dependency, Decisions, and invalid owners.",
    );
  }
  return plan;
}

function assertNoCutDiagnosticClosure(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
): void {
  assertOnlyRefKinds(diagnostic, [
    "VALIDATION",
    "PROOF",
    "RECEIPT",
    "REFRESH_PLAN",
  ]);
  const validationRef = requireExactRef(diagnostic, "VALIDATION");
  const proofRef = requireExactRef(diagnostic, "PROOF");
  const receiptRefs = refsOfKind(diagnostic, "RECEIPT");
  if (receiptRefs.length !== 2) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "No-Cut Diagnostic must reference exactly its two canonical witness Receipts.",
    );
  }

  const validation = singleMatch(
    database.validations,
    (candidate) => candidate.validationId === validationRef.id,
  );
  const proof = singleMatch(
    database.noCutProofs,
    (candidate) => candidate.proofId === proofRef.id,
  );
  if (
    validation === null ||
    proof === null ||
    validation.sessionId !== diagnostic.sessionId ||
    validation.actionHash !== diagnostic.actionHash ||
    validation.outcome !== "NO_VALID_OBSERVED_WORLD_CUT" ||
    validation.noCutProofId !== proof.proofId ||
    validation.jointValidityCertificateId !== null ||
    proof.validationId !== validation.validationId ||
    proof.sessionId !== diagnostic.sessionId ||
    proof.actionHash !== diagnostic.actionHash ||
    proof.validatedAtHead !== validation.validatedHead ||
    proof.dependencySetHash !== validation.dependencySetHash ||
    proof.lowerBound !== validation.lowerBound ||
    proof.upperBound !== validation.upperBound ||
    !sameOrderedIds(
      proof.decisionCertificateIds,
      validation.decisionCertificateIds,
    )
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "No-Cut Diagnostic Validation and Proof do not form one authoritative chain.",
    );
  }

  const closure = resolveValidationEvidenceClosure(
    database,
    diagnostic,
    validation,
  );
  const plan = assertOriginRefreshPlanClosure(
    database,
    diagnostic,
    validation,
    closure,
  );
  const { evidence, lowerBound, upperBound } = closure;
  const receiptIds = evidence.map(({ receipt }) => receipt.receiptId);
  const effectiveUpper = evidence.map(({ version, receipt }) => ({
    receiptId: receipt.receiptId,
    value:
      intervalUntilAtHead(version, proof.validatedAtHead) ??
      proof.validatedAtHead + 1,
  }));
  const earliestEndingReceiptId = [...effectiveUpper].sort(
    (left, right) =>
      left.value - right.value ||
      (left.receiptId < right.receiptId
        ? -1
        : left.receiptId > right.receiptId
          ? 1
          : 0),
  )[0]!.receiptId;
  const latestStartingReceiptId = [...evidence]
    .sort(
      (left, right) =>
        right.version.validFromSeq - left.version.validFromSeq ||
        (left.receipt.receiptId < right.receipt.receiptId
          ? -1
          : left.receipt.receiptId > right.receipt.receiptId
            ? 1
            : 0),
    )[0]!.receipt.receiptId;
  const canonicalWitness = [
    earliestEndingReceiptId,
    latestStartingReceiptId,
  ];
  if (
    proof.dependencySetHash !== snapshotReceiptDependencySetHash(receiptIds) ||
    proof.lowerBound !== lowerBound ||
    proof.upperBound !== upperBound ||
    lowerBound < upperBound ||
    proof.earliestEndingReceiptId !== earliestEndingReceiptId ||
    proof.latestStartingReceiptId !== latestStartingReceiptId ||
    !sameIdSet(proof.refreshAgentIds, closure.invalidAgentIds) ||
    !sameIdSet(proof.refreshAgentIds, plan.agentIds) ||
    !sameOrderedIds(proof.conflictWitnessReceiptIds, canonicalWitness) ||
    !sameIdSet(
      receiptRefs.map((reference) => reference.id),
      canonicalWitness,
    )
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "No-Cut Diagnostic does not reference its canonical witness closure.",
    );
  }
}

function assertCommitRaceDiagnosticClosure(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
): void {
  assertOnlyRefKinds(diagnostic, ["VALIDATION", "PERMIT"]);
  const validationRef = requireExactRef(diagnostic, "VALIDATION");
  const permitRef = requireExactRef(diagnostic, "PERMIT");
  const validation = singleMatch(
    database.validations,
    (candidate) => candidate.validationId === validationRef.id,
  );
  const permit = singleMatch(
    database.permits,
    (candidate) => candidate.permitId === permitRef.id,
  );
  const session = singleMatch(
    database.sessions,
    (candidate) => candidate.sessionId === diagnostic.sessionId,
  );
  const raceEvent = singleMatch(
    database.auditEvents,
    (candidate) =>
      candidate.sessionId === diagnostic.sessionId &&
      candidate.actionHash === diagnostic.actionHash &&
      candidate.sessionRevision === diagnostic.sessionRevision &&
      candidate.type === "SESSION_STATE" &&
      candidate.status === "COMMIT_RACE",
  );
  if (
    validation === null ||
    permit === null ||
    session === null ||
    raceEvent === null ||
    validation.sessionId !== diagnostic.sessionId ||
    validation.actionHash !== diagnostic.actionHash ||
    validation.outcome !== "VALID_CURRENT_ALLOW" ||
    validation.noCutProofId !== null ||
    validation.jointValidityCertificateId === null ||
    validation.validatedHead >= database.headSeq ||
    permit.sessionId !== diagnostic.sessionId ||
    permit.actionHash !== diagnostic.actionHash ||
    permit.jointValidityCertificateId !==
      validation.jointValidityCertificateId ||
    permit.dependencySetHash !== validation.dependencySetHash ||
    permit.validatedHead !== validation.validatedHead ||
    permit.idempotencyKey !== session.action.idempotencyKey ||
    permit.status !== "REVOKED" ||
    permit.consumedAt !== null ||
    Date.parse(raceEvent.createdAt) < Date.parse(permit.issuedAt) ||
    diagnostic.sessionRevision > session.sessionRevision ||
    (diagnostic.sessionRevision === session.sessionRevision &&
      (session.state !== "COMMIT_RACE" ||
        session.activeValidationId !== validation.validationId ||
        (session.activePermitId !== null &&
          session.activePermitId !== permit.permitId)))
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Commit-race Diagnostic Validation and Permit do not form one authoritative chain.",
    );
  }
  const authoritativePermit = singleMatch(
    database.permits,
    (candidate) =>
      candidate.sessionId === diagnostic.sessionId &&
      candidate.actionHash === diagnostic.actionHash &&
      candidate.jointValidityCertificateId ===
        validation.jointValidityCertificateId &&
      candidate.dependencySetHash === validation.dependencySetHash &&
      candidate.validatedHead === validation.validatedHead,
  );
  if (authoritativePermit?.permitId !== permit.permitId) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Commit-race Diagnostic must reference the unique Permit for its Validation chain.",
    );
  }
  const closure = resolveValidationEvidenceClosure(
    database,
    diagnostic,
    validation,
  );
  const certificate = assertJointValidityCertificateClosure(
    database,
    diagnostic,
    validation,
    closure,
  );
  const raceEventRefKeys = raceEvent.artifactRefs.map(refKey);
  const expectedRaceEventRefKeys = [
    refKey({ kind: "VALIDATION", id: validation.validationId }),
    refKey({ kind: "PERMIT", id: permit.permitId }),
  ];
  const activeDecisionIds = ROLES.flatMap((role) => {
    const decisionId = session.activeDecisionCertificateIds[role];
    return decisionId === null ? [] : [decisionId];
  });
  if (
    closure.lowerBound >= closure.upperBound ||
    !sameIdSet(raceEventRefKeys, expectedRaceEventRefKeys) ||
    Date.parse(permit.issuedAt) < Date.parse(validation.createdAt) ||
    Date.parse(permit.issuedAt) < Date.parse(certificate.createdAt) ||
    !closure.evidence.every(
      ({ decision }) => decision.verdict === "ALLOW",
    ) ||
    (diagnostic.sessionRevision === session.sessionRevision &&
      !sameOrderedIds(activeDecisionIds, validation.decisionCertificateIds)) ||
    database.effects.some(
      (effect) =>
        effect.permitId === permit.permitId ||
        (effect.idempotencyKey === permit.idempotencyKey &&
          Date.parse(effect.createdAt) <= Date.parse(raceEvent.createdAt)),
    )
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Commit-race Diagnostic does not close three ALLOW Decisions or its no-effect race lifecycle.",
    );
  }
}

function assertHistoricalStaleDiagnosticClosure(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
): void {
  assertOnlyRefKinds(diagnostic, ["VALIDATION", "REFRESH_PLAN", "RECEIPT"]);
  const validationRef = requireExactRef(diagnostic, "VALIDATION");
  const validation = singleMatch(
    database.validations,
    (candidate) => candidate.validationId === validationRef.id,
  );
  if (
    validation === null ||
    validation.outcome !== "HISTORICAL_BUT_STALE_NOW" ||
    validation.noCutProofId !== null ||
    validation.jointValidityCertificateId !== null
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Historical-stale Diagnostic must reference its matching historical Validation.",
    );
  }
  const closure = resolveValidationEvidenceClosure(
    database,
    diagnostic,
    validation,
  );
  const plan = assertOriginRefreshPlanClosure(
    database,
    diagnostic,
    validation,
    closure,
  );
  const currentCovered =
    closure.lowerBound <= validation.validatedHead &&
    validation.validatedHead < closure.upperBound;
  const invalidReceiptIds = closure.evidence
    .filter(({ decision }) => plan.agentIds.includes(decision.agentId))
    .map(({ receipt }) => receipt.receiptId);
  const referencedReceiptIds = refsOfKind(diagnostic, "RECEIPT").map(
    (reference) => reference.id,
  );
  if (
    closure.lowerBound >= closure.upperBound ||
    currentCovered ||
    closure.invalidAgentIds.length === 0 ||
    (referencedReceiptIds.length > 0 &&
      !sameIdSet(referencedReceiptIds, invalidReceiptIds))
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Historical-stale Diagnostic does not close its past cut and current invalid owners.",
    );
  }
}

function assertConsistentDenyDiagnosticClosure(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
): void {
  assertOnlyRefKinds(diagnostic, ["VALIDATION", "REFRESH_PLAN", "RECEIPT"]);
  const validationRef = requireExactRef(diagnostic, "VALIDATION");
  const validation = singleMatch(
    database.validations,
    (candidate) => candidate.validationId === validationRef.id,
  );
  if (
    validation === null ||
    validation.outcome !== "CONSISTENT_DENY" ||
    validation.noCutProofId !== null
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Consistent-DENY Diagnostic must reference its matching Validation.",
    );
  }
  const closure = resolveValidationEvidenceClosure(
    database,
    diagnostic,
    validation,
  );
  assertJointValidityCertificateClosure(
    database,
    diagnostic,
    validation,
    closure,
  );
  if (
    closure.lowerBound >= closure.upperBound ||
    !closure.evidence.some(({ decision }) => decision.verdict === "DENY")
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Consistent-DENY Diagnostic does not close a valid cut containing a DENY Decision.",
    );
  }

  const refreshRefs = refsOfKind(diagnostic, "REFRESH_PLAN");
  const receiptRefs = refsOfKind(diagnostic, "RECEIPT");
  if (validation.refreshPlanId === null) {
    if (refreshRefs.length !== 0 || receiptRefs.length !== 0) {
      integrityFailure(
        "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
        "Initial Consistent-DENY Diagnostic cannot reference unrelated refresh artifacts.",
      );
    }
    return;
  }

  const originValidation = singleMatch(
    database.validations,
    (candidate) =>
      candidate.refreshPlanId === validation.refreshPlanId &&
      (candidate.outcome === "NO_VALID_OBSERVED_WORLD_CUT" ||
        candidate.outcome === "HISTORICAL_BUT_STALE_NOW"),
  );
  if (originValidation === null) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Refreshed Consistent-DENY Diagnostic is missing its origin Validation.",
    );
  }
  const originClosure = resolveValidationEvidenceClosure(
    database,
    diagnostic,
    originValidation,
  );
  const plan = assertOriginRefreshPlanClosure(
    database,
    diagnostic,
    originValidation,
    originClosure,
  );
  const refreshedEvidence = closure.evidence.filter(({ decision }, index) => {
    const origin = originClosure.evidence[index];
    return (
      origin !== undefined &&
      plan.agentIds.includes(decision.agentId) &&
      decision.certificateId !== origin.decision.certificateId
    );
  });
  const retainedEvidenceIsStable = closure.evidence.every(
    ({ decision }, index) => {
      const origin = originClosure.evidence[index];
      return (
        origin !== undefined &&
        (plan.agentIds.includes(decision.agentId) ||
          decision.certificateId === origin.decision.certificateId)
      );
    },
  );
  if (
    plan.status !== "COMPLETED" ||
    plan.claimedAttemptId === null ||
    !sameIdSet(
      refreshedEvidence.map(({ decision }) => decision.agentId),
      plan.agentIds,
    ) ||
    !retainedEvidenceIsStable ||
    !refreshedEvidence.some(
      ({ attempt }) => attempt.attemptId === plan.claimedAttemptId,
    ) ||
    !sameIdSet(
      receiptRefs.map((reference) => reference.id),
      refreshedEvidence.map(({ receipt }) => receipt.receiptId),
    )
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Refreshed Consistent-DENY Diagnostic does not close its completed selective refresh.",
    );
  }
}

function assertReasonSpecificClosure(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
): void {
  if (diagnostic.reasonCode === "NO_VALID_OBSERVED_WORLD_CUT") {
    assertNoCutDiagnosticClosure(database, diagnostic);
  }
  if (diagnostic.reasonCode === "COMMIT_RACE") {
    assertCommitRaceDiagnosticClosure(database, diagnostic);
  }
  if (diagnostic.reasonCode === "HISTORICAL_BUT_STALE_NOW") {
    assertHistoricalStaleDiagnosticClosure(database, diagnostic);
  }
  if (diagnostic.reasonCode === "CONSISTENT_DENY") {
    assertConsistentDenyDiagnosticClosure(database, diagnostic);
  }
}

function assertDirectProvenance(
  database: EpochDatabase,
  diagnostic: SafetyDiagnostic,
  expectedAgentId: string | null,
): void {
  const attempt =
    diagnostic.attemptId === null
      ? null
      : singleMatch(
          database.attempts,
          (candidate) => candidate.attemptId === diagnostic.attemptId,
        );
  const assignment =
    diagnostic.assignmentId === null
      ? null
      : singleMatch(
          database.runAssignments,
          (candidate) => candidate.assignmentId === diagnostic.assignmentId,
        );

  if (diagnostic.attemptId !== null && attempt === null) {
    integrityFailure(
      "UNRESOLVED_ARTIFACT_REF",
      "Diagnostic Attempt provenance is unresolved.",
    );
  }
  if (diagnostic.assignmentId !== null && assignment === null) {
    integrityFailure(
      "UNRESOLVED_ARTIFACT_REF",
      "Diagnostic Assignment provenance is unresolved.",
    );
  }
  if (attempt !== null) {
    if (
      attempt.sessionId !== diagnostic.sessionId ||
      attempt.actionHash !== diagnostic.actionHash ||
      (diagnostic.role !== null && attempt.role !== diagnostic.role) ||
      (expectedAgentId !== null && attempt.agentId !== expectedAgentId) ||
      (diagnostic.assignmentId !== null &&
        attempt.assignmentId !== diagnostic.assignmentId) ||
      (diagnostic.runId !== null && attempt.runId !== diagnostic.runId)
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
        "Diagnostic Attempt provenance crosses a frozen binding.",
      );
    }
  }
  if (assignment !== null) {
    if (
      assignment.sessionId !== diagnostic.sessionId ||
      assignment.actionHash !== diagnostic.actionHash ||
      (diagnostic.role !== null && assignment.role !== diagnostic.role) ||
      (expectedAgentId !== null && assignment.agentId !== expectedAgentId) ||
      (diagnostic.runId !== null &&
        assignment.boundRunId !== diagnostic.runId)
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
        "Diagnostic Assignment provenance crosses a frozen binding.",
      );
    }
  }
  if (
    attempt !== null &&
    assignment !== null &&
    attempt.agentId !== assignment.agentId
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "Diagnostic Attempt and Assignment must bind the same Agent.",
    );
  }
  if (
    diagnostic.stage === "RUN" &&
    (attempt === null ||
      (attempt.status !== "FAILED" && attempt.status !== "INTERRUPTED") ||
      attempt.runCompletedAt === null)
  ) {
    integrityFailure(
      "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
      "RUN Diagnostic provenance must point at a terminal failed Attempt mirror.",
    );
  }
  if (diagnostic.rejectedOutputArtifactId !== null) {
    const artifact = singleMatch(
      database.rejectedOutputArtifacts,
      (candidate) =>
        candidate.artifactId === diagnostic.rejectedOutputArtifactId,
    );
    if (
      artifact === null ||
      artifact.sessionId !== diagnostic.sessionId ||
      artifact.attemptId !== diagnostic.attemptId
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
        "Rejected output does not belong to the Diagnostic Attempt.",
      );
    }
  }
}

export function assertSafetyDiagnosticCausalChains(
  database: EpochDatabase,
  sessionId?: string,
): void {
  const selected =
    sessionId === undefined
      ? database.diagnostics
      : database.diagnostics.filter(
          (diagnostic) => diagnostic.sessionId === sessionId,
        );
  const byId = new Map<string, SafetyDiagnostic>();
  const auditSequences = new Set<string>();

  for (const candidate of selected) {
    const diagnostic = buildSafetyDiagnostic(candidate);
    if (byId.has(diagnostic.diagnosticId)) {
      integrityFailure(
        "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
        "Diagnostic IDs must be unique.",
      );
    }
    const auditKey = `${diagnostic.sessionId}:${diagnostic.auditSeq}`;
    if (auditSequences.has(auditKey)) {
      integrityFailure(
        "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
        "Diagnostic audit sequences must be unique within a Session.",
      );
    }
    auditSequences.add(auditKey);
    byId.set(diagnostic.diagnosticId, diagnostic);
  }

  for (const diagnostic of selected) {
    const session = singleMatch(
      database.sessions,
      (candidate) => candidate.sessionId === diagnostic.sessionId,
    );
    if (
      session === null ||
      session.actionHash !== diagnostic.actionHash ||
      diagnostic.sessionRevision > session.sessionRevision
    ) {
      integrityFailure(
        "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
        "Diagnostic must bind an existing Session, its immutable Action, and a persisted Session revision.",
      );
    }
    const expectedAgentId =
      diagnostic.role === null
        ? null
        : session.frozenAssignments[
            diagnostic.role === "inventory"
              ? "inventoryAgentId"
              : diagnostic.role === "budget"
                ? "budgetAgentId"
                : "policyAgentId"
          ];
    assertDirectProvenance(database, diagnostic, expectedAgentId);
    for (const reference of diagnostic.artifactRefs) {
      if (!ArtifactRefSchema.safeParse(reference).success) {
        integrityFailure(
          "INVALID_DIAGNOSTIC",
          "Diagnostic contains a contract-invalid ArtifactRef.",
        );
      }
      if (!artifactRefResolves(database, diagnostic, reference)) {
        integrityFailure(
          "UNRESOLVED_ARTIFACT_REF",
          "Diagnostic contains an unresolved or cross-Session ArtifactRef.",
        );
      }
    }
    assertReasonSpecificClosure(database, diagnostic);
    for (const causeId of diagnostic.causedByDiagnosticIds) {
      const cause = byId.get(causeId);
      if (
        cause === undefined ||
        cause.sessionId !== diagnostic.sessionId ||
        cause.actionHash !== diagnostic.actionHash ||
        cause.sessionRevision > diagnostic.sessionRevision ||
        cause.auditSeq >= diagnostic.auditSeq
      ) {
        integrityFailure(
          "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
          "Diagnostic cause must resolve to an earlier Diagnostic in the same Session and Action.",
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (diagnosticId: string): void => {
    if (visiting.has(diagnosticId)) {
      integrityFailure(
        "INVALID_DIAGNOSTIC_CAUSAL_CHAIN",
        "Diagnostic causal chains cannot contain cycles.",
      );
    }
    if (visited.has(diagnosticId)) return;
    visiting.add(diagnosticId);
    for (const causeId of byId.get(diagnosticId)?.causedByDiagnosticIds ?? []) {
      visit(causeId);
    }
    visiting.delete(diagnosticId);
    visited.add(diagnosticId);
  };
  for (const diagnosticId of byId.keys()) visit(diagnosticId);
}

export function toSafetyDiagnosticView(
  diagnostic: SafetyDiagnostic,
): SafetyDiagnosticView {
  assertDiagnosticShapeSemantics(diagnostic);
  return SafetyDiagnosticViewSchema.parse({
    diagnosticId: diagnostic.diagnosticId,
    kind: diagnostic.kind,
    stage: diagnostic.stage,
    reasonCode: diagnostic.reasonCode,
    role: diagnostic.role,
    relevantIds: diagnostic.artifactRefs,
    auditSeq: diagnostic.auditSeq,
    recommendedAction: diagnostic.recommendedAction,
  });
}

export function latestSafetyDiagnosticViews(
  database: EpochDatabase,
  sessionId: string,
  limit = 3,
): SafetyDiagnosticView[] {
  assertSafetyDiagnosticCausalChains(database, sessionId);
  return database.diagnostics
    .filter((diagnostic) => diagnostic.sessionId === sessionId)
    .sort(
      (left, right) =>
        right.auditSeq - left.auditSeq ||
        (left.diagnosticId < right.diagnosticId
          ? -1
          : left.diagnosticId > right.diagnosticId
            ? 1
            : 0),
    )
    .slice(0, Math.max(0, Math.min(limit, 3)))
    .map(toSafetyDiagnosticView);
}
