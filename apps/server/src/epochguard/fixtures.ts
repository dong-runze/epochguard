import {
  ActionCanonicalFieldsSchema,
  ActionIntentSchema,
  ROLES,
  ScenarioIdSchema,
  actionHash,
  buildRoleQuerySpec,
  type ActionCanonicalFields,
  type ActionIntent,
  type EpochDatabase,
  type JsonValue,
  type Role,
  type RoleQuerySpec,
  type ScenarioId,
  type Source,
  type WorldCommit,
} from "./types.js";
import {
  WorldLedger,
  resourceIdFor,
  type WorldChangeInput,
} from "./world-ledger.js";

export const FIXTURE_ACTION = Object.freeze(
  ActionCanonicalFieldsSchema.parse({
    schemaVersion: 1,
    type: "PUBLISH_CAMPAIGN",
    campaignId: "campaign_42",
    requestedUnits: 1,
    estimatedCostCents: 500_000,
    market: "SG",
  }),
);

export interface FixtureResourceChange {
  source: Source;
  entityKey: string;
  value: JsonValue;
  sourceRevision?: number;
}

export interface FixtureCommitStep {
  kind: "commit";
  expectedSeq: number;
  reason: string;
  createdAt: string;
  changes: readonly FixtureResourceChange[];
}

export interface FixtureCaptureStep {
  kind: "capture";
  phase: "initial" | "refresh";
  role: Role;
  expectedHeadSeq: number;
}

export type FixtureInitialStep = FixtureCommitStep | FixtureCaptureStep;

export type RoleQuerySpecsByRole = {
  [CurrentRole in Role]: Extract<RoleQuerySpec, { role: CurrentRole }>;
};

export interface EpochGuardFixture {
  schemaVersion: 1;
  fixtureId: string;
  fixtureVersion: string;
  seed: number;
  scenarioId: ScenarioId;
  bootstrapHeadSeq: number;
  action: ActionCanonicalFields;
  querySpecs: Readonly<RoleQuerySpecsByRole>;
  initialSteps: readonly FixtureInitialStep[];
  refreshCapture: FixtureCaptureStep | null;
}

function querySpecsFor(
  action: ActionCanonicalFields,
): RoleQuerySpecsByRole {
  return Object.fromEntries(
    ROLES.map((role) => [role, buildRoleQuerySpec(action, role)]),
  ) as RoleQuerySpecsByRole;
}

function normalFixture(): EpochGuardFixture {
  const action = ActionCanonicalFieldsSchema.parse(FIXTURE_ACTION);
  return {
    schemaVersion: 1,
    fixtureId: "fixture_normal_world_v1",
    fixtureVersion: "normal-world-v1.0.0",
    seed: 10,
    scenarioId: "normal-world-v1",
    bootstrapHeadSeq: 9,
    action,
    querySpecs: querySpecsFor(action),
    initialSteps: [
      {
        kind: "commit",
        expectedSeq: 10,
        reason: "normal fixture establishes one jointly valid World cut",
        createdAt: "2025-01-01T00:00:10.000Z",
        changes: [
          {
            source: "inventory",
            entityKey: action.campaignId,
            value: { availableUnits: 1 },
          },
          {
            source: "budget",
            entityKey: action.campaignId,
            value: { remainingBudgetCents: 800_000 },
          },
          {
            source: "policy",
            entityKey: action.market,
            value: { permitted: true },
          },
        ],
      },
      {
        kind: "capture",
        phase: "initial",
        role: "inventory",
        expectedHeadSeq: 10,
      },
      {
        kind: "capture",
        phase: "initial",
        role: "budget",
        expectedHeadSeq: 10,
      },
      {
        kind: "capture",
        phase: "initial",
        role: "policy",
        expectedHeadSeq: 10,
      },
    ],
    refreshCapture: null,
  };
}

function impossibleFixture(): EpochGuardFixture {
  const action = ActionCanonicalFieldsSchema.parse(FIXTURE_ACTION);
  return {
    schemaVersion: 1,
    fixtureId: "fixture_impossible_collage_v1",
    fixtureVersion: "impossible-collage-v1.0.0",
    seed: 21,
    scenarioId: "impossible-collage-v1",
    bootstrapHeadSeq: 17,
    action,
    querySpecs: querySpecsFor(action),
    initialSteps: [
      {
        kind: "commit",
        expectedSeq: 18,
        reason: "impossible fixture publishes inventory availability",
        createdAt: "2025-01-01T00:00:18.000Z",
        changes: [
          {
            source: "inventory",
            entityKey: action.campaignId,
            value: { availableUnits: 1 },
          },
        ],
      },
      {
        kind: "capture",
        phase: "initial",
        role: "inventory",
        expectedHeadSeq: 18,
      },
      {
        kind: "commit",
        expectedSeq: 19,
        reason: "impossible fixture publishes sufficient budget",
        createdAt: "2025-01-01T00:00:19.000Z",
        changes: [
          {
            source: "budget",
            entityKey: action.campaignId,
            value: { remainingBudgetCents: 800_000 },
          },
        ],
      },
      {
        kind: "capture",
        phase: "initial",
        role: "budget",
        expectedHeadSeq: 19,
      },
      {
        kind: "commit",
        expectedSeq: 20,
        reason: "impossible fixture exhausts budget",
        createdAt: "2025-01-01T00:00:20.000Z",
        changes: [
          {
            source: "budget",
            entityKey: action.campaignId,
            value: { remainingBudgetCents: 0 },
          },
        ],
      },
      {
        kind: "commit",
        expectedSeq: 21,
        reason: "impossible fixture publishes policy permission",
        createdAt: "2025-01-01T00:00:21.000Z",
        changes: [
          {
            source: "policy",
            entityKey: action.market,
            value: { permitted: true },
          },
        ],
      },
      {
        kind: "capture",
        phase: "initial",
        role: "policy",
        expectedHeadSeq: 21,
      },
    ],
    refreshCapture: {
      kind: "capture",
      phase: "refresh",
      role: "budget",
      expectedHeadSeq: 21,
    },
  };
}

/** Returns an isolated copy so a caller cannot mutate the registered fixture. */
export function getEpochGuardFixture(scenarioId: ScenarioId): EpochGuardFixture {
  const parsedScenarioId = ScenarioIdSchema.parse(scenarioId);
  const fixture =
    parsedScenarioId === "normal-world-v1"
      ? normalFixture()
      : impossibleFixture();
  return structuredClone(fixture);
}

/** Builds the immutable ActionIntent fields that are scoped to a new Session. */
export function buildFixtureActionIntent(
  scenarioId: ScenarioId,
  sessionId: string,
  actionId: string,
): ActionIntent {
  const fixture = getEpochGuardFixture(scenarioId);
  const hashedAction = actionHash(fixture.action);
  return ActionIntentSchema.parse({
    ...fixture.action,
    actionId,
    sessionId,
    actionHash: hashedAction,
    idempotencyKey: `${sessionId}:${hashedAction}`,
  });
}

/**
 * Starts a deterministic scenario at its declared pre-commit boundary. This is
 * intentionally valid only for a fresh fixture World; it never rewinds history.
 */
export function initializeFixtureWorld(
  database: EpochDatabase,
  fixture: EpochGuardFixture,
): void {
  if (
    database.headSeq !== 0 ||
    database.worldCommits.length !== 0 ||
    database.resourceVersions.length !== 0
  ) {
    throw new Error("Fixture World initialization requires an empty World ledger");
  }
  database.headSeq = fixture.bootstrapHeadSeq;
}

/** Applies one registered commit step and verifies its authoritative sequence. */
export function applyFixtureCommit(
  database: EpochDatabase,
  ledger: WorldLedger,
  step: FixtureCommitStep,
): WorldCommit {
  const changes: WorldChangeInput[] = step.changes.map((change) => ({
    resourceId: resourceIdFor(change.source, change.entityKey),
    value: change.value,
    sourceRevision: change.sourceRevision ?? step.expectedSeq,
  }));
  return ledger.commit(database, {
    changes,
    reason: step.reason,
    expectedSeq: step.expectedSeq,
    createdAt: step.createdAt,
  });
}
