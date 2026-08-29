import {
  ActionIntentSchema,
  AgentAttemptSchema,
  CommitSessionRequestSchema,
  DependencyCertificateSchema,
  EffectPermitSchema,
  EffectRecordSchema,
  JointValidityCertificateSchema,
  ObservationReceiptSchema,
  ROLES,
  ResourceVersionSchema,
  RoleQuerySpecSchema,
  RunAssignmentSchema,
  TimestampSchema,
  ValidationRecordSchema,
  actionHash as canonicalActionHash,
  buildRoleQuerySpec,
  canonicalizeRoleQuery,
  makeStaleViewError,
  snapshotReceiptDependencySetHash,
  type CommitSessionRequest,
  type EffectRecord,
  type EpochDatabase,
  type EpochSession,
  type FailureCode,
  type ObservationReceipt,
  type ResourceVersion,
  type Role,
  type StaleViewErrorBody,
} from "./types.js";

export interface EffectGateMutationPort {
  mutate<T>(
    mutation: (database: EpochDatabase) => T | Promise<T>,
  ): Promise<T>;
}

/**
 * EG-02 owns the Resource ID convention. The Gate only needs a synchronous,
 * Store-local resolver so no I/O or model work can occur inside the mutation.
 */
export interface EffectGateWorldPort {
  resolveResourceVersion(
    database: Readonly<EpochDatabase>,
    receipt: Readonly<ObservationReceipt>,
  ): ResourceVersion | null;
}

export interface EffectGatePorts {
  store: EffectGateMutationPort;
  world: EffectGateWorldPort;
  createEffectId(): string;
  now(): string;
}

export interface CommitProtectedEffectInput {
  sessionId: string;
  request: CommitSessionRequest;
}

export type CommitProtectedEffectResult =
  | {
      status: "COMMITTED";
      created: boolean;
      effect: EffectRecord;
      effectsInSession: 1;
    }
  | {
      status: "REJECTED";
      reasonCode: FailureCode;
      message: string;
      effectsInSession: number;
      error: StaleViewErrorBody | null;
    };

class AbortEffectCommit extends Error {
  constructor(readonly result: CommitProtectedEffectResult) {
    super(result.status === "REJECTED" ? result.message : result.status);
    this.name = "AbortEffectCommit";
  }
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function orderedActiveDecisionIds(session: EpochSession): [string, string, string] {
  const { inventory, budget, policy } = session.activeDecisionCertificateIds;
  if (inventory === null || budget === null || policy === null) {
    reject("DECISION_INVALID", "all three active Decision IDs are required");
  }
  return [inventory, budget, policy];
}

function reject(
  reasonCode: FailureCode,
  message: string,
  effectsInSession = 0,
  error: StaleViewErrorBody | null = null,
): never {
  throw new AbortEffectCommit({
    status: "REJECTED",
    reasonCode,
    message,
    effectsInSession,
    error,
  });
}

function requireSingle<T>(
  values: readonly T[],
  reasonCode: FailureCode,
  message: string,
): T {
  if (values.length !== 1) reject(reasonCode, message);
  return values[0]!;
}

function expectedAgentForRole(session: EpochSession, role: Role): string {
  switch (role) {
    case "inventory":
      return session.frozenAssignments.inventoryAgentId;
    case "budget":
      return session.frozenAssignments.budgetAgentId;
    case "policy":
      return session.frozenAssignments.policyAgentId;
  }
}

function effectScopeCount(database: EpochDatabase, sessionId: string): number {
  return database.effects.filter((effect) => effect.sessionId === sessionId).length;
}

function returnExistingEffect(
  database: EpochDatabase,
  session: EpochSession,
  expectedActionHash: string,
  expectedIdempotencyKey: string,
): CommitProtectedEffectResult | null {
  const sessionEffects = database.effects.filter(
    (effect) => effect.sessionId === session.sessionId,
  );
  if (sessionEffects.length === 0) return null;
  if (sessionEffects.length !== 1) {
    return reject(
      "BINDING_MISMATCH",
      "a Session must not contain more than one protected Effect",
      sessionEffects.length,
    );
  }
  const parsed = EffectRecordSchema.safeParse(sessionEffects[0]);
  if (!parsed.success) {
    return reject(
      "BINDING_MISMATCH",
      "the existing Effect record is malformed",
      sessionEffects.length,
    );
  }
  const effect = parsed.data;
  if (
    effect.actionHash !== expectedActionHash ||
    effect.idempotencyKey !== expectedIdempotencyKey ||
    effect.type !== session.action.type
  ) {
    return reject(
      "ACTION_HASH_MISMATCH",
      "the existing Effect does not match the immutable Session Action",
      sessionEffects.length,
    );
  }
  return {
    status: "COMMITTED",
    created: false,
    effect,
    effectsInSession: 1,
  };
}

function invalidateCommitRace(
  database: EpochDatabase,
  session: EpochSession,
  permitId: string,
  timestamp: string,
): CommitProtectedEffectResult {
  const permit = database.permits.find(
    (candidate) => candidate.permitId === permitId,
  );
  if (permit !== undefined && permit.status === "ISSUED") {
    permit.status = "REVOKED";
    permit.consumedAt = null;
  }
  session.state = "COMMIT_RACE";
  session.activePermitId = null;
  session.sessionRevision += 1;
  session.stateUpdatedAt = timestamp;
  return {
    status: "REJECTED",
    reasonCode: "COMMIT_RACE",
    message: "World head changed after Permit validation.",
    effectsInSession: effectScopeCount(database, session.sessionId),
    error: null,
  };
}

/**
 * Performs the Mock Sink release in the same Store mutation as every freshness
 * and provenance check. An existing Session+Action Effect is returned before
 * the client revision check, which makes lost-response retries converge.
 */
export async function commitProtectedEffect(
  ports: EffectGatePorts,
  input: CommitProtectedEffectInput,
): Promise<CommitProtectedEffectResult> {
  const request = CommitSessionRequestSchema.parse(input.request);
  try {
    return await ports.store.mutate((database) => {
      const sessions = database.sessions.filter(
        (candidate) => candidate.sessionId === input.sessionId,
      );
      if (sessions.length === 0) {
        return reject("SESSION_NOT_FOUND", "EpochGuard Session was not found.");
      }
      if (sessions.length !== 1) {
        return reject(
          "BINDING_MISMATCH",
          "the Session ID must resolve exactly once",
          effectScopeCount(database, input.sessionId),
        );
      }
      const session = sessions[0]!;

      const parsedAction = ActionIntentSchema.safeParse(session.action);
      if (!parsedAction.success) {
        return reject(
          "ACTION_HASH_MISMATCH",
          "the persisted Action does not satisfy the frozen contract",
          effectScopeCount(database, session.sessionId),
        );
      }
      const expectedActionHash = canonicalActionHash(parsedAction.data);
      const expectedIdempotencyKey = `${session.sessionId}:${expectedActionHash}`;
      if (
        session.actionHash !== expectedActionHash ||
        parsedAction.data.actionHash !== expectedActionHash ||
        parsedAction.data.sessionId !== session.sessionId ||
        parsedAction.data.idempotencyKey !== expectedIdempotencyKey
      ) {
        return reject(
          "ACTION_HASH_MISMATCH",
          "the Session Action hash or idempotency scope changed",
          effectScopeCount(database, session.sessionId),
        );
      }

      const existing = returnExistingEffect(
        database,
        session,
        expectedActionHash,
        expectedIdempotencyKey,
      );
      if (existing !== null) return existing;

      if (request.expectedSessionRevision !== session.sessionRevision) {
        const error = makeStaleViewError(
          session.sessionId,
          request.expectedSessionRevision,
          session.sessionRevision,
        );
        return reject("STALE_VIEW", error.message, 0, error);
      }
      if (session.state !== "READY_AT_CURRENT_HEAD") {
        return reject(
          "BINDING_MISMATCH",
          "only READY_AT_CURRENT_HEAD may enter the Effect Gate",
        );
      }
      if (session.activePermitId === null) {
        return reject("BINDING_MISMATCH", "the ready Session has no active Permit");
      }

      const permitRecord = requireSingle(
        database.permits.filter(
          (candidate) => candidate.permitId === session.activePermitId,
        ),
        "BINDING_MISMATCH",
        "the active Permit must resolve exactly once",
      );
      const parsedPermit = EffectPermitSchema.safeParse(permitRecord);
      if (!parsedPermit.success) {
        return reject("BINDING_MISMATCH", "the active Permit is malformed");
      }
      const permit = parsedPermit.data;
      if (
        permit.status !== "ISSUED" ||
        permit.consumedAt !== null ||
        permit.sessionId !== session.sessionId ||
        permit.actionHash !== expectedActionHash ||
        permit.idempotencyKey !== expectedIdempotencyKey
      ) {
        return reject(
          "BINDING_MISMATCH",
          "Permit status, Session, Action, or idempotency binding is invalid",
        );
      }

      if (database.headSeq !== permit.validatedHead) {
        return invalidateCommitRace(
          database,
          session,
          permit.permitId,
          TimestampSchema.parse(ports.now()),
        );
      }

      const jvcRecord = requireSingle(
        database.jointValidityCertificates.filter(
          (candidate) =>
            candidate.certificateId === permit.jointValidityCertificateId,
        ),
        "BINDING_MISMATCH",
        "Permit JVC must resolve exactly once",
      );
      const parsedJvc = JointValidityCertificateSchema.safeParse(jvcRecord);
      if (!parsedJvc.success) {
        return reject("BINDING_MISMATCH", "the Permit JVC is malformed");
      }
      const jvc = parsedJvc.data;

      const validationRecord = requireSingle(
        database.validations.filter(
          (candidate) => candidate.validationId === jvc.validationId,
        ),
        "BINDING_MISMATCH",
        "JVC Validation must resolve exactly once",
      );
      const parsedValidation = ValidationRecordSchema.safeParse(validationRecord);
      if (!parsedValidation.success) {
        return reject("BINDING_MISMATCH", "the active Validation is malformed");
      }
      const validation = parsedValidation.data;
      const activeDecisionIds = orderedActiveDecisionIds(session);
      if (
        session.activeValidationId !== validation.validationId ||
        validation.sessionId !== session.sessionId ||
        validation.actionHash !== expectedActionHash ||
        validation.outcome !== "VALID_CURRENT_ALLOW" ||
        validation.validatedHead !== database.headSeq ||
        validation.jointValidityCertificateId !== jvc.certificateId ||
        validation.noCutProofId !== null ||
        !sameOrderedIds(validation.decisionCertificateIds, activeDecisionIds) ||
        jvc.sessionId !== session.sessionId ||
        jvc.actionHash !== expectedActionHash ||
        jvc.validatedAtHead !== database.headSeq ||
        jvc.selectedCutSeq !== database.headSeq ||
        jvc.currentHeadCovered !== true ||
        !sameOrderedIds(jvc.decisionCertificateIds, activeDecisionIds) ||
        permit.jointValidityCertificateId !== jvc.certificateId ||
        permit.validatedHead !== jvc.validatedAtHead ||
        permit.dependencySetHash !== jvc.dependencySetHash ||
        validation.dependencySetHash !== jvc.dependencySetHash
      ) {
        return reject(
          "BINDING_MISMATCH",
          "Permit, JVC, Validation, head, or active Decision tuple does not match",
        );
      }

      const receiptIds: string[] = [];
      const attemptIds: string[] = [];
      const runIds: string[] = [];
      const intervalBounds: Array<{ from: number; until: number }> = [];
      for (const [index, role] of ROLES.entries()) {
        const decisionId = activeDecisionIds[index]!;
        const decisionRecord = requireSingle(
          database.decisions.filter(
            (candidate) => candidate.certificateId === decisionId,
          ),
          "DECISION_INVALID",
          `active ${role} Decision must resolve exactly once`,
        );
        const parsedDecision = DependencyCertificateSchema.safeParse(decisionRecord);
        if (!parsedDecision.success) {
          return reject("DECISION_INVALID", `active ${role} Decision is malformed`);
        }
        const decision = parsedDecision.data;
        const expectedAgentId = expectedAgentForRole(session, role);
        if (
          decision.status !== "ACTIVE" ||
          decision.supersededByCertificateId !== null ||
          decision.sessionId !== session.sessionId ||
          decision.actionHash !== expectedActionHash ||
          decision.role !== role ||
          decision.agentId !== expectedAgentId ||
          decision.verdict !== "ALLOW" ||
          decision.receiptIds.length !== 1
        ) {
          return reject(
            "DECISION_INVALID",
            `active ${role} Decision is not a current ALLOW bound to its frozen Agent`,
          );
        }
        const assignmentRecord = requireSingle(
          database.runAssignments.filter(
            (candidate) =>
              candidate.assignmentId === decision.runAssignmentId,
          ),
          "DECISION_INVALID",
          `${role} Assignment must resolve exactly once`,
        );
        const parsedAssignment = RunAssignmentSchema.safeParse(assignmentRecord);
        if (!parsedAssignment.success) {
          return reject("DECISION_INVALID", `${role} Assignment is malformed`);
        }
        const assignment = parsedAssignment.data;
        const receiptId = decision.receiptIds[0];
        if (
          receiptId === undefined ||
          assignment.status !== "CONSUMED" ||
          assignment.boundRunId !== decision.runId ||
          assignment.consumedByDecisionCertificateId !== decision.certificateId ||
          assignment.boundAt === null ||
          assignment.consumedAt === null ||
          assignment.sessionId !== session.sessionId ||
          assignment.actionHash !== expectedActionHash ||
          assignment.agentId !== expectedAgentId ||
          assignment.role !== role ||
          assignment.receiptId !== receiptId
        ) {
          return reject(
            "DECISION_INVALID",
            `${role} Assignment/Run/Decision binding is invalid`,
          );
        }

        const attemptRecord = requireSingle(
          database.attempts.filter(
            (candidate) => candidate.assignmentId === assignment.assignmentId,
          ),
          "DECISION_INVALID",
          `${role} accepted Attempt must resolve exactly once`,
        );
        const parsedAttempt = AgentAttemptSchema.safeParse(attemptRecord);
        if (!parsedAttempt.success) {
          return reject("DECISION_INVALID", `${role} Attempt is malformed`);
        }
        const attempt = parsedAttempt.data;
        if (
          attempt.status !== "ACCEPTED" ||
          attempt.sessionId !== session.sessionId ||
          attempt.actionHash !== expectedActionHash ||
          attempt.role !== role ||
          attempt.agentId !== expectedAgentId ||
          attempt.runId !== decision.runId
        ) {
          return reject(
            "DECISION_INVALID",
            `${role} Attempt does not prove the accepted bound Run`,
          );
        }
        attemptIds.push(attempt.attemptId);
        runIds.push(decision.runId);

        const receiptRecord = requireSingle(
          database.receipts.filter(
            (candidate) => candidate.receiptId === receiptId,
          ),
          "DECISION_INVALID",
          `${role} Receipt must resolve exactly once`,
        );
        const parsedReceipt = ObservationReceiptSchema.safeParse(receiptRecord);
        if (!parsedReceipt.success) {
          return reject("DECISION_INVALID", `${role} Receipt is malformed`);
        }
        const receipt = parsedReceipt.data;
        const expectedQuery = buildRoleQuerySpec(parsedAction.data, role);
        const persistedQueryMatches = database.roleQuerySpecs.some((candidate) => {
          const parsed = RoleQuerySpecSchema.safeParse(candidate);
          return (
            parsed.success &&
            parsed.data.queryHash === expectedQuery.queryHash &&
            canonicalizeRoleQuery(parsed.data) ===
              canonicalizeRoleQuery(expectedQuery)
          );
        });
        if (
          !persistedQueryMatches ||
          assignment.queryHash !== expectedQuery.queryHash ||
          receipt.queryHash !== expectedQuery.queryHash ||
          receipt.sessionId !== session.sessionId ||
          receipt.actionHash !== expectedActionHash ||
          receipt.agentId !== expectedAgentId ||
          receipt.runAssignmentId !== assignment.assignmentId ||
          receipt.role !== role ||
          receipt.source !== role ||
          receipt.entityKey !== expectedQuery.entityKey
        ) {
          return reject(
            "DECISION_INVALID",
            `${role} Receipt/query/Assignment provenance is invalid`,
          );
        }

        const resolvedVersion = ports.world.resolveResourceVersion(
          database,
          receipt,
        );
        const parsedVersion = ResourceVersionSchema.safeParse(resolvedVersion);
        if (!parsedVersion.success) {
          return reject(
            "HISTORY_UNVERIFIABLE",
            `${role} source history cannot resolve the Receipt revision`,
          );
        }
        const version = parsedVersion.data;
        if (
          version.sourceRevision !== receipt.sourceRevision ||
          version.valueHash !== receipt.valueHash ||
          version.validFromSeq > receipt.observedAtSeq ||
          (version.validUntilSeq !== null &&
            receipt.observedAtSeq >= version.validUntilSeq) ||
          receipt.observedAtSeq > database.headSeq ||
          version.validFromSeq > database.headSeq ||
          (version.validUntilSeq !== null &&
            database.headSeq >= version.validUntilSeq)
        ) {
          return reject(
            "HISTORY_UNVERIFIABLE",
            `${role} Receipt is not valid at the current World head`,
          );
        }

        const jvcInterval = requireSingle(
          jvc.intervals.filter((interval) => interval.receiptId === receipt.receiptId),
          "BINDING_MISMATCH",
          `${role} JVC interval must resolve exactly once`,
        );
        if (
          jvcInterval.source !== receipt.source ||
          jvcInterval.sourceRevision !== receipt.sourceRevision ||
          jvcInterval.from !== version.validFromSeq ||
          jvcInterval.until !== version.validUntilSeq
        ) {
          return reject(
            "BINDING_MISMATCH",
            `${role} JVC interval does not match authoritative history`,
          );
        }
        receiptIds.push(receipt.receiptId);
        intervalBounds.push({
          from: version.validFromSeq,
          until: version.validUntilSeq ?? database.headSeq + 1,
        });
      }

      if (new Set(receiptIds).size !== ROLES.length) {
        return reject("BINDING_MISMATCH", "active Decisions must use distinct Receipts");
      }
      if (
        new Set(attemptIds).size !== ROLES.length ||
        new Set(runIds).size !== ROLES.length
      ) {
        return reject(
          "DECISION_INVALID",
          "active Decisions must prove three distinct Attempts and Runs",
        );
      }
      const dependencySetHash = snapshotReceiptDependencySetHash(receiptIds);
      const lowerBound = Math.max(...intervalBounds.map((interval) => interval.from));
      const upperBound = Math.min(...intervalBounds.map((interval) => interval.until));
      if (
        dependencySetHash !== validation.dependencySetHash ||
        dependencySetHash !== jvc.dependencySetHash ||
        dependencySetHash !== permit.dependencySetHash ||
        validation.lowerBound !== lowerBound ||
        validation.upperBound !== upperBound ||
        lowerBound >= upperBound ||
        lowerBound > database.headSeq ||
        database.headSeq >= upperBound
      ) {
        return reject(
          "BINDING_MISMATCH",
          "dependency set or current-head interval intersection changed",
        );
      }

      const concurrentExisting = database.effects.find(
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          candidate.actionHash === expectedActionHash &&
          candidate.idempotencyKey === expectedIdempotencyKey,
      );
      if (concurrentExisting !== undefined) {
        const effect = EffectRecordSchema.parse(concurrentExisting);
        return {
          status: "COMMITTED",
          created: false,
          effect,
          effectsInSession: 1,
        };
      }

      const timestamp = TimestampSchema.parse(ports.now());
      const effect = EffectRecordSchema.parse({
        effectId: ports.createEffectId(),
        type: session.action.type,
        idempotencyKey: expectedIdempotencyKey,
        permitId: permit.permitId,
        sessionId: session.sessionId,
        actionHash: expectedActionHash,
        dependencySetHash,
        jointValidityCertificateId: jvc.certificateId,
        createdAt: timestamp,
      });
      if (
        database.effects.some(
          (candidate) => candidate.effectId === effect.effectId,
        )
      ) {
        return reject("BINDING_MISMATCH", "Effect ID factory returned a duplicate ID");
      }

      database.effects.push(effect);
      permitRecord.status = "CONSUMED";
      permitRecord.consumedAt = timestamp;
      session.state = "COMMITTED";
      session.sessionRevision += 1;
      session.stateUpdatedAt = timestamp;

      return {
        status: "COMMITTED",
        created: true,
        effect: structuredClone(effect),
        effectsInSession: 1,
      };
    });
  } catch (error) {
    if (error instanceof AbortEffectCommit) return error.result;
    throw error;
  }
}
