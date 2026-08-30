import { randomBytes, randomUUID } from "node:crypto";
import type { AgentService } from "../agent-service.js";
import type { WorkspaceManager } from "../workspace.js";
import {
  normalizeAndConsumeDecision,
  type DecisionNormalizationResult,
} from "./decision-parser.js";
import {
  commitProtectedEffect,
  type CommitProtectedEffectResult,
} from "./effect-gate.js";
import {
  EvidencePackWriter,
  buildCanonicalEvidencePack,
  evidencePackRelativePath,
} from "./evidence-pack-writer.js";
import { EpochStore } from "./epoch-store.js";
import {
  applyFixtureCommit,
  buildFixtureActionIntent,
  getEpochGuardFixture,
  initializeFixtureWorld,
  type EpochGuardFixture,
} from "./fixtures.js";
import { validateJointValidity } from "./joint-validity-validator.js";
import { ReceiptIssuer, resolveReceiptResourceVersion } from "./receipt-issuer.js";
import {
  buildRefreshPlan,
  claimRefreshPlan,
  type ClaimRefreshPlanResult,
  type RefreshPlannerWorldPort,
} from "./refresh-planner.js";
import {
  ROLE_PROFILES,
  RoleProfileMismatchError,
  initialAttemptForAssignment,
  initializeRoleAgents,
  verifyRoleAgentProfile,
  type AgentPort,
  type RoleProfilePorts,
  type WorkspacePort,
} from "./role-profiles.js";
import {
  deriveCoordinationMode,
  dispatchBindPoll,
  joinRoleRunObservations,
  RunAdapterError,
  type DispatchBindPollInput,
  type RunObserverOptions,
  type TerminalRunObservation,
} from "./run-observer.js";
import { buildSafetyDiagnostic } from "./safety-diagnostics.js";
import {
  SessionViewBuilder,
  SessionViewBuilderError,
} from "./session-view-builder.js";
import {
  API_ERROR_STATUS,
  AgentAttemptSchema,
  ApiErrorBodySchema,
  AuditEventSchema,
  CommitSessionRequestSchema,
  CreateSessionRequestSchema,
  EffectPermitSchema,
  EpochSessionSchema,
  OpaqueIdSchema,
  ROLES,
  RefreshSessionRequestSchema,
  RoleQuerySpecSchema,
  RunAssignmentSchema,
  TimestampSchema,
  canonicalJson,
  makeAgentsBusyError,
  makeAlreadyReobservingError,
  makeProjectionMismatchError,
  makeRoleProfileMismatchError,
  makeSessionNotFoundError,
  makeStaleViewError,
  makeUnstableWorldError,
  makeUnsupportedSchemaError,
  sha256Digest,
  type ApiErrorBody,
  type AgentAttempt,
  type ArtifactRef,
  type CommitSessionRequest,
  type CreateSessionRequest,
  type EffectRecord,
  type EpochDatabase,
  type EpochSession,
  type FailureCode,
  type ObservationReceipt,
  type RefreshPlan,
  type RefreshSessionRequest,
  type Role,
  type RoleAgentRegistration,
  type RunAssignment,
  type SafetyDiagnostic,
  type SessionDashboardSnapshot,
} from "./types.js";
import {
  WorldLedger,
  resolveResourceVersionByIdentity,
} from "./world-ledger.js";

const PROMPT_TEMPLATE_VERSION = "epoch-prompt-v1";
const EMPTY_PACK_HASH = sha256Digest("");

const TERMINAL_SESSION_STATES = new Set<EpochSession["state"]>([
  "UNSTABLE_WORLD",
  "CONSISTENT_DENY",
  "COMMIT_RACE",
  "COMMITTED",
  "FAILED",
  "INTERRUPTED",
]);

const IN_FLIGHT_SESSION_STATES = new Set<EpochSession["state"]>([
  "CREATED",
  "DISPATCHING",
  "COLLECTING",
  "VALIDATING",
  "REOBSERVING",
  "COMMITTING",
]);

const TERMINAL_ATTEMPT_STATES = new Set<AgentAttempt["status"]>([
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "OUTPUT_REJECTED",
  "ACCEPTED",
]);

const BACKGROUND_FAILURE_PERSISTENCE_FAILED =
  "BACKGROUND_FAILURE_PERSISTENCE_FAILED" as const;

type RuntimeAgentPort = AgentPort &
  Pick<AgentService, "systemInfo">;
type RuntimeWorkspacePort = WorkspacePort &
  Pick<WorkspaceManager, "writeEvidencePackAtomic">;

export interface EpochGuardServicePorts {
  store: EpochStore;
  agents: RuntimeAgentPort;
  workspaces: RuntimeWorkspacePort;
}

export interface EpochGuardServiceOptions {
  now?: () => string;
  monotonicMs?: () => number;
  createId?: (prefix: string) => string;
  nonceFactory?: () => string;
  runObserver?: RunObserverOptions;
  onBackgroundFailure?: (
    report: Readonly<{
      code: typeof BACKGROUND_FAILURE_PERSISTENCE_FAILED;
      sessionId: string;
    }>,
  ) => void | Promise<void>;
}

export class EpochGuardServiceError extends Error {
  readonly body: ApiErrorBody;

  constructor(
    readonly statusCode: number,
    body: ApiErrorBody,
  ) {
    const parsed = ApiErrorBodySchema.parse(body);
    super(parsed.message);
    this.body = Object.freeze(parsed);
    this.name = "EpochGuardServiceError";
  }
}

type PreparedPack = {
  assignmentId: string;
};

type ValidationContext = {
  refreshPlan: RefreshPlan | null;
};

type RefreshFailureClosure = {
  handled: boolean;
  attempt: AgentAttempt | null;
};

function roleRegistration(
  database: Readonly<EpochDatabase>,
  role: Role,
): RoleAgentRegistration {
  const matches = database.roleAgentRegistrations.filter(
    (registration) => registration.role === role,
  );
  if (matches.length !== 1) {
    throw new Error(`Role ${role} must have exactly one registration`);
  }
  return structuredClone(matches[0]!);
}

function sessionById(
  database: Readonly<EpochDatabase>,
  sessionId: string,
): EpochSession | null {
  const matches = database.sessions.filter(
    (session) => session.sessionId === sessionId,
  );
  if (matches.length > 1) {
    throw new Error("EpochGuard Session ID is not unique");
  }
  return matches[0] ?? null;
}

function sameAssignments(
  session: EpochSession,
  assignments: CreateSessionRequest["assignments"],
): boolean {
  return (
    session.frozenAssignments.inventoryAgentId === assignments.inventory &&
    session.frozenAssignments.budgetAgentId === assignments.budget &&
    session.frozenAssignments.policyAgentId === assignments.policy
  );
}

function frozenAssignments(
  session: EpochSession,
): CreateSessionRequest["assignments"] {
  return {
    inventory: session.frozenAssignments.inventoryAgentId,
    budget: session.frozenAssignments.budgetAgentId,
    policy: session.frozenAssignments.policyAgentId,
  };
}

function nextAuditSeq(database: Readonly<EpochDatabase>, sessionId: string): number {
  const values = [
    ...database.auditEvents
      .filter((event) => event.sessionId === sessionId)
      .map((event) => event.auditSeq),
    ...database.diagnostics
      .filter((diagnostic) => diagnostic.sessionId === sessionId)
      .map((diagnostic) => diagnostic.auditSeq),
  ];
  return values.length === 0 ? 1 : Math.max(...values) + 1;
}

export class EpochGuardService {
  private readonly now: () => string;
  private readonly monotonicMs: () => number;
  private readonly createId: (prefix: string) => string;
  private readonly runObserver: RunObserverOptions;
  private readonly rolePorts: RoleProfilePorts;
  private readonly ledger: WorldLedger;
  private readonly issuer: ReceiptIssuer;
  private readonly packWriter: EvidencePackWriter;
  private readonly viewBuilder: SessionViewBuilder;
  private readonly onBackgroundFailure: NonNullable<
    EpochGuardServiceOptions["onBackgroundFailure"]
  >;
  private readonly backgroundTasks = new Map<string, Promise<void>>();
  private initializePromise: Promise<void> | null = null;
  private initialized = false;

  private readonly worldPort: RefreshPlannerWorldPort = {
    resolveResourceVersion: (database, receipt) =>
      resolveResourceVersionByIdentity(
        database,
        receipt.source,
        receipt.entityKey,
        receipt.sourceRevision,
      ) ?? null,
  };

  constructor(
    private readonly ports: EpochGuardServicePorts,
    options: EpochGuardServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.monotonicMs = options.monotonicMs ?? (() => performance.now());
    this.createId =
      options.createId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.runObserver = options.runObserver ?? {};
    this.onBackgroundFailure =
      options.onBackgroundFailure ??
      ((report) => {
        console.error(`[${report.code}] ${report.sessionId}`);
      });
    this.rolePorts = {
      agents: ports.agents,
      store: ports.store,
      workspaces: ports.workspaces,
    };
    this.ledger = new WorldLedger({ now: this.now });
    this.issuer = new ReceiptIssuer({
      now: this.now,
      nonceFactory:
        options.nonceFactory ?? (() => randomBytes(32).toString("base64url")),
    });
    this.packWriter = new EvidencePackWriter(ports.workspaces);
    this.viewBuilder = new SessionViewBuilder(ports.store, this.now);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise !== null) return this.initializePromise;
    this.initializePromise = this.initializeUnlocked().finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  private async initializeUnlocked(): Promise<void> {
    await this.ports.store.initialize();
    const inFlight = this.ports.store
      .snapshot()
      .sessions.some((session) => IN_FLIGHT_SESSION_STATES.has(session.state));
    if (inFlight) {
      const timestamp = TimestampSchema.parse(this.now());
      await this.ports.store.mutate((database) => {
        for (const session of database.sessions) {
          if (!IN_FLIGHT_SESSION_STATES.has(session.state)) continue;
          this.recoverInFlightSession(database, session, timestamp);
        }
      });
    }
    try {
      await initializeRoleAgents(this.rolePorts, this.now);
    } catch (error) {
      if (error instanceof RoleProfileMismatchError) {
        const registrations = this.ports.store.snapshot().roleAgentRegistrations;
        for (const role of ROLES) {
          const matches = registrations.filter(
            (registration) => registration.role === role,
          );
          if (matches.length === 1) {
            await this.verifyRegisteredRoleProfile(role, matches[0]!);
          }
        }
      }
      throw error;
    }
    this.initialized = true;
  }

  private recoverInFlightSession(
    database: EpochDatabase,
    session: EpochSession,
    timestamp: string,
  ): void {
    const referencedAttempts = ROLES.flatMap((role) => {
      const attemptId = session.activeAttemptIds[role];
      return attemptId === null ? [] : [{ role, attemptId }];
    });
    const referencedAttemptIds = new Set(
      referencedAttempts.map(({ attemptId }) => attemptId),
    );
    if (referencedAttemptIds.size !== referencedAttempts.length) {
      throw new Error("In-flight Session references a duplicate active Attempt");
    }

    const expectedAssignments = frozenAssignments(session);
    for (const { role, attemptId } of referencedAttempts) {
      const attempts = database.attempts.filter(
        (candidate) => candidate.attemptId === attemptId,
      );
      if (attempts.length !== 1) {
        throw new Error("In-flight Session active Attempt is missing or duplicated");
      }
      const attempt = attempts[0]!;
      const expectedAgentId = expectedAssignments[role];
      if (
        attempt.sessionId !== session.sessionId ||
        attempt.actionHash !== session.actionHash ||
        attempt.role !== role ||
        attempt.agentId !== expectedAgentId
      ) {
        throw new Error("In-flight Session active Attempt binding is invalid");
      }

      const assignments = database.runAssignments.filter(
        (candidate) => candidate.assignmentId === attempt.assignmentId,
      );
      if (assignments.length !== 1) {
        throw new Error(
          "In-flight Session active Assignment is missing or duplicated",
        );
      }
      const assignment = assignments[0]!;
      if (
        assignment.sessionId !== session.sessionId ||
        assignment.actionHash !== session.actionHash ||
        assignment.role !== role ||
        assignment.agentId !== expectedAgentId ||
        assignment.assignmentId !== attempt.assignmentId ||
        assignment.boundRunId !== attempt.runId
      ) {
        throw new Error("In-flight Session active Assignment binding is invalid");
      }
      const unconsumed =
        assignment.consumedByDecisionCertificateId === null &&
        assignment.consumedAt === null;
      const consumed =
        assignment.consumedByDecisionCertificateId !== null &&
        assignment.consumedAt !== null;
      if (assignment.status === "CREATED") {
        if (
          !unconsumed ||
          assignment.boundRunId !== null ||
          assignment.boundAt !== null
        ) {
          throw new Error("Created active Assignment has an invalid timeline");
        }
        assignment.status = "REJECTED";
      } else if (assignment.status === "BOUND") {
        if (
          !unconsumed ||
          assignment.boundRunId === null ||
          assignment.boundAt === null
        ) {
          throw new Error("Bound active Assignment has an invalid timeline");
        }
        assignment.status = "REJECTED";
      } else if (
        assignment.status === "CONSUMED" &&
        (!consumed ||
          assignment.boundRunId === null ||
          assignment.boundAt === null ||
          attempt.status !== "ACCEPTED")
      ) {
        throw new Error("Consumed active Assignment is not backed by acceptance");
      } else if (assignment.status === "REJECTED") {
        if (
          !unconsumed ||
          (assignment.boundRunId === null) !== (assignment.boundAt === null)
        ) {
          throw new Error("Rejected active Assignment has an invalid timeline");
        }
      }

      if (!TERMINAL_ATTEMPT_STATES.has(attempt.status)) {
        attempt.status = "INTERRUPTED";
        if (attempt.runId !== null) {
          attempt.runCompletedAt =
            attempt.runStartedAt !== null &&
            Date.parse(attempt.runStartedAt) > Date.parse(timestamp)
              ? attempt.runStartedAt
              : timestamp;
        }
      }
      AgentAttemptSchema.parse(attempt);
      RunAssignmentSchema.parse(assignment);
    }

    if (session.activeValidationId !== null) {
      const validations = database.validations.filter(
        (candidate) =>
          candidate.validationId === session.activeValidationId,
      );
      if (
        validations.length !== 1 ||
        validations[0]!.sessionId !== session.sessionId ||
        validations[0]!.actionHash !== session.actionHash
      ) {
        throw new Error("In-flight Session active Validation binding is invalid");
      }
    }

    if (session.activeRefreshPlanId !== null) {
      const plans = database.refreshPlans.filter(
        (candidate) =>
          candidate.refreshPlanId === session.activeRefreshPlanId,
      );
      if (plans.length !== 1 || plans[0]!.sessionId !== session.sessionId) {
        throw new Error("In-flight Session active RefreshPlan binding is invalid");
      }
      const plan = plans[0]!;
      if (plan.status !== "CLAIMED") {
        throw new Error("In-flight Session active RefreshPlan is not CLAIMED");
      }
      if (
        plan.claimedAttemptId === null ||
        !referencedAttemptIds.has(plan.claimedAttemptId)
      ) {
        throw new Error("Claimed RefreshPlan has no active owner Attempt");
      }
      plan.status = "INVALIDATED";
      plan.claimedAttemptId = null;
    }

    if (session.activePermitId !== null) {
      const permits = database.permits.filter(
        (candidate) => candidate.permitId === session.activePermitId,
      );
      if (
        permits.length !== 1 ||
        permits[0]!.sessionId !== session.sessionId ||
        permits[0]!.actionHash !== session.actionHash
      ) {
        throw new Error("In-flight Session active Permit binding is invalid");
      }
      if (permits[0]!.status !== "ISSUED") {
        throw new Error("In-flight Session active Permit is not ISSUED");
      }
      permits[0]!.status = "REVOKED";
      permits[0]!.consumedAt = null;
    }

    session.activeAttemptIds = {
      inventory: null,
      budget: null,
      policy: null,
    };
    session.activeValidationId = null;
    session.activeRefreshPlanId = null;
    session.activePermitId = null;
    session.state = "INTERRUPTED";
    session.sessionRevision += 1;
    session.stateUpdatedAt = timestamp;
    this.appendDiagnostic(database, session, {
      kind: "SYSTEM_FAILURE",
      stage: "DISPATCH",
      reasonCode: "RUN_FAILED",
      role: null,
      attemptId: null,
      assignmentId: null,
      runId: null,
      artifactRefs: [],
      rejectedOutputArtifactId: null,
      recommendedAction: "NEW_SESSION",
    });
    this.appendEvent(database, session, "SESSION_STATE", "INTERRUPTED", []);
  }

  async createSession(
    requestInput: CreateSessionRequest,
  ): Promise<SessionDashboardSnapshot> {
    await this.initialize();
    const request = CreateSessionRequestSchema.parse(requestInput);
    const verified = await this.verifyRequestedAgents(request);
    const runtimeLabel = await this.runtimeLabel();
    const sessionId = this.createOpaqueId("session");
    const actionId = this.createOpaqueId("action");
    const timestamp = TimestampSchema.parse(this.now());
    const fixture = getEpochGuardFixture(request.scenarioId);

    let prepared: PreparedPack[];
    try {
      prepared = await this.ports.store.mutate((database) => {
        const conflicting = database.sessions.find(
          (session) =>
            !TERMINAL_SESSION_STATES.has(session.state) &&
            sameAssignments(session, request.assignments),
        );
        if (conflicting !== undefined) {
          throw new EpochGuardServiceError(
            API_ERROR_STATUS.AGENTS_BUSY,
            makeAgentsBusyError(
              conflicting.sessionId,
              frozenAssignments(conflicting),
            ),
          );
        }
        if (
          database.headSeq !== 0 ||
          database.worldCommits.length !== 0 ||
          database.resourceVersions.length !== 0
        ) {
          throw new EpochGuardServiceError(
            API_ERROR_STATUS.UNSTABLE_WORLD,
            makeUnstableWorldError(null, database.headSeq),
          );
        }

        initializeFixtureWorld(database, fixture);
        const action = buildFixtureActionIntent(
          request.scenarioId,
          sessionId,
          actionId,
        );
        for (const role of ROLES) {
          const query = fixture.querySpecs[role];
          const existing = database.roleQuerySpecs.filter(
            (candidate) => candidate.queryHash === query.queryHash,
          );
          if (existing.length === 0) {
            database.roleQuerySpecs.push(structuredClone(query));
          } else if (
            existing.some(
              (candidate) => canonicalJson(candidate) !== canonicalJson(query),
            )
          ) {
            throw new Error("Stored RoleQuerySpec conflicts with the fixture contract");
          }
        }

        const session = EpochSessionSchema.parse({
          sessionId,
          scenarioId: request.scenarioId,
          action,
          actionHash: action.actionHash,
          state: "DISPATCHING",
          sessionRevision: 1,
          coordinationMode: "PENDING",
          frozenAssignments: {
            inventoryAgentId: request.assignments.inventory,
            budgetAgentId: request.assignments.budget,
            policyAgentId: request.assignments.policy,
          },
          activeDecisionCertificateIds: {
            inventory: null,
            budget: null,
            policy: null,
          },
          activeAttemptIds: {
            inventory: null,
            budget: null,
            policy: null,
          },
          activeValidationId: null,
          activeRefreshPlanId: null,
          activePermitId: null,
          stateUpdatedAt: timestamp,
          createdAt: timestamp,
        });
        database.sessions.push(session);

        const packs: PreparedPack[] = [];
        for (const step of fixture.initialSteps) {
          if (step.kind === "commit") {
            applyFixtureCommit(database, this.ledger, step);
            continue;
          }
          if (database.headSeq !== step.expectedHeadSeq) {
            throw new Error("Fixture capture is not at its declared World head");
          }
          const role = step.role;
          const registration = verified[role];
          const assignment = this.newAssignment({
            session,
            role,
            registration,
            runtimeLabel,
            createdAt: timestamp,
          });
          const attempt = initialAttemptForAssignment(
            assignment,
            this.createOpaqueId("attempt"),
          );
          database.runAssignments.push(assignment);
          database.attempts.push(attempt);
          session.activeAttemptIds[role] = attempt.attemptId;
          const issued = this.issuer.issue(database, {
            action: session.action,
            assignment,
            querySpec: fixture.querySpecs[role],
          });
          const built = buildCanonicalEvidencePack({
            action: session.action,
            querySpec: fixture.querySpecs[role],
            assignment,
            receipt: issued.receipt,
            resourceVersion: issued.resourceVersion,
            worldHeadSeq: database.headSeq,
          });
          assignment.evidencePackHash = built.evidencePackHash;
          RunAssignmentSchema.parse(assignment);
          packs.push({ assignmentId: assignment.assignmentId });
        }
        if (packs.length !== ROLES.length) {
          throw new Error("Fixture must capture exactly three initial Role observations");
        }
        this.appendEvent(database, session, "SESSION_STATE", "DISPATCHING", []);
        return packs;
      });
    } catch (error) {
      if (error instanceof EpochGuardServiceError) throw error;
      throw error;
    }

    const snapshot = this.getSnapshot(sessionId);
    this.scheduleInitialContinuation(sessionId, prepared);
    return snapshot;
  }

  getSnapshot(sessionIdInput: string): SessionDashboardSnapshot {
    const sessionId = OpaqueIdSchema.parse(sessionIdInput);
    try {
      return this.viewBuilder.build(sessionId);
    } catch (error) {
      if (!(error instanceof SessionViewBuilderError)) throw error;
      if (error.code === "SESSION_NOT_FOUND") {
        throw new EpochGuardServiceError(
          API_ERROR_STATUS.SESSION_NOT_FOUND,
          makeSessionNotFoundError(sessionId),
        );
      }
      if (error.code === "UNSUPPORTED_SCHEMA") {
        throw new EpochGuardServiceError(
          API_ERROR_STATUS.UNSUPPORTED_SCHEMA,
          makeUnsupportedSchemaError(null, null),
        );
      }
      throw new EpochGuardServiceError(
        API_ERROR_STATUS.PROJECTION_MISMATCH,
        makeProjectionMismatchError(sessionId, error.snapshotRevision ?? 0),
      );
    }
  }

  async refresh(
    sessionIdInput: string,
    requestInput: RefreshSessionRequest,
  ): Promise<SessionDashboardSnapshot> {
    await this.initialize();
    const sessionId = OpaqueIdSchema.parse(sessionIdInput);
    const request = RefreshSessionRequestSchema.parse(requestInput);
    const before = this.requireSession(sessionId);
    const fixture = getEpochGuardFixture(before.scenarioId);
    if (fixture.refreshCapture === null) {
      throw new EpochGuardServiceError(
        API_ERROR_STATUS.UNSTABLE_WORLD,
        makeUnstableWorldError(sessionId, this.ports.store.snapshot().headSeq),
      );
    }
    const registration = roleRegistration(this.ports.store.snapshot(), "budget");
    await this.verifyRegisteredRoleProfile(
      "budget",
      registration,
      before.frozenAssignments.budgetAgentId,
    );
    const runtimeLabel = await this.runtimeLabel();
    const timestamp = TimestampSchema.parse(this.now());
    const claim = await claimRefreshPlan(this.ports.store, {
      sessionId,
      request,
      now: timestamp,
      world: this.worldPort,
      createArtifacts: ({ session, role, agentId }) => {
        if (role !== registration.role || registration.agentId !== agentId) {
          throw new Error("Refresh owner does not match the registered Role Agent");
        }
        const assignment = this.newAssignment({
          session,
          role,
          registration,
          runtimeLabel,
          createdAt: timestamp,
        });
        return {
          assignment,
          attempt: initialAttemptForAssignment(
            assignment,
            this.createOpaqueId("attempt"),
          ),
        };
      },
    });
    this.throwClaimError(sessionId, request, claim);
    if (claim.status === "INVALIDATED") return this.getSnapshot(sessionId);
    if (claim.status !== "CLAIMED") {
      throw new Error("Refresh claim did not reach an executable state");
    }

    try {
      await this.captureRefreshObservation(
        fixture,
        claim.assignment.assignmentId,
      );
      await this.writePack(claim.assignment.assignmentId);
      const observation = await dispatchBindPoll(
        {
          assignmentId: claim.assignment.assignmentId,
          attemptId: claim.attempt.attemptId,
        },
        this.rolePorts,
        this.runObserver,
      );
      await this.acceptAndValidate(sessionId, [observation], claim.plan);
    } catch (error) {
      await this.failSession(sessionId, error);
      throw error;
    }
    return this.getSnapshot(sessionId);
  }

  async commit(
    sessionIdInput: string,
    requestInput: CommitSessionRequest,
  ): Promise<CommitProtectedEffectResult> {
    await this.initialize();
    const sessionId = OpaqueIdSchema.parse(sessionIdInput);
    const request = CommitSessionRequestSchema.parse(requestInput);
    if (sessionById(this.ports.store.snapshot(), sessionId) === null) {
      throw new EpochGuardServiceError(
        API_ERROR_STATUS.SESSION_NOT_FOUND,
        makeSessionNotFoundError(sessionId),
      );
    }
    const result = await commitProtectedEffect(
      {
        store: this.ports.store,
        world: this.worldPort,
        createEffectId: () => this.createOpaqueId("effect"),
        now: this.now,
      },
      { sessionId, request },
    );
    if (result.status === "REJECTED" && result.error !== null) {
      throw new EpochGuardServiceError(
        API_ERROR_STATUS.STALE_VIEW,
        result.error,
      );
    }
    if (result.status === "REJECTED" && result.reasonCode === "COMMIT_RACE") {
      await this.recordCommitRace(sessionId);
    }
    return result;
  }

  async resetDemo(): Promise<void> {
    await this.initialize();
    await this.ports.store.mutate((database) => {
      const backgroundSessionIds = new Set(this.backgroundTasks.keys());
      const active = database.sessions
        .filter(
          (session) =>
            backgroundSessionIds.has(session.sessionId) ||
            !TERMINAL_SESSION_STATES.has(session.state),
        )
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))[0];
      if (active !== undefined) {
        throw new EpochGuardServiceError(
          API_ERROR_STATUS.AGENTS_BUSY,
          makeAgentsBusyError(active.sessionId, frozenAssignments(active)),
        );
      }
      database.headSeq = 0;
      database.worldCommits = [];
      database.resourceVersions = [];
      database.roleQuerySpecs = [];
      database.runAssignments = [];
      database.receipts = [];
      database.sessions = [];
      database.attempts = [];
      database.decisions = [];
      database.validations = [];
      database.jointValidityCertificates = [];
      database.noCutProofs = [];
      database.refreshPlans = [];
      database.permits = [];
      database.effects = [];
      database.diagnostics = [];
      database.rejectedOutputArtifacts = [];
      database.auditEvents = [];
    });
  }

  getWorld(): Pick<
    EpochDatabase,
    "snapshotRevision" | "headSeq" | "worldCommits" | "resourceVersions"
  > {
    const database = this.ports.store.snapshot();
    return {
      snapshotRevision: database.snapshotRevision,
      headSeq: database.headSeq,
      worldCommits: database.worldCommits,
      resourceVersions: database.resourceVersions,
    };
  }

  getEffects(campaignIdInput: string): {
    campaignId: string;
    effects: EffectRecord[];
  } {
    const campaignId = OpaqueIdSchema.parse(campaignIdInput);
    const database = this.ports.store.snapshot();
    const sessionIds = new Set(
      database.sessions
        .filter((session) => session.action.campaignId === campaignId)
        .map((session) => session.sessionId),
    );
    return {
      campaignId,
      effects: database.effects
        .filter((effect) => sessionIds.has(effect.sessionId))
        .map((effect) => structuredClone(effect)),
    };
  }

  private async verifyRequestedAgents(
    request: CreateSessionRequest,
  ): Promise<Record<Role, RoleAgentRegistration>> {
    const database = this.ports.store.snapshot();
    const registrations = Object.fromEntries(
      ROLES.map((role) => [role, roleRegistration(database, role)]),
    ) as Record<Role, RoleAgentRegistration>;
    for (const role of ROLES) {
      const registration = registrations[role];
      if (request.assignments[role] !== registration.agentId) {
        throw new EpochGuardServiceError(
          API_ERROR_STATUS.ROLE_PROFILE_MISMATCH,
          makeRoleProfileMismatchError(role, request.assignments[role]),
        );
      }
    }
    await Promise.all(
      ROLES.map((role) => {
        const registration = registrations[role];
        return this.verifyRegisteredRoleProfile(role, registration);
      }),
    );
    return registrations;
  }

  private async verifyRegisteredRoleProfile(
    role: Role,
    registration: RoleAgentRegistration,
    expectedAgentId = registration.agentId,
  ): Promise<void> {
    try {
      await verifyRoleAgentProfile(
        {
          role,
          agentId: expectedAgentId,
          agentName: registration.agentNameAtRegistration,
          roleProfileVersion: registration.roleProfileVersion,
          agentsMdDigest: registration.agentsMdDigest,
        },
        this.rolePorts,
      );
    } catch (error) {
      if (!(error instanceof RoleProfileMismatchError)) throw error;
      throw new EpochGuardServiceError(
        API_ERROR_STATUS.ROLE_PROFILE_MISMATCH,
        makeRoleProfileMismatchError(role, expectedAgentId),
      );
    }
  }

  private newAssignment(input: {
    session: EpochSession;
    role: Role;
    registration: RoleAgentRegistration;
    runtimeLabel: string;
    createdAt: string;
  }): RunAssignment {
    const assignmentId = this.createOpaqueId("assignment");
    const receiptId = this.createOpaqueId("receipt");
    const query = RoleQuerySpecSchema.parse(
      getEpochGuardFixture(input.session.scenarioId).querySpecs[input.role],
    );
    return RunAssignmentSchema.parse({
      assignmentId,
      sessionId: input.session.sessionId,
      actionHash: input.session.actionHash,
      agentId: input.registration.agentId,
      agentNameAtAssignment: input.registration.agentNameAtRegistration,
      role: input.role,
      receiptId,
      queryHash: query.queryHash,
      roleProfileVersion: input.registration.roleProfileVersion,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      agentsMdDigest: input.registration.agentsMdDigest,
      runtimeLabelAtDispatch: input.runtimeLabel,
      evidencePackRelativePath: evidencePackRelativePath(
        input.session.sessionId,
        input.role,
        assignmentId,
      ),
      evidencePackHash: EMPTY_PACK_HASH,
      boundRunId: null,
      status: "CREATED",
      consumedByDecisionCertificateId: null,
      createdAt: input.createdAt,
      boundAt: null,
      consumedAt: null,
    });
  }

  private async runtimeLabel(): Promise<string> {
    const system = await this.ports.agents.systemInfo();
    const candidate = system.runtime;
    const label =
      typeof candidate === "string" && candidate.trim().length > 0
        ? candidate.trim()
        : "Codex Runtime";
    return label.slice(0, 256);
  }

  private createOpaqueId(prefix: string): string {
    return OpaqueIdSchema.parse(this.createId(prefix));
  }

  private requireSession(sessionId: string): EpochSession {
    const session = sessionById(this.ports.store.snapshot(), sessionId);
    if (session === null) {
      throw new EpochGuardServiceError(
        API_ERROR_STATUS.SESSION_NOT_FOUND,
        makeSessionNotFoundError(sessionId),
      );
    }
    return structuredClone(session);
  }

  private async transitionToCollecting(sessionId: string): Promise<void> {
    const timestamp = TimestampSchema.parse(this.now());
    await this.ports.store.mutate((database) => {
      const session = sessionById(database, sessionId);
      if (session === null || session.state !== "DISPATCHING") {
        throw new Error("Session cannot enter COLLECTING from its current state");
      }
      session.state = "COLLECTING";
      session.sessionRevision += 1;
      session.stateUpdatedAt = timestamp;
      this.appendEvent(database, session, "SESSION_STATE", "COLLECTING", []);
    });
  }

  private scheduleInitialContinuation(
    sessionId: string,
    prepared: readonly PreparedPack[],
  ): void {
    if (this.backgroundTasks.has(sessionId)) return;
    let releaseOwnership = false;
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        await Promise.all(
          prepared.map((pack) => this.writePack(pack.assignmentId)),
        );
        await this.transitionToCollecting(sessionId);
        const observations = await this.runInitialFanOut(sessionId, prepared);
        await this.acceptAndValidate(sessionId, observations, null);
        releaseOwnership = true;
      })
      .catch(async (error: unknown) => {
        releaseOwnership = await this.closeBackgroundFailure(sessionId, error);
      })
      .finally(() => {
        if (releaseOwnership) this.backgroundTasks.delete(sessionId);
      });
    this.backgroundTasks.set(sessionId, task);
  }

  private async closeBackgroundFailure(
    sessionId: string,
    error: unknown,
  ): Promise<boolean> {
    if (this.hasPersistedTerminalSession(sessionId)) return true;
    try {
      await this.failSession(sessionId, error);
      return true;
    } catch {
      if (this.hasPersistedTerminalSession(sessionId)) return true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.hasPersistedTerminalSession(sessionId)) return true;
      try {
        await this.failSession(sessionId, error);
        return true;
      } catch {
        if (this.hasPersistedTerminalSession(sessionId)) return true;
        this.reportBackgroundFailure(sessionId);
        return false;
      }
    }
  }

  private hasPersistedTerminalSession(sessionId: string): boolean {
    try {
      const session = sessionById(this.ports.store.snapshot(), sessionId);
      return session !== null && TERMINAL_SESSION_STATES.has(session.state);
    } catch {
      return false;
    }
  }

  private reportBackgroundFailure(sessionId: string): void {
    const report = Object.freeze({
      code: BACKGROUND_FAILURE_PERSISTENCE_FAILED,
      sessionId,
    });
    try {
      const pending = this.onBackgroundFailure(report);
      void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // Reporting is best-effort and must never reject the background owner.
    }
  }

  private async runInitialFanOut(
    sessionId: string,
    packs: readonly PreparedPack[],
  ): Promise<readonly [
    TerminalRunObservation,
    TerminalRunObservation,
    TerminalRunObservation,
  ]> {
    const database = this.ports.store.snapshot();
    const session = sessionById(database, sessionId);
    if (session === null) throw new Error("Session disappeared before fan-out");
    const byRole = new Map<Role, DispatchBindPollInput>();
    for (const pack of packs) {
      const assignment = database.runAssignments.find(
        (candidate) => candidate.assignmentId === pack.assignmentId,
      );
      const attempt = database.attempts.find(
        (candidate) => candidate.assignmentId === pack.assignmentId,
      );
      if (assignment === undefined || attempt === undefined) {
        throw new Error("Prepared fan-out artifacts are missing");
      }
      byRole.set(assignment.role, {
        assignmentId: assignment.assignmentId,
        attemptId: attempt.attemptId,
      });
    }
    const inputs = ROLES.map((role) => {
      const input = byRole.get(role);
      if (input === undefined) throw new Error(`Missing ${role} fan-out input`);
      return input;
    }) as [DispatchBindPollInput, DispatchBindPollInput, DispatchBindPollInput];
    const runPromises = inputs.map((input) =>
      dispatchBindPoll(input, this.rolePorts, this.runObserver),
    );
    const settled = await Promise.allSettled(runPromises);
    const preciseFailure = settled.find(
      (item): item is PromiseRejectedResult =>
        item.status === "rejected" && item.reason instanceof RunAdapterError,
    );
    if (preciseFailure !== undefined) {
      // Once createSession returns, readers can poll between every Store
      // publication. Close the Session before the join rejects its sibling
      // Assignments so both authoritative snapshots remain projectable.
      await this.failSession(sessionId, preciseFailure.reason);
    }
    try {
      return await joinRoleRunObservations(settled, this.ports.store, {
        sessionId,
        actionHash: session.actionHash,
        assignmentIds: inputs.map((input) => input.assignmentId) as [
          string,
          string,
          string,
        ],
      });
    } catch (error) {
      throw preciseFailure?.reason ?? error;
    }
  }

  private async acceptAndValidate(
    sessionId: string,
    observations: readonly TerminalRunObservation[],
    refreshPlan: RefreshPlan | null,
  ): Promise<void> {
    const timestamp = TimestampSchema.parse(this.now());
    await this.ports.store.mutate((database) => {
      const session = sessionById(database, sessionId);
      if (session === null) throw new Error("Session disappeared before normalization");
      const results: DecisionNormalizationResult[] = [];
      for (const observation of observations) {
        results.push(
          normalizeAndConsumeDecision(
            database,
            observation.attempt.attemptId,
            observation.output,
            {
              certificateId: this.createOpaqueId("decision"),
              rejectedOutputArtifactId: this.createOpaqueId("rejected"),
              createdAt: timestamp,
            },
          ),
        );
      }
      const rejected = results.find(
        (result) => result.status === "OUTPUT_REJECTED",
      );
      if (rejected?.status === "OUTPUT_REJECTED") {
        session.state = "FAILED";
        session.sessionRevision += 1;
        session.stateUpdatedAt = timestamp;
        session.activePermitId = null;
        const artifact = rejected.rejectedOutputArtifact;
        const attempt = database.attempts.find(
          (candidate) => candidate.attemptId === artifact.attemptId,
        )!;
        const refreshFailure = this.closeClaimedRefreshFailure(
          database,
          session,
          "FAILED",
        );
        if (!refreshFailure.handled) {
          session.activeAttemptIds = {
            inventory: null,
            budget: null,
            policy: null,
          };
        }
        this.appendDiagnostic(database, session, {
          kind: "SYSTEM_FAILURE",
          stage: "PARSE",
          reasonCode: "OUTPUT_MALFORMED",
          role: attempt.role,
          attemptId: attempt.attemptId,
          assignmentId: attempt.assignmentId,
          runId: attempt.runId,
          artifactRefs: [
            { kind: "ATTEMPT", id: attempt.attemptId },
            { kind: "ASSIGNMENT", id: attempt.assignmentId },
            ...(attempt.runId === null
              ? []
              : ([{ kind: "RUN", id: attempt.runId }] as ArtifactRef[])),
            { kind: "REJECTED_OUTPUT", id: artifact.artifactId },
          ],
          rejectedOutputArtifactId: artifact.artifactId,
          recommendedAction: "NEW_SESSION",
        });
        return;
      }

      const acceptedAttempts = observations.map((observation) => {
        const attempt = database.attempts.find(
          (candidate) =>
            candidate.attemptId === observation.attempt.attemptId,
        );
        if (attempt === undefined) throw new Error("Accepted Attempt disappeared");
        return attempt;
      });
      if (refreshPlan === null) {
        session.coordinationMode = deriveCoordinationMode(acceptedAttempts);
      }
      session.state = "VALIDATING";
      session.sessionRevision += 1;
      session.stateUpdatedAt = timestamp;
      this.persistValidation(database, session, { refreshPlan });
    });
  }

  private persistValidation(
    database: EpochDatabase,
    session: EpochSession,
    context: ValidationContext,
  ): void {
    const started = this.monotonicMs();
    const ids = {
      validationId: this.createOpaqueId("validation"),
      jointValidityCertificateId: this.createOpaqueId("jvc"),
      noCutProofId: this.createOpaqueId("proof"),
    };
    const result = validateJointValidity(database, session.sessionId, {
      resolveResourceVersion: (lookup) => {
        const version = resolveResourceVersionByIdentity(
          database,
          lookup.source,
          lookup.entityKey,
          lookup.sourceRevision,
        );
        return version === undefined
          ? null
          : {
              source: lookup.source,
              entityKey: lookup.entityKey,
              resourceVersion: version,
            };
      },
      ...ids,
      createdAt: TimestampSchema.parse(this.now()),
      verificationLatencyMs: Math.max(0, this.monotonicMs() - started),
    });
    database.validations.push(result.validationRecord);
    if (result.jointValidityCertificate !== null) {
      database.jointValidityCertificates.push(result.jointValidityCertificate);
    }
    if (result.noCutProof !== null) {
      database.noCutProofs.push(result.noCutProof);
    }
    session.activeValidationId = result.validationRecord.validationId;
    session.activePermitId = null;

    const timestamp = result.validationRecord.createdAt;
    switch (result.validationRecord.outcome) {
      case "VALID_CURRENT_ALLOW": {
        const jvc = result.jointValidityCertificate;
        if (jvc === null) throw new Error("Ready validation must create a JVC");
        if (context.refreshPlan !== null) {
          const plan = this.completeRefreshPlan(database, context.refreshPlan);
          result.validationRecord.refreshPlanId = plan.refreshPlanId;
          session.activeRefreshPlanId = plan.refreshPlanId;
        }
        const permit = EffectPermitSchema.parse({
          permitId: this.createOpaqueId("permit"),
          sessionId: session.sessionId,
          actionHash: session.actionHash,
          dependencySetHash: result.validationRecord.dependencySetHash,
          jointValidityCertificateId: jvc.certificateId,
          validatedHead: result.validationRecord.validatedHead,
          idempotencyKey: session.action.idempotencyKey,
          status: "ISSUED",
          issuedAt: timestamp,
          consumedAt: null,
        });
        database.permits.push(permit);
        session.activePermitId = permit.permitId;
        session.state = "READY_AT_CURRENT_HEAD";
        session.sessionRevision += 1;
        session.stateUpdatedAt = timestamp;
        this.appendEvent(
          database,
          session,
          "VALIDATION",
          "READY_AT_CURRENT_HEAD",
          [
            { kind: "VALIDATION", id: result.validationRecord.validationId },
            { kind: "PERMIT", id: permit.permitId },
          ],
        );
        break;
      }
      case "NO_VALID_OBSERVED_WORLD_CUT": {
        const proof = result.noCutProof;
        if (proof === null) throw new Error("No-Cut validation must create a Proof");
        session.state = "BLOCKED_NO_CUT";
        session.sessionRevision += 1;
        session.stateUpdatedAt = timestamp;
        const plan = buildRefreshPlan({
          refreshPlanId: this.createOpaqueId("refresh"),
          sessionId: session.sessionId,
          database,
          world: this.worldPort,
        });
        result.validationRecord.refreshPlanId = plan.refreshPlanId;
        session.activeRefreshPlanId = plan.refreshPlanId;
        database.refreshPlans.push(plan);
        const witnessRefs = proof.conflictWitnessReceiptIds.map(
          (receiptId): ArtifactRef => ({ kind: "RECEIPT", id: receiptId }),
        );
        this.appendDiagnostic(database, session, {
          kind: "EXPECTED_BLOCK",
          stage: "VALIDATE",
          reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
          role: null,
          attemptId: null,
          assignmentId: null,
          runId: null,
          artifactRefs: [
            { kind: "VALIDATION", id: result.validationRecord.validationId },
            { kind: "PROOF", id: proof.proofId },
            ...witnessRefs,
            { kind: "REFRESH_PLAN", id: plan.refreshPlanId },
          ],
          rejectedOutputArtifactId: null,
          recommendedAction: "REOBSERVE_INVALID",
        });
        this.appendEvent(
          database,
          session,
          "VALIDATION",
          "BLOCKED_NO_CUT",
          [
            { kind: "VALIDATION", id: result.validationRecord.validationId },
            { kind: "PROOF", id: proof.proofId },
          ],
        );
        break;
      }
      case "CONSISTENT_DENY": {
        const refreshedArtifactRefs: ArtifactRef[] = [];
        if (context.refreshPlan !== null) {
          const plan = this.completeRefreshPlan(database, context.refreshPlan);
          result.validationRecord.refreshPlanId = plan.refreshPlanId;
          session.activeRefreshPlanId = plan.refreshPlanId;
          const claimedAttempt = database.attempts.find(
            (candidate) => candidate.attemptId === plan.claimedAttemptId,
          );
          const claimedAssignment = claimedAttempt
            ? database.runAssignments.find(
                (candidate) =>
                  candidate.assignmentId === claimedAttempt.assignmentId,
              )
            : undefined;
          if (claimedAttempt === undefined || claimedAssignment === undefined) {
            throw new Error(
              "Completed RefreshPlan is missing its claimed evidence binding",
            );
          }
          refreshedArtifactRefs.push(
            { kind: "REFRESH_PLAN", id: plan.refreshPlanId },
            { kind: "RECEIPT", id: claimedAssignment.receiptId },
          );
        }
        session.state = "CONSISTENT_DENY";
        session.sessionRevision += 1;
        session.stateUpdatedAt = timestamp;
        this.appendDiagnostic(database, session, {
          kind: "EXPECTED_BLOCK",
          stage: "VALIDATE",
          reasonCode: "CONSISTENT_DENY",
          role: null,
          attemptId: null,
          assignmentId: null,
          runId: null,
          artifactRefs: [
            { kind: "VALIDATION", id: result.validationRecord.validationId },
            ...refreshedArtifactRefs,
          ],
          rejectedOutputArtifactId: null,
          recommendedAction: "NONE",
        });
        this.appendEvent(
          database,
          session,
          "VALIDATION",
          "CONSISTENT_DENY",
          [{ kind: "VALIDATION", id: result.validationRecord.validationId }],
        );
        break;
      }
      case "HISTORICAL_BUT_STALE_NOW":
        session.state = "HISTORICAL_STALE";
        session.sessionRevision += 1;
        session.stateUpdatedAt = timestamp;
        this.appendDiagnostic(database, session, {
          kind: "EXPECTED_BLOCK",
          stage: "VALIDATE",
          reasonCode: "HISTORICAL_BUT_STALE_NOW",
          role: null,
          attemptId: null,
          assignmentId: null,
          runId: null,
          artifactRefs: [
            { kind: "VALIDATION", id: result.validationRecord.validationId },
          ],
          rejectedOutputArtifactId: null,
          recommendedAction: "REOBSERVE_INVALID",
        });
        break;
      case "FAILED":
        session.state = "FAILED";
        session.sessionRevision += 1;
        session.stateUpdatedAt = timestamp;
        break;
    }
  }

  private completeRefreshPlan(
    database: EpochDatabase,
    expected: RefreshPlan,
  ): RefreshPlan {
    const plan = database.refreshPlans.find(
      (candidate) => candidate.refreshPlanId === expected.refreshPlanId,
    );
    if (
      plan === undefined ||
      plan.status !== "CLAIMED" ||
      plan.claimedAttemptId === null
    ) {
      throw new Error("RefreshPlan cannot be completed from its current state");
    }
    plan.status = "COMPLETED";
    return plan;
  }

  private async captureRefreshObservation(
    fixture: EpochGuardFixture,
    assignmentId: string,
  ): Promise<void> {
    const capture = fixture.refreshCapture;
    if (capture === null) throw new Error("Fixture has no refresh capture");
    await this.ports.store.mutate((database) => {
      if (database.headSeq !== capture.expectedHeadSeq) {
        throw new Error("World head changed before the explicit refresh capture");
      }
      const assignment = database.runAssignments.find(
        (candidate) => candidate.assignmentId === assignmentId,
      );
      const session = assignment
        ? sessionById(database, assignment.sessionId)
        : null;
      if (
        assignment === undefined ||
        session === null ||
        assignment.role !== capture.role
      ) {
        throw new Error("Refresh Assignment does not match the fixture capture");
      }
      const query = fixture.querySpecs[capture.role];
      const issued = this.issuer.issue(database, {
        action: session.action,
        assignment,
        querySpec: query,
      });
      const built = buildCanonicalEvidencePack({
        action: session.action,
        querySpec: query,
        assignment,
        receipt: issued.receipt,
        resourceVersion: issued.resourceVersion,
        worldHeadSeq: database.headSeq,
      });
      assignment.evidencePackHash = built.evidencePackHash;
      RunAssignmentSchema.parse(assignment);
    });
  }

  private async writePack(assignmentId: string): Promise<void> {
    const database = this.ports.store.snapshot();
    const assignment = database.runAssignments.find(
      (candidate) => candidate.assignmentId === assignmentId,
    );
    if (assignment === undefined) throw new Error("Evidence Pack Assignment is missing");
    const session = sessionById(database, assignment.sessionId);
    const receipt = database.receipts.find(
      (candidate) => candidate.receiptId === assignment.receiptId,
    );
    const query = database.roleQuerySpecs.find(
      (candidate) => candidate.queryHash === assignment.queryHash,
    );
    if (session === null || receipt === undefined || query === undefined) {
      throw new Error("Evidence Pack authority records are incomplete");
    }
    const resourceVersion = resolveReceiptResourceVersion(database, receipt);
    await this.packWriter.writeCanonicalPack({
      action: session.action,
      querySpec: query,
      assignment,
      receipt,
      resourceVersion,
      worldHeadSeq: database.headSeq,
    });
  }

  private throwClaimError(
    sessionId: string,
    request: RefreshSessionRequest,
    claim: ClaimRefreshPlanResult,
  ): void {
    if (claim.status === "STALE_VIEW") {
      throw new EpochGuardServiceError(API_ERROR_STATUS.STALE_VIEW, claim.error);
    }
    if (claim.status === "ALREADY_REOBSERVING") {
      throw new EpochGuardServiceError(
        API_ERROR_STATUS.ALREADY_REOBSERVING,
        claim.error,
      );
    }
    if (claim.status === "CLAIMED" || claim.status === "INVALIDATED") return;
    const snapshot = this.ports.store.snapshot();
    const session = sessionById(snapshot, sessionId);
    if (session === null) {
      throw new EpochGuardServiceError(
        API_ERROR_STATUS.SESSION_NOT_FOUND,
        makeSessionNotFoundError(sessionId),
      );
    }
    throw new EpochGuardServiceError(
      API_ERROR_STATUS.STALE_VIEW,
      makeStaleViewError(
        sessionId,
        request.expectedSessionRevision,
        session.sessionRevision,
      ),
    );
  }

  private async failSession(sessionId: string, error: unknown): Promise<void> {
    const timestamp = TimestampSchema.parse(this.now());
    await this.ports.store.mutate((database) => {
      const session = sessionById(database, sessionId);
      if (session === null || TERMINAL_SESSION_STATES.has(session.state)) return;
      session.state = "FAILED";
      session.sessionRevision += 1;
      session.stateUpdatedAt = timestamp;
      session.activePermitId = null;
      const adapterError = error instanceof RunAdapterError ? error : null;
      const refreshFailure = this.closeClaimedRefreshFailure(
        database,
        session,
        "FAILED",
      );
      if (!refreshFailure.handled) {
        session.activeAttemptIds = {
          inventory: null,
          budget: null,
          policy: null,
        };
      }
      const adapterAttempt = adapterError?.attempt;
      const attempt =
        refreshFailure.attempt ??
        (adapterAttempt === null || adapterAttempt === undefined
          ? null
          : database.attempts.find(
              (candidate) =>
                candidate.attemptId === adapterAttempt.attemptId,
            ) ?? adapterAttempt);
      const hasTerminalRunFailure =
        attempt !== null &&
        attempt.runId !== null &&
        (attempt.status === "FAILED" || attempt.status === "INTERRUPTED") &&
        attempt.runCompletedAt !== null;
      this.appendDiagnostic(database, session, {
        kind: "SYSTEM_FAILURE",
        stage: hasTerminalRunFailure ? "RUN" : "DISPATCH",
        reasonCode: adapterError?.code ?? "RUN_FAILED",
        role: attempt?.role ?? null,
        attemptId: attempt?.attemptId ?? null,
        assignmentId: attempt?.assignmentId ?? null,
        runId: attempt?.runId ?? null,
        artifactRefs:
          attempt === null || attempt === undefined
            ? []
            : [
                { kind: "ATTEMPT", id: attempt.attemptId },
                { kind: "ASSIGNMENT", id: attempt.assignmentId },
                ...(attempt.runId === null
                  ? []
                  : ([{ kind: "RUN", id: attempt.runId }] as ArtifactRef[])),
              ],
        rejectedOutputArtifactId: null,
        recommendedAction: "NEW_SESSION",
      });
      this.appendEvent(database, session, "SESSION_STATE", "FAILED", []);
    });
  }

  private closeClaimedRefreshFailure(
    database: EpochDatabase,
    session: EpochSession,
    terminalStatus: "FAILED" | "INTERRUPTED",
  ): RefreshFailureClosure {
    if (session.activeRefreshPlanId === null) {
      return { handled: false, attempt: null };
    }
    const plans = database.refreshPlans.filter(
      (candidate) =>
        candidate.refreshPlanId === session.activeRefreshPlanId,
    );
    if (plans.length !== 1 || plans[0]!.status !== "CLAIMED") {
      return { handled: false, attempt: null };
    }
    const plan = plans[0]!;
    const claimedAttemptId = plan.claimedAttemptId;
    const attempts =
      claimedAttemptId === null
        ? []
        : database.attempts.filter(
            (candidate) => candidate.attemptId === claimedAttemptId,
          );
    const attempt = attempts.length === 1 ? attempts[0]! : null;
    const assignments =
      attempt === null
        ? []
        : database.runAssignments.filter(
            (candidate) =>
              candidate.assignmentId === attempt.assignmentId,
          );
    const assignment = assignments.length === 1 ? assignments[0]! : null;
    const bindingIsValid =
      attempt !== null &&
      assignment !== null &&
      attempt.sessionId === session.sessionId &&
      attempt.actionHash === session.actionHash &&
      attempt.role === "budget" &&
      attempt.agentId === session.frozenAssignments.budgetAgentId &&
      assignment.sessionId === session.sessionId &&
      assignment.actionHash === session.actionHash &&
      assignment.role === "budget" &&
      assignment.agentId === attempt.agentId &&
      assignment.assignmentId === attempt.assignmentId &&
      assignment.boundRunId === attempt.runId &&
      assignment.consumedByDecisionCertificateId === null &&
      assignment.consumedAt === null;
    if (!bindingIsValid || attempt === null || assignment === null) {
      plan.status = "INVALIDATED";
      plan.claimedAttemptId = null;
      session.activeRefreshPlanId = null;
      session.activeAttemptIds = {
        inventory: null,
        budget: null,
        policy: null,
      };
      return { handled: true, attempt };
    }

    const alreadyTerminal =
      attempt.status === "FAILED" ||
      attempt.status === "INTERRUPTED" ||
      attempt.status === "OUTPUT_REJECTED";
    const canCloseTerminally =
      alreadyTerminal ||
      attempt.runId === null ||
      attempt.runCompletedAt !== null;
    if (!canCloseTerminally) {
      assignment.status = "REJECTED";
      plan.status = "INVALIDATED";
      plan.claimedAttemptId = null;
      session.activeRefreshPlanId = null;
      session.activeAttemptIds = {
        inventory: null,
        budget: null,
        policy: null,
      };
      RunAssignmentSchema.parse(assignment);
      return { handled: true, attempt };
    }

    if (!alreadyTerminal) attempt.status = terminalStatus;
    assignment.status = "REJECTED";
    session.activeAttemptIds = {
      inventory: null,
      budget: attempt.attemptId,
      policy: null,
    };
    AgentAttemptSchema.parse(attempt);
    RunAssignmentSchema.parse(assignment);
    return { handled: true, attempt };
  }

  private async recordCommitRace(sessionId: string): Promise<void> {
    await this.ports.store.mutate((database) => {
      const session = sessionById(database, sessionId);
      if (session === null || session.state !== "COMMIT_RACE") return;
      const validation = database.validations.find(
        (candidate) => candidate.validationId === session.activeValidationId,
      );
      const permit = database.permits
        .filter((candidate) => candidate.sessionId === sessionId)
        .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))[0];
      if (validation === undefined || permit === undefined) return;
      const hasRaceEvent = database.auditEvents.some(
        (event) =>
          event.sessionId === sessionId &&
          event.sessionRevision === session.sessionRevision &&
          event.type === "SESSION_STATE" &&
          event.status === "COMMIT_RACE",
      );
      if (!hasRaceEvent) {
        this.appendEvent(database, session, "SESSION_STATE", "COMMIT_RACE", [
          { kind: "VALIDATION", id: validation.validationId },
          { kind: "PERMIT", id: permit.permitId },
        ]);
      }
      const hasRaceDiagnostic = database.diagnostics.some(
        (diagnostic) =>
          diagnostic.sessionId === sessionId &&
          diagnostic.sessionRevision === session.sessionRevision &&
          diagnostic.kind === "TRANSIENT_RACE" &&
          diagnostic.stage === "COMMIT" &&
          diagnostic.reasonCode === "COMMIT_RACE",
      );
      if (!hasRaceDiagnostic) {
        this.appendDiagnostic(database, session, {
          kind: "TRANSIENT_RACE",
          stage: "COMMIT",
          reasonCode: "COMMIT_RACE",
          role: null,
          attemptId: null,
          assignmentId: null,
          runId: null,
          artifactRefs: [
            { kind: "VALIDATION", id: validation.validationId },
            { kind: "PERMIT", id: permit.permitId },
          ],
          rejectedOutputArtifactId: null,
          recommendedAction: "NONE",
        });
      }
    });
  }

  private appendEvent(
    database: EpochDatabase,
    session: EpochSession,
    type: string,
    status: string,
    artifactRefs: ArtifactRef[],
  ): void {
    database.auditEvents.push(
      AuditEventSchema.parse({
        eventId: this.createOpaqueId("event"),
        sessionId: session.sessionId,
        actionHash: session.actionHash,
        sessionRevision: session.sessionRevision,
        auditSeq: nextAuditSeq(database, session.sessionId),
        type,
        status,
        role: null,
        artifactRefs,
        createdAt: TimestampSchema.parse(this.now()),
      }),
    );
  }

  private appendDiagnostic(
    database: EpochDatabase,
    session: EpochSession,
    values: Pick<
      SafetyDiagnostic,
      | "kind"
      | "stage"
      | "reasonCode"
      | "role"
      | "attemptId"
      | "assignmentId"
      | "runId"
      | "artifactRefs"
      | "rejectedOutputArtifactId"
      | "recommendedAction"
    >,
  ): void {
    database.diagnostics.push(
      buildSafetyDiagnostic({
        diagnosticId: this.createOpaqueId("diagnostic"),
        sessionId: session.sessionId,
        actionHash: session.actionHash,
        sessionRevision: session.sessionRevision,
        fixtureRef: session.scenarioId,
        ...values,
        causedByDiagnosticIds: [],
        expected: null,
        actual: null,
        auditSeq: nextAuditSeq(database, session.sessionId),
      }),
    );
  }
}
