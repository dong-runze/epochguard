import {
  AgentAttemptSchema,
  DependencyCertificateSchema,
  NoCutProofSchema,
  ObservationReceiptSchema,
  RefreshPlanSchema,
  RefreshSessionRequestSchema,
  ROLES,
  ResourceVersionSchema,
  RunAssignmentSchema,
  TimestampSchema,
  ValidationRecordSchema,
  buildRoleQuerySpec,
  canonicalJson,
  makeAlreadyReobservingError,
  makeStaleViewError,
  sha256Digest,
  snapshotReceiptDependencySetHash,
  type AgentAttempt,
  type AlreadyReobservingErrorBody,
  type EpochDatabase,
  type EpochSession,
  type ObservationReceipt,
  type RefreshPlan,
  type RefreshSessionRequest,
  type ResourceVersion,
  type Role,
  type RunAssignment,
  type StaleViewErrorBody,
} from "./types.js";

export interface RefreshEvidenceInterval {
  role: Role;
  agentId: string;
  from: number;
  until: number | null;
}

export interface RefreshPlannerWorldPort {
  resolveResourceVersion(
    database: Readonly<EpochDatabase>,
    receipt: Readonly<ObservationReceipt>,
  ): ResourceVersion | null;
}

export interface BuildRefreshPlanInput {
  refreshPlanId: string;
  sessionId: string;
  database: Readonly<EpochDatabase>;
  world: RefreshPlannerWorldPort;
}

export interface RefreshMutationPort {
  mutate<T>(
    mutation: (database: EpochDatabase) => T | Promise<T>,
  ): Promise<T>;
}

export interface RefreshClaimArtifacts {
  assignment: RunAssignment;
  attempt: AgentAttempt;
}

export interface RefreshClaimArtifactContext {
  session: EpochSession;
  plan: RefreshPlan;
  role: Role;
  agentId: string;
}

export interface ClaimRefreshPlanInput {
  sessionId: string;
  request: RefreshSessionRequest;
  now: string;
  world: RefreshPlannerWorldPort;
  createArtifacts(
    context: RefreshClaimArtifactContext,
  ): RefreshClaimArtifacts;
}

export type ClaimRefreshPlanResult =
  | {
      status: "CLAIMED";
      role: Role;
      agentId: string;
      plan: RefreshPlan;
      assignment: RunAssignment;
      attempt: AgentAttempt;
    }
  | {
      status: "ALREADY_REOBSERVING";
      error: AlreadyReobservingErrorBody;
    }
  | {
      status: "STALE_VIEW";
      error: StaleViewErrorBody;
    }
  | {
      status: "INVALIDATED";
      reasonCode: "UNSTABLE_WORLD";
      refreshPlanId: string;
      actualSessionRevision: number;
    };

class AbortRefreshClaim extends Error {
  constructor(readonly result: ClaimRefreshPlanResult) {
    super(result.status);
    this.name = "AbortRefreshClaim";
  }
}

function failInvariant(message: string): never {
  throw new Error(`EpochGuard Refresh Planner invariant failed: ${message}`);
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function activeDecisionIdsOrNull(
  session: EpochSession,
): [string, string, string] | null {
  const { inventory, budget, policy } = session.activeDecisionCertificateIds;
  if (inventory === null || budget === null || policy === null) {
    return null;
  }
  return [inventory, budget, policy];
}

function orderedActiveDecisionIds(session: EpochSession): [string, string, string] {
  return (
    activeDecisionIdsOrNull(session) ??
    failInvariant("all three active Decision IDs are required")
  );
}

function roleForAgent(session: EpochSession, agentId: string): Role {
  const matches = (
    [
      ["inventory", session.frozenAssignments.inventoryAgentId],
      ["budget", session.frozenAssignments.budgetAgentId],
      ["policy", session.frozenAssignments.policyAgentId],
    ] as const
  ).filter(([, frozenAgentId]) => frozenAgentId === agentId);
  if (matches.length !== 1) {
    return failInvariant("RefreshPlan owner must map to exactly one frozen Role");
  }
  return matches[0]![0];
}

function intervalContains(
  head: number,
  interval: RefreshEvidenceInterval,
): boolean {
  return (
    interval.from <= head &&
    (interval.until === null || head < interval.until)
  );
}

/**
 * Computes R_H for the frozen three-Role EpochGuard contract. Input order is
 * significant and must be inventory, budget, policy so the result remains
 * deterministic without introducing a second ordering rule.
 */
export function refreshSet(
  head: number,
  evidence: readonly RefreshEvidenceInterval[],
): string[] {
  if (!Number.isSafeInteger(head) || head < 0) {
    return failInvariant("head must be a non-negative safe integer");
  }
  if (evidence.length !== ROLES.length) {
    return failInvariant("exactly three Role evidence intervals are required");
  }
  const agentIds = new Set<string>();
  evidence.forEach((interval, index) => {
    if (interval.role !== ROLES[index]) {
      failInvariant("evidence must be ordered inventory, budget, policy");
    }
    if (agentIds.has(interval.agentId)) {
      failInvariant("each Role must have a distinct Agent owner");
    }
    agentIds.add(interval.agentId);
    if (!Number.isSafeInteger(interval.from) || interval.from < 0) {
      failInvariant("interval start must be a non-negative safe integer");
    }
    if (
      interval.until !== null &&
      (!Number.isSafeInteger(interval.until) || interval.until <= interval.from)
    ) {
      failInvariant("finite interval end must be greater than its start");
    }
  });
  return evidence
    .filter((interval) => !intervalContains(head, interval))
    .map((interval) => interval.agentId);
}

/**
 * Builds, but does not persist, the plan that the Validator and Store must
 * write in their shared mutation. No mutable browser field participates.
 */
export function buildRefreshPlan(input: BuildRefreshPlanInput): RefreshPlan {
  const sessions = input.database.sessions.filter(
    (candidate) => candidate.sessionId === input.sessionId,
  );
  if (sessions.length !== 1) {
    return failInvariant("Session ID must resolve exactly once");
  }
  const session = sessions[0]!;
  if (session.state === "HISTORICAL_STALE") {
    return failInvariant(
      "P0 cannot close HISTORICAL_STALE refresh provenance; a future contract upgrade is required",
    );
  }
  if (session.state !== "BLOCKED_NO_CUT") {
    return failInvariant("P0 only plans refresh for BLOCKED_NO_CUT Sessions");
  }
  if (
    session.activeValidationId === null ||
    session.activePermitId !== null ||
    !ROLES.every((role) => session.activeAttemptIds[role] === null)
  ) {
    return failInvariant(
      "blocked Session must have one active Validation and no Permit or in-flight Attempt",
    );
  }
  const validationRecords = input.database.validations.filter(
    (candidate) => candidate.validationId === session.activeValidationId,
  );
  if (validationRecords.length !== 1) {
    return failInvariant("active Validation must resolve exactly once");
  }
  const validation = ValidationRecordSchema.parse(validationRecords[0]);
  if (
    validation.outcome !== "NO_VALID_OBSERVED_WORLD_CUT" ||
    validation.noCutProofId === null ||
    validation.jointValidityCertificateId !== null ||
    validation.validatedHead !== input.database.headSeq
  ) {
    return failInvariant(
      "P0 requires a current NO_VALID_OBSERVED_WORLD_CUT Validation",
    );
  }
  if (
    validation.sessionId !== session.sessionId ||
    validation.actionHash !== session.actionHash ||
    session.activeValidationId !== validation.validationId
  ) {
    return failInvariant("Session and active Validation bindings do not match");
  }
  if (
    validation.refreshPlanId !== null &&
    validation.refreshPlanId !== input.refreshPlanId
  ) {
    return failInvariant("Validation is already bound to another RefreshPlan");
  }
  if (
    session.activeRefreshPlanId !== null &&
    session.activeRefreshPlanId !== input.refreshPlanId
  ) {
    return failInvariant("Session is already bound to another RefreshPlan");
  }

  const activeDecisionCertificateIds = orderedActiveDecisionIds(session);
  if (
    !sameOrderedIds(
      activeDecisionCertificateIds,
      validation.decisionCertificateIds,
    )
  ) {
    return failInvariant("Validation is not frozen to the active Decision tuple");
  }
  const receiptIds: string[] = [];
  const evidenceIntervals: Array<
    RefreshEvidenceInterval & { receiptId: string }
  > = [];
  for (const [index, role] of ROLES.entries()) {
    const decisionId = activeDecisionCertificateIds[index]!;
    const decisionRecords = input.database.decisions.filter(
      (candidate) => candidate.certificateId === decisionId,
    );
    if (decisionRecords.length !== 1) {
      return failInvariant(`active ${role} Decision must resolve exactly once`);
    }
    const decision = DependencyCertificateSchema.parse(decisionRecords[0]);
    if (
      decision.status !== "ACTIVE" ||
      decision.supersededByCertificateId !== null ||
      decision.sessionId !== session.sessionId ||
      decision.actionHash !== session.actionHash ||
      decision.role !== role ||
      roleForAgent(session, decision.agentId) !== role
    ) {
      return failInvariant(`active ${role} Decision binding is invalid`);
    }
    const receiptId = decision.receiptIds[0];
    const receiptRecords = input.database.receipts.filter(
      (candidate) => candidate.receiptId === receiptId,
    );
    if (receiptRecords.length !== 1) {
      return failInvariant(`active ${role} Receipt must resolve exactly once`);
    }
    const receipt = ObservationReceiptSchema.parse(receiptRecords[0]);
    if (
      receipt.sessionId !== session.sessionId ||
      receipt.actionHash !== session.actionHash ||
      receipt.agentId !== decision.agentId ||
      receipt.runAssignmentId !== decision.runAssignmentId ||
      receipt.role !== role ||
      receipt.source !== role ||
      receipt.observedAtSeq > validation.validatedHead
    ) {
      return failInvariant(`active ${role} Receipt binding is invalid`);
    }
    const parsedVersion = ResourceVersionSchema.safeParse(
      input.world.resolveResourceVersion(input.database, receipt),
    );
    if (!parsedVersion.success) {
      return failInvariant(
        `active ${role} Receipt history must resolve authoritatively`,
      );
    }
    const version = parsedVersion.data;
    if (
      version.sourceRevision !== receipt.sourceRevision ||
      version.valueHash !== receipt.valueHash ||
      version.valueHash !== sha256Digest(canonicalJson(version.value)) ||
      version.validFromSeq > receipt.observedAtSeq ||
      (version.validUntilSeq !== null &&
        receipt.observedAtSeq >= version.validUntilSeq)
    ) {
      return failInvariant(`active ${role} Receipt history is invalid`);
    }
    receiptIds.push(receiptId);
    evidenceIntervals.push({
      receiptId,
      role,
      agentId: decision.agentId,
      from: version.validFromSeq,
      until: version.validUntilSeq,
    });
  }
  if (new Set(receiptIds).size !== ROLES.length) {
    return failInvariant("active Decisions must bind three distinct Receipts");
  }
  const dependencySetHash = snapshotReceiptDependencySetHash(receiptIds);
  if (dependencySetHash !== validation.dependencySetHash) {
    return failInvariant("Validation dependency set is not derived from active Decisions");
  }

  const proofRecords = input.database.noCutProofs.filter(
    (candidate) => candidate.proofId === validation.noCutProofId,
  );
  if (proofRecords.length !== 1) {
    return failInvariant("Validation NoCutProof must resolve exactly once");
  }
  const proof = NoCutProofSchema.parse(proofRecords[0]);
  const receiptSet = new Set(receiptIds);
  const witnessSet = new Set(proof.conflictWitnessReceiptIds);
  const effectiveIntervals = evidenceIntervals.map((interval) => ({
    ...interval,
    until: interval.until ?? validation.validatedHead + 1,
  }));
  const lowerBound = Math.max(
    ...effectiveIntervals.map((interval) => interval.from),
  );
  const upperBound = Math.min(
    ...effectiveIntervals.map((interval) => interval.until),
  );
  const latestStartingReceiptId = effectiveIntervals
    .filter((interval) => interval.from === lowerBound)
    .map((interval) => interval.receiptId)
    .sort()[0]!;
  const earliestEndingReceiptId = effectiveIntervals
    .filter((interval) => interval.until === upperBound)
    .map((interval) => interval.receiptId)
    .sort()[0]!;
  if (
    proof.validationId !== validation.validationId ||
    proof.sessionId !== session.sessionId ||
    proof.actionHash !== session.actionHash ||
    proof.dependencySetHash !== dependencySetHash ||
    proof.validatedAtHead !== validation.validatedHead ||
    proof.lowerBound !== lowerBound ||
    proof.upperBound !== upperBound ||
    validation.lowerBound !== lowerBound ||
    validation.upperBound !== upperBound ||
    lowerBound < upperBound ||
    !sameOrderedIds(
      proof.decisionCertificateIds,
      activeDecisionCertificateIds,
    ) ||
    proof.latestStartingReceiptId !== latestStartingReceiptId ||
    proof.earliestEndingReceiptId !== earliestEndingReceiptId ||
    proof.latestStartingReceiptId === proof.earliestEndingReceiptId ||
    !receiptSet.has(latestStartingReceiptId) ||
    !receiptSet.has(earliestEndingReceiptId) ||
    witnessSet.size !== 2 ||
    !witnessSet.has(earliestEndingReceiptId) ||
    !witnessSet.has(latestStartingReceiptId)
  ) {
    return failInvariant(
      "NoCutProof does not close over the current Validation and active dependency set",
    );
  }
  requireP0BudgetOwner(session, proof.refreshAgentIds);
  const agentIds = refreshSet(validation.validatedHead, evidenceIntervals);
  requireP0BudgetOwner(session, agentIds);
  if (!sameOrderedIds(proof.refreshAgentIds, agentIds)) {
    return failInvariant(
      "NoCutProof refresh owners do not match authoritative Receipt intervals",
    );
  }

  return RefreshPlanSchema.parse({
    refreshPlanId: input.refreshPlanId,
    sessionId: session.sessionId,
    baseSessionRevision: session.sessionRevision,
    validatedHead: validation.validatedHead,
    dependencySetHash,
    activeDecisionCertificateIds,
    agentIds,
    status: "AVAILABLE",
    claimedAttemptId: null,
  });
}

function activeValidationBindsPlan(
  database: EpochDatabase,
  session: EpochSession,
  plan: RefreshPlan,
): boolean {
  const validationRecords = database.validations.filter(
    (candidate) => candidate.validationId === session.activeValidationId,
  );
  if (validationRecords.length !== 1) return false;
  const parsedValidation = ValidationRecordSchema.safeParse(
    validationRecords[0],
  );
  return (
    parsedValidation.success &&
    parsedValidation.data.sessionId === session.sessionId &&
    parsedValidation.data.refreshPlanId === plan.refreshPlanId &&
    parsedValidation.data.baseSessionRevision + 1 === plan.baseSessionRevision
  );
}

function planStillMatches(
  database: EpochDatabase,
  session: EpochSession,
  plan: RefreshPlan,
  world: RefreshPlannerWorldPort,
): boolean {
  try {
    if (
      plan.status !== "AVAILABLE" ||
      plan.claimedAttemptId !== null ||
      !activeValidationBindsPlan(database, session, plan)
    ) {
      return false;
    }
    const authoritative = buildRefreshPlan({
      refreshPlanId: plan.refreshPlanId,
      sessionId: session.sessionId,
      database,
      world,
    });
    return (
      plan.sessionId === authoritative.sessionId &&
      plan.baseSessionRevision === authoritative.baseSessionRevision &&
      plan.validatedHead === authoritative.validatedHead &&
      plan.dependencySetHash === authoritative.dependencySetHash &&
      sameOrderedIds(
        plan.activeDecisionCertificateIds,
        authoritative.activeDecisionCertificateIds,
      ) &&
      sameOrderedIds(plan.agentIds, authoritative.agentIds)
    );
  } catch {
    return false;
  }
}

function requireP0BudgetOwner(
  session: EpochSession,
  agentIds: readonly string[],
): string {
  if (
    agentIds.length !== 1 ||
    agentIds[0] !== session.frozenAssignments.budgetAgentId
  ) {
    return failInvariant(
      "P0 supports exactly one Budget refresh owner; other or multi-owner claim/bind requires a future contract upgrade",
    );
  }
  return agentIds[0];
}

function assertClaimArtifacts(
  database: EpochDatabase,
  session: EpochSession,
  role: Role,
  agentId: string,
  artifacts: RefreshClaimArtifacts,
): RefreshClaimArtifacts {
  const assignment = RunAssignmentSchema.parse(artifacts.assignment);
  const attempt = AgentAttemptSchema.parse(artifacts.attempt);
  const expectedQuery = buildRoleQuerySpec(session.action, role);
  if (
    assignment.sessionId !== session.sessionId ||
    assignment.actionHash !== session.actionHash ||
    assignment.agentId !== agentId ||
    assignment.role !== role ||
    assignment.status !== "CREATED" ||
    assignment.queryHash !== expectedQuery.queryHash ||
    assignment.boundRunId !== null ||
    assignment.boundAt !== null ||
    assignment.consumedAt !== null ||
    assignment.consumedByDecisionCertificateId !== null
  ) {
    return failInvariant("claim factory returned an invalid fresh Assignment");
  }
  if (
    attempt.sessionId !== session.sessionId ||
    attempt.actionHash !== session.actionHash ||
    attempt.agentId !== agentId ||
    attempt.role !== role ||
    attempt.assignmentId !== assignment.assignmentId ||
    attempt.status !== "ASSIGNMENT_CREATED" ||
    attempt.runId !== null ||
    attempt.runStartedAt !== null ||
    attempt.runCompletedAt !== null
  ) {
    return failInvariant("claim factory returned an invalid fresh Attempt");
  }
  if (
    database.runAssignments.some(
      (candidate) =>
        candidate.assignmentId === assignment.assignmentId ||
        candidate.receiptId === assignment.receiptId,
    ) ||
    database.receipts.some(
      (candidate) => candidate.receiptId === assignment.receiptId,
    ) ||
    database.attempts.some(
      (candidate) => candidate.attemptId === attempt.attemptId,
    )
  ) {
    return failInvariant("claim factory reused an Assignment or Attempt ID");
  }
  return { assignment, attempt };
}

function assertClaimedPlanClosure(
  database: EpochDatabase,
  session: EpochSession,
  plan: RefreshPlan,
  agentId: string,
  world: RefreshPlannerWorldPort,
): string {
  const parsedPlan = RefreshPlanSchema.safeParse(plan);
  if (!parsedPlan.success) {
    return failInvariant("CLAIMED RefreshPlan is malformed");
  }
  const activeClaimedState =
    session.state === "REOBSERVING" || session.state === "COLLECTING";
  const terminalClaimedState =
    session.state === "FAILED" || session.state === "INTERRUPTED";
  if (
    plan.status !== "CLAIMED" ||
    plan.claimedAttemptId === null ||
    plan.sessionId !== session.sessionId ||
    (!activeClaimedState && !terminalClaimedState) ||
    session.sessionRevision <= plan.baseSessionRevision ||
    session.activeRefreshPlanId !== plan.refreshPlanId ||
    session.activePermitId !== null ||
    session.activeAttemptIds.inventory !== null ||
    session.activeAttemptIds.budget !== plan.claimedAttemptId ||
    session.activeAttemptIds.policy !== null ||
    database.headSeq !== plan.validatedHead ||
    !activeValidationBindsPlan(database, session, plan)
  ) {
    return failInvariant(
      "CLAIMED RefreshPlan does not close over an allowed Session state, active pointers, and post-CAS revision",
    );
  }

  const planningDatabase = structuredClone(database);
  const planningSessions = planningDatabase.sessions.filter(
    (candidate) => candidate.sessionId === session.sessionId,
  );
  if (planningSessions.length !== 1) {
    return failInvariant("CLAIMED RefreshPlan Session must resolve exactly once");
  }
  const planningSession = planningSessions[0]!;
  planningSession.state = "BLOCKED_NO_CUT";
  planningSession.sessionRevision = plan.baseSessionRevision;
  planningSession.activeAttemptIds = {
    inventory: null,
    budget: null,
    policy: null,
  };
  const authoritative = buildRefreshPlan({
    refreshPlanId: plan.refreshPlanId,
    sessionId: session.sessionId,
    database: planningDatabase,
    world,
  });
  if (
    plan.baseSessionRevision !== authoritative.baseSessionRevision ||
    plan.validatedHead !== authoritative.validatedHead ||
    plan.dependencySetHash !== authoritative.dependencySetHash ||
    !sameOrderedIds(
      plan.activeDecisionCertificateIds,
      authoritative.activeDecisionCertificateIds,
    ) ||
    !sameOrderedIds(plan.agentIds, authoritative.agentIds)
  ) {
    return failInvariant(
      "CLAIMED RefreshPlan no longer matches its frozen head, dependency, Decisions, or NoCutProof",
    );
  }

  const attempts = database.attempts.filter(
    (candidate) => candidate.attemptId === plan.claimedAttemptId,
  );
  if (attempts.length !== 1) {
    return failInvariant("CLAIMED RefreshPlan must resolve exactly one Attempt");
  }
  const attempt = AgentAttemptSchema.parse(attempts[0]);
  const assignments = database.runAssignments.filter(
    (candidate) => candidate.assignmentId === attempt.assignmentId,
  );
  if (assignments.length !== 1) {
    return failInvariant("claimed Attempt must resolve exactly one Assignment");
  }
  const assignment = RunAssignmentSchema.parse(assignments[0]);
  const assignmentAttempts = database.attempts.filter(
    (candidate) => candidate.assignmentId === assignment.assignmentId,
  );
  const activeAttemptStates = [
    "ASSIGNMENT_CREATED",
    "DISPATCHING",
    "QUEUED",
    "RUNNING",
  ] as const;
  const terminalAttemptStates = [
    "FAILED",
    "INTERRUPTED",
    "OUTPUT_REJECTED",
  ] as const;
  const attemptLifecycleMatchesSession = activeClaimedState
    ? (activeAttemptStates as readonly string[]).includes(attempt.status)
    : (terminalAttemptStates as readonly string[]).includes(attempt.status);
  const unboundAssignment =
    assignment.boundRunId === null &&
    assignment.boundAt === null &&
    attempt.runId === null &&
    (assignment.status === "CREATED" ||
      (terminalClaimedState && assignment.status === "REJECTED"));
  const boundAssignment =
    assignment.boundRunId !== null &&
    assignment.boundAt !== null &&
    attempt.runId === assignment.boundRunId &&
    (assignment.status === "BOUND" ||
      (terminalClaimedState && assignment.status === "REJECTED"));
  if (
    assignmentAttempts.length !== 1 ||
    attempt.sessionId !== session.sessionId ||
    attempt.actionHash !== session.actionHash ||
    attempt.role !== "budget" ||
    attempt.agentId !== agentId ||
    attempt.assignmentId !== assignment.assignmentId ||
    (attempt.status === "ACCEPTED" && attempt.outputDigest === null) ||
    assignment.sessionId !== session.sessionId ||
    assignment.actionHash !== session.actionHash ||
    assignment.role !== "budget" ||
    assignment.agentId !== agentId ||
    assignment.queryHash !==
      buildRoleQuerySpec(session.action, "budget").queryHash ||
    assignment.consumedAt !== null ||
    assignment.consumedByDecisionCertificateId !== null ||
    !attemptLifecycleMatchesSession ||
    (!unboundAssignment && !boundAssignment)
  ) {
    return failInvariant(
      "CLAIMED RefreshPlan Attempt/Assignment lifecycle, owner, or Run binding is invalid for the Session state",
    );
  }
  return attempt.attemptId;
}

/**
 * Atomically claims the one explicit P0 re-observation. The returned Attempt is
 * the sole authorization for EG-08/EG-06 to dispatch; this module never calls an
 * Agent and never waits for model work while holding the Store mutation.
 */
export async function claimRefreshPlan(
  store: RefreshMutationPort,
  input: ClaimRefreshPlanInput,
): Promise<ClaimRefreshPlanResult> {
  const timestamp = TimestampSchema.parse(input.now);
  const request = RefreshSessionRequestSchema.parse(input.request);
  try {
    return await store.mutate((database) => {
      const sessions = database.sessions.filter(
        (candidate) => candidate.sessionId === input.sessionId,
      );
      if (sessions.length === 0) {
        return failInvariant("Session does not exist");
      }
      if (sessions.length !== 1) {
        return failInvariant("Session ID must resolve exactly once");
      }
      const session = sessions[0]!;
      const sessionPlans = database.refreshPlans.filter(
        (candidate) => candidate.sessionId === session.sessionId,
      );
      const matchingPlans = sessionPlans.filter(
        (candidate) =>
          candidate.refreshPlanId === request.refreshPlanId &&
          candidate.sessionId === session.sessionId,
      );
      if (matchingPlans.length === 0) {
        return failInvariant("RefreshPlan does not exist for this Session");
      }
      if (matchingPlans.length !== 1) {
        return failInvariant("RefreshPlan ID must resolve exactly once");
      }
      if (sessionPlans.length !== 1) {
        return failInvariant(
          "P0 supports only one explicit Budget RefreshPlan per Session",
        );
      }
      const plan = matchingPlans[0]!;
      if (plan.status === "COMPLETED" || plan.status === "INVALIDATED") {
        throw new AbortRefreshClaim({
          status: "STALE_VIEW",
          error: makeStaleViewError(
            session.sessionId,
            request.expectedSessionRevision,
            session.sessionRevision,
          ),
        });
      }
      const agentId = requireP0BudgetOwner(session, plan.agentIds);

      if (plan.status === "CLAIMED") {
        const claimedAttemptId = assertClaimedPlanClosure(
          database,
          session,
          plan,
          agentId,
          input.world,
        );
        throw new AbortRefreshClaim({
          status: "ALREADY_REOBSERVING",
          error: makeAlreadyReobservingError(
            session.sessionId,
            plan.refreshPlanId,
            claimedAttemptId,
          ),
        });
      }
      if (request.expectedSessionRevision !== session.sessionRevision) {
        throw new AbortRefreshClaim({
          status: "STALE_VIEW",
          error: makeStaleViewError(
            session.sessionId,
            request.expectedSessionRevision,
            session.sessionRevision,
          ),
        });
      }
      if (
        plan.status !== "AVAILABLE" ||
        session.activeRefreshPlanId !== plan.refreshPlanId ||
        !planStillMatches(database, session, plan, input.world)
      ) {
        plan.status = "INVALIDATED";
        plan.claimedAttemptId = null;
        session.activeRefreshPlanId = null;
        session.activePermitId = null;
        session.state = "UNSTABLE_WORLD";
        session.sessionRevision += 1;
        session.stateUpdatedAt = timestamp;
        return {
          status: "INVALIDATED",
          reasonCode: "UNSTABLE_WORLD",
          refreshPlanId: plan.refreshPlanId,
          actualSessionRevision: session.sessionRevision,
        };
      }
      const role = roleForAgent(session, agentId);
      if (session.activeAttemptIds[role] !== null) {
        return failInvariant("Refresh owner already has an active Attempt");
      }
      const artifacts = assertClaimArtifacts(
        database,
        session,
        role,
        agentId,
        input.createArtifacts({
          session: structuredClone(session),
          plan: structuredClone(plan),
          role,
          agentId,
        }),
      );

      database.runAssignments.push(artifacts.assignment);
      database.attempts.push(artifacts.attempt);
      plan.status = "CLAIMED";
      plan.claimedAttemptId = artifacts.attempt.attemptId;
      session.activeAttemptIds[role] = artifacts.attempt.attemptId;
      session.state = "REOBSERVING";
      session.sessionRevision += 1;
      session.stateUpdatedAt = timestamp;

      return {
        status: "CLAIMED",
        role,
        agentId,
        plan: structuredClone(plan),
        assignment: structuredClone(artifacts.assignment),
        attempt: structuredClone(artifacts.attempt),
      };
    });
  } catch (error) {
    if (error instanceof AbortRefreshClaim) return error.result;
    throw error;
  }
}
