import {
  ArtifactRefSchema,
  SafetyDiagnosticSchema,
  SafetyDiagnosticViewSchema,
  type ArtifactRef,
  type EpochDatabase,
  type SafetyDiagnostic,
  type SafetyDiagnosticView,
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
