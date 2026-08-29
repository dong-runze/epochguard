import {
  AgentAttemptSchema,
  RefreshSessionRequestSchema,
  RefreshPlanSchema,
  ROLES,
  RunAssignmentSchema,
  TimestampSchema,
  buildRoleQuerySpec,
  makeAlreadyReobservingError,
  makeStaleViewError,
  type AgentAttempt,
  type AlreadyReobservingErrorBody,
  type EpochDatabase,
  type EpochSession,
  type RefreshPlan,
  type RefreshSessionRequest,
  type Role,
  type RunAssignment,
  type StaleViewErrorBody,
  type ValidationRecord,
} from "./types.js";

export interface RefreshEvidenceInterval {
  role: Role;
  agentId: string;
  from: number;
  until: number | null;
}

export interface BuildRefreshPlanInput {
  refreshPlanId: string;
  session: EpochSession;
  validation: ValidationRecord;
  evidence: readonly RefreshEvidenceInterval[];
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
  const { session, validation } = input;
  if (
    session.state !== "BLOCKED_NO_CUT" &&
    session.state !== "HISTORICAL_STALE"
  ) {
    return failInvariant("only blocked or historical-stale Sessions can plan refresh");
  }
  const expectedOutcome =
    session.state === "BLOCKED_NO_CUT"
      ? "NO_VALID_OBSERVED_WORLD_CUT"
      : "HISTORICAL_BUT_STALE_NOW";
  if (validation.outcome !== expectedOutcome) {
    return failInvariant("Validation outcome does not match the blocked Session state");
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
  input.evidence.forEach((interval) => {
    if (roleForAgent(session, interval.agentId) !== interval.role) {
      failInvariant("evidence owner does not match the frozen Role assignment");
    }
  });
  const agentIds = refreshSet(validation.validatedHead, input.evidence);
  if (agentIds.length === 0) {
    return failInvariant("a blocked RefreshPlan must contain at least one invalid owner");
  }
  requireP0BudgetOwner(session, agentIds);

  return RefreshPlanSchema.parse({
    refreshPlanId: input.refreshPlanId,
    sessionId: session.sessionId,
    baseSessionRevision: session.sessionRevision,
    validatedHead: validation.validatedHead,
    dependencySetHash: validation.dependencySetHash,
    activeDecisionCertificateIds,
    agentIds,
    status: "AVAILABLE",
    claimedAttemptId: null,
  });
}

function planStillMatches(
  database: EpochDatabase,
  session: EpochSession,
  plan: RefreshPlan,
): boolean {
  const activeDecisionIds = activeDecisionIdsOrNull(session);
  if (activeDecisionIds === null) return false;
  const validations = database.validations.filter(
    (candidate) => candidate.validationId === session.activeValidationId,
  );
  const validation = validations[0];
  const expectedOutcome =
    session.state === "BLOCKED_NO_CUT"
      ? "NO_VALID_OBSERVED_WORLD_CUT"
      : session.state === "HISTORICAL_STALE"
        ? "HISTORICAL_BUT_STALE_NOW"
        : null;
  return (
    expectedOutcome !== null &&
    session.activePermitId === null &&
    ROLES.every((role) => session.activeAttemptIds[role] === null) &&
    plan.sessionId === session.sessionId &&
    plan.baseSessionRevision === session.sessionRevision &&
    plan.validatedHead === database.headSeq &&
    sameOrderedIds(plan.activeDecisionCertificateIds, activeDecisionIds) &&
    validations.length === 1 &&
    validation !== undefined &&
    validation.sessionId === session.sessionId &&
    validation.actionHash === session.actionHash &&
    validation.outcome === expectedOutcome &&
    validation.validatedHead === plan.validatedHead &&
    validation.dependencySetHash === plan.dependencySetHash &&
    sameOrderedIds(validation.decisionCertificateIds, activeDecisionIds) &&
    validation.refreshPlanId === plan.refreshPlanId
  );
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

function assertClaimedAttempt(
  database: EpochDatabase,
  session: EpochSession,
  plan: RefreshPlan,
  agentId: string,
): string {
  if (plan.claimedAttemptId === null) {
    return failInvariant("CLAIMED RefreshPlan is missing claimedAttemptId");
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
  if (
    attempt.sessionId !== session.sessionId ||
    attempt.actionHash !== session.actionHash ||
    attempt.role !== "budget" ||
    attempt.agentId !== agentId ||
    assignment.sessionId !== session.sessionId ||
    assignment.actionHash !== session.actionHash ||
    assignment.role !== "budget" ||
    assignment.agentId !== agentId
  ) {
    return failInvariant(
      "CLAIMED RefreshPlan Attempt/Assignment does not match its Budget owner",
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
      const agentId = requireP0BudgetOwner(session, plan.agentIds);

      if (plan.status === "CLAIMED") {
        const claimedAttemptId = assertClaimedAttempt(
          database,
          session,
          plan,
          agentId,
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
        !planStillMatches(database, session, plan)
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
