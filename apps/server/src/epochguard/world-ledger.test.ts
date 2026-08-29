import { describe, expect, it } from "vitest";
import {
  applyFixtureCommit,
  getEpochGuardFixture,
  initializeFixtureWorld,
} from "./fixtures.js";
import {
  WorldLedger,
  resolveResourceVersionAt,
  resolveResourceVersionByIdentity,
  resourceIdFor,
} from "./world-ledger.js";
import { canonicalJson, type EpochDatabase, type JsonValue } from "./types.js";

function emptyDatabase(): EpochDatabase {
  return {
    schemaVersion: 1,
    snapshotRevision: 0,
    headSeq: 0,
    roleAgentRegistrations: [],
    worldCommits: [],
    resourceVersions: [],
    roleQuerySpecs: [],
    runAssignments: [],
    receipts: [],
    sessions: [],
    attempts: [],
    decisions: [],
    validations: [],
    jointValidityCertificates: [],
    noCutProofs: [],
    refreshPlans: [],
    permits: [],
    effects: [],
    diagnostics: [],
    rejectedOutputArtifacts: [],
    auditEvents: [],
  };
}

function replayImpossibleFixture(): EpochDatabase {
  const database = emptyDatabase();
  const fixture = getEpochGuardFixture("impossible-collage-v1");
  const ledger = new WorldLedger();
  initializeFixtureWorld(database, fixture);
  for (const step of fixture.initialSteps) {
    if (step.kind === "commit") applyFixtureCommit(database, ledger, step);
  }
  return database;
}

describe("WorldLedger", () => {
  it("records the authoritative 18→19→20→21 commits with half-open intervals", () => {
    const database = replayImpossibleFixture();
    expect(database.headSeq).toBe(21);
    expect(database.worldCommits.map((commit) => commit.seq)).toEqual([
      18, 19, 20, 21,
    ]);

    const budgetResource = resourceIdFor("budget", "campaign_42");
    const budgetVersions = database.resourceVersions.filter(
      (version) => version.resourceId === budgetResource,
    );
    expect(budgetVersions).toHaveLength(2);
    expect(
      budgetVersions.map(({ sourceRevision, validFromSeq, validUntilSeq }) => ({
        sourceRevision,
        validFromSeq,
        validUntilSeq,
      })),
    ).toEqual([
      { sourceRevision: 19, validFromSeq: 19, validUntilSeq: 20 },
      { sourceRevision: 20, validFromSeq: 20, validUntilSeq: null },
    ]);
    expect(
      resolveResourceVersionAt(database, budgetResource, 19)?.value,
    ).toEqual({ remainingBudgetCents: 800_000 });
    expect(
      resolveResourceVersionAt(database, budgetResource, 20)?.value,
    ).toEqual({ remainingBudgetCents: 0 });
  });

  it("creates a new ResourceVersion when the same value disappears and returns", () => {
    const database = emptyDatabase();
    const ledger = new WorldLedger();
    const resourceId = resourceIdFor("policy", "SG");

    ledger.commit(database, {
      expectedSeq: 1,
      reason: "permit",
      createdAt: "2025-01-01T00:00:01.000Z",
      changes: [{ resourceId, value: { permitted: true } }],
    });
    ledger.commit(database, {
      expectedSeq: 2,
      reason: "deny",
      createdAt: "2025-01-01T00:00:02.000Z",
      changes: [{ resourceId, value: { permitted: false } }],
    });
    ledger.commit(database, {
      expectedSeq: 3,
      reason: "permit returns",
      createdAt: "2025-01-01T00:00:03.000Z",
      changes: [{ resourceId, value: { permitted: true } }],
    });

    const [first, , returned] = database.resourceVersions;
    if (first === undefined || returned === undefined) {
      throw new Error("Expected three ResourceVersions");
    }
    expect(first.valueHash).toBe(returned.valueHash);
    expect(first.id).not.toBe(returned.id);
    expect([first.validFromSeq, first.validUntilSeq]).toEqual([1, 2]);
    expect([returned.validFromSeq, returned.validUntilSeq]).toEqual([3, null]);
  });

  it("replays identical fixture input byte-identically", () => {
    const left = replayImpossibleFixture();
    const right = replayImpossibleFixture();
    const worldProjection = (database: EpochDatabase): string =>
      canonicalJson({
        headSeq: database.headSeq,
        worldCommits: database.worldCommits,
        resourceVersions: database.resourceVersions,
      } as JsonValue);

    expect(worldProjection(left)).toBe(worldProjection(right));
  });

  it("resolves identity by source + entityKey + revision, never revision alone", () => {
    const database = emptyDatabase();
    const fixture = getEpochGuardFixture("normal-world-v1");
    const ledger = new WorldLedger();
    initializeFixtureWorld(database, fixture);
    const commit = fixture.initialSteps.find(
      (step) => step.kind === "commit",
    );
    if (commit === undefined || commit.kind !== "commit") {
      throw new Error("normal fixture commit is missing");
    }
    applyFixtureCommit(database, ledger, commit);

    const inventory = resolveResourceVersionByIdentity(
      database,
      "inventory",
      "campaign_42",
      10,
    );
    const budget = resolveResourceVersionByIdentity(
      database,
      "budget",
      "campaign_42",
      10,
    );
    expect(inventory?.resourceId).toBe("inventory:campaign_42");
    expect(budget?.resourceId).toBe("budget:campaign_42");
    expect(inventory?.id).not.toBe(budget?.id);
    expect(
      resolveResourceVersionByIdentity(database, "policy", "campaign_42", 10),
    ).toBeUndefined();
  });

  it("rejects sequence and duplicate-resource violations without mutating history", () => {
    const database = emptyDatabase();
    const ledger = new WorldLedger();
    const before = structuredClone(database);
    expect(() =>
      ledger.commit(database, {
        expectedSeq: 2,
        reason: "wrong sequence",
        changes: [
          {
            resourceId: resourceIdFor("inventory", "campaign_42"),
            value: { availableUnits: 1 },
          },
        ],
      }),
    ).toThrow(/Expected World sequence/);
    expect(database).toEqual(before);

    expect(() =>
      ledger.commit(database, {
        expectedSeq: 1,
        reason: "duplicate resource",
        changes: [
          {
            resourceId: resourceIdFor("inventory", "campaign_42"),
            value: { availableUnits: 1 },
          },
          {
            resourceId: resourceIdFor("inventory", "campaign_42"),
            value: { availableUnits: 2 },
          },
        ],
      }),
    ).toThrow(/more than once/);
    expect(database).toEqual(before);
  });
});
