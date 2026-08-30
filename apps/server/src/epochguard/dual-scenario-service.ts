import type { CommitProtectedEffectResult } from "./effect-gate.js";
import { EpochGuardServiceError } from "./epochguard-service.js";
import type { EpochGuardRouteServicePort } from "./routes.js";
import {
  API_ERROR_STATUS,
  CommitSessionRequestSchema,
  CreateSessionRequestSchema,
  OpaqueIdSchema,
  RefreshSessionRequestSchema,
  ROLES,
  makeAgentsBusyError,
  makeProjectionMismatchError,
  makeRoleProfileMismatchError,
  makeSessionNotFoundError,
  type CommitSessionRequest,
  type CreateSessionRequest,
  type EffectRecord,
  type EpochDatabase,
  type EpochSession,
  type RefreshSessionRequest,
  type RoleAgentRegistration,
  type ScenarioId,
  type SessionDashboardSnapshot,
} from "./types.js";

const TERMINAL_SESSION_STATES = new Set<EpochSession["state"]>([
  "UNSTABLE_WORLD",
  "CONSISTENT_DENY",
  "COMMIT_RACE",
  "COMMITTED",
  "FAILED",
  "INTERRUPTED",
]);

const BUSINESS_COLLECTIONS = [
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
] as const satisfies readonly (keyof EpochDatabase)[];

type ScenarioPartitionName = "normal" | "impossible";

export interface DualScenarioStorePort {
  initialize(): Promise<void>;
  snapshot(): EpochDatabase;
  mutate<T>(
    mutation: (database: EpochDatabase) => T | Promise<T>,
  ): Promise<T>;
}

export interface InitializableEpochGuardRouteServicePort
  extends EpochGuardRouteServicePort {
  initialize(): Promise<void>;
}

export interface DualScenarioPartition {
  store: DualScenarioStorePort;
  service: InitializableEpochGuardRouteServicePort;
}

export interface DualScenarioEpochGuardServiceOptions {
  normal: DualScenarioPartition;
  impossible: DualScenarioPartition;
}

type Partition = DualScenarioPartition & {
  name: ScenarioPartitionName;
  scenarioId: ScenarioId;
};

type RegistrationState =
  | { kind: "PRISTINE" }
  | { kind: "COMPLETE"; registrations: RoleAgentRegistration[] };

type SessionLocation = {
  partition: Partition;
  session: EpochSession;
};

type StoreScan = {
  normalDatabase: EpochDatabase;
  impossibleDatabase: EpochDatabase;
  sessions: SessionLocation[];
  active: SessionLocation[];
};

function frozenAssignments(
  session: EpochSession,
): CreateSessionRequest["assignments"] {
  return {
    inventory: session.frozenAssignments.inventoryAgentId,
    budget: session.frozenAssignments.budgetAgentId,
    policy: session.frozenAssignments.policyAgentId,
  };
}

function registrationIdentity(registration: RoleAgentRegistration): string {
  return JSON.stringify({
    role: registration.role,
    agentId: registration.agentId,
    agentNameAtRegistration: registration.agentNameAtRegistration,
    roleProfileVersion: registration.roleProfileVersion,
    agentsMdDigest: registration.agentsMdDigest,
  });
}

function sortedRegistrations(
  registrations: readonly RoleAgentRegistration[],
): RoleAgentRegistration[] {
  return [...registrations]
    .map((registration) => structuredClone(registration))
    .sort(
      (left, right) =>
        ROLES.indexOf(left.role) - ROLES.indexOf(right.role),
    );
}

function inspectRegistrations(
  database: EpochDatabase,
  partitionName: ScenarioPartitionName,
): RegistrationState {
  const registrations = database.roleAgentRegistrations;
  if (registrations.length === 0) {
    const pristine =
      database.headSeq === 0 &&
      BUSINESS_COLLECTIONS.every(
        (field) => (database[field] as readonly unknown[]).length === 0,
      );
    if (!pristine) {
      throw new Error(
        `${partitionName} EpochStore has business data without Role registrations`,
      );
    }
    return { kind: "PRISTINE" };
  }

  if (registrations.length !== ROLES.length) {
    throw new Error(
      `${partitionName} EpochStore must contain either zero or three Role registrations`,
    );
  }
  const roles = new Set(registrations.map((registration) => registration.role));
  const agentIds = new Set(
    registrations.map((registration) => registration.agentId),
  );
  if (
    roles.size !== ROLES.length ||
    ROLES.some((role) => !roles.has(role)) ||
    agentIds.size !== ROLES.length
  ) {
    throw new Error(
      `${partitionName} EpochStore Role registrations are duplicated or incomplete`,
    );
  }
  return {
    kind: "COMPLETE",
    registrations: sortedRegistrations(registrations),
  };
}

function sameRegistrationIdentity(
  left: readonly RoleAgentRegistration[],
  right: readonly RoleAgentRegistration[],
): boolean {
  const sortedLeft = sortedRegistrations(left);
  const sortedRight = sortedRegistrations(right);
  return ROLES.every(
    (_role, index) =>
      registrationIdentity(sortedLeft[index]!) ===
      registrationIdentity(sortedRight[index]!),
  );
}

function latestStateUpdatedAt(database: EpochDatabase): string | null {
  return database.sessions.reduce<string | null>(
    (latest, session) =>
      latest === null || session.stateUpdatedAt > latest
        ? session.stateUpdatedAt
        : latest,
    null,
  );
}

/**
 * Routes the two fixed demo scenarios to isolated Stores while preserving one
 * global admission/command order. The queue is process-local and deliberately
 * does not claim cross-file atomicity for the two JSON files.
 */
export class DualScenarioEpochGuardService
  implements EpochGuardRouteServicePort
{
  private readonly normal: Partition;
  private readonly impossible: Partition;
  private mutationQueue: Promise<void> = Promise.resolve();
  private initializePromise: Promise<void> | null = null;
  private initialized = false;

  constructor(options: DualScenarioEpochGuardServiceOptions) {
    this.normal = {
      ...options.normal,
      name: "normal",
      scenarioId: "normal-world-v1",
    };
    this.impossible = {
      ...options.impossible,
      name: "impossible",
      scenarioId: "impossible-collage-v1",
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise !== null) return this.initializePromise;
    this.initializePromise = this.initializeUnlocked().finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  async createSession(
    requestInput: CreateSessionRequest,
  ): Promise<SessionDashboardSnapshot> {
    await this.initialize();
    const request = CreateSessionRequestSchema.parse(requestInput);
    return this.withMutationLock(async () => {
      const scan = this.scanStores();
      this.validateCreateAssignments(request, scan);
      if (scan.active.length > 0) {
        const active = scan.active[0]!;
        throw new EpochGuardServiceError(
          API_ERROR_STATUS.AGENTS_BUSY,
          makeAgentsBusyError(
            active.session.sessionId,
            frozenAssignments(active.session),
          ),
        );
      }
      return this.partitionForScenario(request.scenarioId).service.createSession(
        request,
      );
    });
  }

  getSnapshot(sessionIdInput: string): SessionDashboardSnapshot {
    this.requireInitialized();
    const sessionId = OpaqueIdSchema.parse(sessionIdInput);
    return this.locateSession(sessionId).partition.service.getSnapshot(sessionId);
  }

  async refresh(
    sessionIdInput: string,
    requestInput: RefreshSessionRequest,
  ): Promise<SessionDashboardSnapshot> {
    await this.initialize();
    const sessionId = OpaqueIdSchema.parse(sessionIdInput);
    const request = RefreshSessionRequestSchema.parse(requestInput);
    return this.withMutationLock(() =>
      this.locateSession(sessionId).partition.service.refresh(sessionId, request),
    );
  }

  async commit(
    sessionIdInput: string,
    requestInput: CommitSessionRequest,
  ): Promise<CommitProtectedEffectResult> {
    await this.initialize();
    const sessionId = OpaqueIdSchema.parse(sessionIdInput);
    const request = CommitSessionRequestSchema.parse(requestInput);
    return this.withMutationLock(() =>
      this.locateSession(sessionId).partition.service.commit(sessionId, request),
    );
  }

  async resetDemo(): Promise<void> {
    await this.initialize();
    await this.withMutationLock(async () => {
      const scan = this.scanStores();
      if (scan.active.length > 0) {
        const active = scan.active[0]!;
        throw new EpochGuardServiceError(
          API_ERROR_STATUS.AGENTS_BUSY,
          makeAgentsBusyError(
            active.session.sessionId,
            frozenAssignments(active.session),
          ),
        );
      }
      // Fixed ordering makes partial failure deterministic. This is not a
      // transaction across epochguard-normal.json and epochguard-impossible.json.
      await this.normal.service.resetDemo();
      await this.impossible.service.resetDemo();
    });
  }

  getWorld(): Pick<
    EpochDatabase,
    "snapshotRevision" | "headSeq" | "worldCommits" | "resourceVersions"
  > {
    this.requireInitialized();
    const scan = this.scanStores();
    if (scan.active.length === 1) {
      return scan.active[0]!.partition.service.getWorld();
    }

    const normalLatest = latestStateUpdatedAt(scan.normalDatabase);
    const impossibleLatest = latestStateUpdatedAt(scan.impossibleDatabase);
    if (
      impossibleLatest !== null &&
      (normalLatest === null || impossibleLatest > normalLatest)
    ) {
      return this.impossible.service.getWorld();
    }
    return this.normal.service.getWorld();
  }

  getEffects(campaignIdInput: string): {
    campaignId: string;
    effects: EffectRecord[];
  } {
    this.requireInitialized();
    const campaignId = OpaqueIdSchema.parse(campaignIdInput);
    this.scanStores();
    const effects = [
      ...this.normal.service.getEffects(campaignId).effects,
      ...this.impossible.service.getEffects(campaignId).effects,
    ].map((effect) => structuredClone(effect));
    const ids = new Set<string>();
    for (const effect of effects) {
      if (ids.has(effect.effectId)) {
        this.throwProjectionMismatch(effect.sessionId);
      }
      ids.add(effect.effectId);
    }
    effects.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.effectId.localeCompare(right.effectId),
    );
    return { campaignId, effects };
  }

  private async initializeUnlocked(): Promise<void> {
    await Promise.all([
      this.normal.store.initialize(),
      this.impossible.store.initialize(),
    ]);
    const normalState = inspectRegistrations(
      this.normal.store.snapshot(),
      "normal",
    );
    const impossibleState = inspectRegistrations(
      this.impossible.store.snapshot(),
      "impossible",
    );
    this.scanStores();

    if (
      normalState.kind === "COMPLETE" &&
      impossibleState.kind === "COMPLETE"
    ) {
      if (
        !sameRegistrationIdentity(
          normalState.registrations,
          impossibleState.registrations,
        )
      ) {
        throw new Error("EpochGuard scenario Stores disagree on Role identities");
      }
      await this.normal.service.initialize();
      await this.impossible.service.initialize();
    } else if (normalState.kind === "COMPLETE") {
      await this.normal.service.initialize();
      await this.copyRegistrations(this.normal, this.impossible);
      await this.impossible.service.initialize();
    } else if (impossibleState.kind === "COMPLETE") {
      await this.impossible.service.initialize();
      await this.copyRegistrations(this.impossible, this.normal);
      await this.normal.service.initialize();
    } else {
      await this.normal.service.initialize();
      await this.copyRegistrations(this.normal, this.impossible);
      await this.impossible.service.initialize();
    }

    const finalNormal = inspectRegistrations(
      this.normal.store.snapshot(),
      "normal",
    );
    const finalImpossible = inspectRegistrations(
      this.impossible.store.snapshot(),
      "impossible",
    );
    if (
      finalNormal.kind !== "COMPLETE" ||
      finalImpossible.kind !== "COMPLETE" ||
      !sameRegistrationIdentity(
        finalNormal.registrations,
        finalImpossible.registrations,
      )
    ) {
      throw new Error("EpochGuard Role registration initialization did not converge");
    }
    this.scanStores();
    this.initialized = true;
  }

  private async copyRegistrations(
    source: Partition,
    target: Partition,
  ): Promise<void> {
    const sourceState = inspectRegistrations(source.store.snapshot(), source.name);
    if (sourceState.kind !== "COMPLETE") {
      throw new Error(`Cannot copy incomplete ${source.name} Role registrations`);
    }
    await target.store.mutate((database) => {
      const targetState = inspectRegistrations(database, target.name);
      if (targetState.kind !== "PRISTINE") {
        throw new Error(
          `${target.name} EpochStore stopped being pristine before registration copy`,
        );
      }
      database.roleAgentRegistrations = sortedRegistrations(
        sourceState.registrations,
      );
    });
  }

  private scanStores(): StoreScan {
    const normalDatabase = this.normal.store.snapshot();
    const impossibleDatabase = this.impossible.store.snapshot();
    const sessions: SessionLocation[] = [];
    const seen = new Set<string>();

    for (const [partition, database] of [
      [this.normal, normalDatabase],
      [this.impossible, impossibleDatabase],
    ] as const) {
      for (const session of database.sessions) {
        if (session.scenarioId !== partition.scenarioId) {
          this.throwProjectionMismatch(
            session.sessionId,
            Math.max(
              normalDatabase.snapshotRevision,
              impossibleDatabase.snapshotRevision,
            ),
          );
        }
        if (seen.has(session.sessionId)) {
          this.throwProjectionMismatch(
            session.sessionId,
            Math.max(
              normalDatabase.snapshotRevision,
              impossibleDatabase.snapshotRevision,
            ),
          );
        }
        seen.add(session.sessionId);
        sessions.push({ partition, session });
      }
    }

    const active = sessions.filter(
      ({ session }) => !TERMINAL_SESSION_STATES.has(session.state),
    );
    if (active.length > 1) {
      const first = [...active].sort((left, right) =>
        left.session.sessionId.localeCompare(right.session.sessionId),
      )[0]!;
      this.throwProjectionMismatch(
        first.session.sessionId,
        Math.max(
          normalDatabase.snapshotRevision,
          impossibleDatabase.snapshotRevision,
        ),
      );
    }

    return { normalDatabase, impossibleDatabase, sessions, active };
  }

  private locateSession(sessionId: string): SessionLocation {
    const scan = this.scanStores();
    const matches = scan.sessions.filter(
      ({ session }) => session.sessionId === sessionId,
    );
    if (matches.length === 0) {
      throw new EpochGuardServiceError(
        API_ERROR_STATUS.SESSION_NOT_FOUND,
        makeSessionNotFoundError(sessionId),
      );
    }
    if (matches.length !== 1) {
      this.throwProjectionMismatch(
        sessionId,
        Math.max(
          scan.normalDatabase.snapshotRevision,
          scan.impossibleDatabase.snapshotRevision,
        ),
      );
    }
    return matches[0]!;
  }

  private validateCreateAssignments(
    request: CreateSessionRequest,
    scan: StoreScan,
  ): void {
    let normalState: RegistrationState;
    let impossibleState: RegistrationState;
    try {
      normalState = inspectRegistrations(scan.normalDatabase, "normal");
      impossibleState = inspectRegistrations(
        scan.impossibleDatabase,
        "impossible",
      );
    } catch {
      this.throwProjectionMismatch(
        "dual-scenario",
        Math.max(
          scan.normalDatabase.snapshotRevision,
          scan.impossibleDatabase.snapshotRevision,
        ),
      );
    }

    if (
      normalState.kind !== "COMPLETE" ||
      impossibleState.kind !== "COMPLETE" ||
      !sameRegistrationIdentity(
        normalState.registrations,
        impossibleState.registrations,
      )
    ) {
      this.throwProjectionMismatch(
        "dual-scenario",
        Math.max(
          scan.normalDatabase.snapshotRevision,
          scan.impossibleDatabase.snapshotRevision,
        ),
      );
    }

    for (const role of ROLES) {
      const registration = normalState.registrations.find(
        (candidate) => candidate.role === role,
      )!;
      if (request.assignments[role] !== registration.agentId) {
        throw new EpochGuardServiceError(
          API_ERROR_STATUS.ROLE_PROFILE_MISMATCH,
          makeRoleProfileMismatchError(role, request.assignments[role]),
        );
      }
    }
  }

  private partitionForScenario(scenarioId: ScenarioId): Partition {
    return scenarioId === "normal-world-v1" ? this.normal : this.impossible;
  }

  private throwProjectionMismatch(
    sessionId = "dual-scenario",
    snapshotRevision?: number,
  ): never {
    const revision =
      snapshotRevision ??
      Math.max(
        this.normal.store.snapshot().snapshotRevision,
        this.impossible.store.snapshot().snapshotRevision,
      );
    throw new EpochGuardServiceError(
      API_ERROR_STATUS.PROJECTION_MISMATCH,
      makeProjectionMismatchError(sessionId, revision),
    );
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("DualScenarioEpochGuardService is not initialized");
    }
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutationQueue.then(operation);
    this.mutationQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}
