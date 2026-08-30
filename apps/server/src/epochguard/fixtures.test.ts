import { describe, expect, it } from "vitest";
import {
  FIXTURE_ACTION,
  buildFixtureActionIntent,
  getEpochGuardFixture,
} from "./fixtures.js";
import {
  actionHash,
  buildRoleQuerySpec,
  canonicalizeAction,
  queryHash,
  type Role,
} from "./types.js";

const ACTION_CANONICAL =
  '{"campaignId":"campaign_42","estimatedCostCents":500000,"market":"SG","requestedUnits":1,"schemaVersion":1,"type":"PUBLISH_CAMPAIGN"}';
const ACTION_HASH =
  "sha256:bd99e824e58087f03cd1018fe7457865a596ae74ffbb5a707b1d2c3b6da5c202";
const QUERY_HASHES: Record<Role, string> = {
  inventory:
    "sha256:e983c6df43fd6e4cb78da19db9583f0112740ca06be695c1411273dad9f4c8c2",
  budget:
    "sha256:3497fdc0405a9ac929b9aa370295fac815db538f19efb1c51923c06d744711c4",
  policy:
    "sha256:8a14b7c6299bffad16ec48f56739aa661dcf3166011f9c554f7ead09ea8117ce",
};

describe("EpochGuard fixtures", () => {
  it("freezes the active Action and RoleQuery golden hashes", () => {
    expect(Object.isFrozen(FIXTURE_ACTION)).toBe(true);
    expect(canonicalizeAction(FIXTURE_ACTION)).toBe(ACTION_CANONICAL);
    expect(actionHash(FIXTURE_ACTION)).toBe(ACTION_HASH);

    for (const role of ["inventory", "budget", "policy"] as const) {
      const querySpec = buildRoleQuerySpec(FIXTURE_ACTION, role);
      expect(querySpec.queryHash).toBe(QUERY_HASHES[role]);
      expect(queryHash(querySpec)).toBe(QUERY_HASHES[role]);
    }
  });

  it("registers the exact interleaved impossible-world script", () => {
    const fixture = getEpochGuardFixture("impossible-collage-v1");
    expect({
      fixtureId: fixture.fixtureId,
      fixtureVersion: fixture.fixtureVersion,
      seed: fixture.seed,
      bootstrapHeadSeq: fixture.bootstrapHeadSeq,
    }).toEqual({
      fixtureId: "fixture_impossible_collage_v1",
      fixtureVersion: "impossible-collage-v1.0.0",
      seed: 21,
      bootstrapHeadSeq: 17,
    });
    expect(
      fixture.initialSteps.map((step) =>
        step.kind === "commit"
          ? `commit:${step.expectedSeq}`
          : `capture:${step.role}@${step.expectedHeadSeq}`,
      ),
    ).toEqual([
      "commit:18",
      "capture:inventory@18",
      "commit:19",
      "capture:budget@19",
      "commit:20",
      "commit:21",
      "capture:policy@21",
    ]);
    expect(fixture.refreshCapture).toEqual({
      kind: "capture",
      phase: "refresh",
      role: "budget",
      expectedHeadSeq: 21,
    });
  });

  it("registers one seq-10 cut for the normal world", () => {
    const fixture = getEpochGuardFixture("normal-world-v1");
    expect({
      fixtureId: fixture.fixtureId,
      fixtureVersion: fixture.fixtureVersion,
      seed: fixture.seed,
      bootstrapHeadSeq: fixture.bootstrapHeadSeq,
    }).toEqual({
      fixtureId: "fixture_normal_world_v1",
      fixtureVersion: "normal-world-v1.0.0",
      seed: 10,
      bootstrapHeadSeq: 9,
    });
    expect(
      fixture.initialSteps.map((step) =>
        step.kind === "commit"
          ? `commit:${step.expectedSeq}:${step.changes.length}`
          : `capture:${step.role}@${step.expectedHeadSeq}`,
      ),
    ).toEqual([
      "commit:10:3",
      "capture:inventory@10",
      "capture:budget@10",
      "capture:policy@10",
    ]);
    expect(fixture.refreshCapture).toBeNull();
  });

  it("builds a Session-scoped ActionIntent and returns isolated fixture copies", () => {
    const intent = buildFixtureActionIntent(
      "impossible-collage-v1",
      "session_fixture",
      "action_fixture",
    );
    expect(intent.actionHash).toBe(ACTION_HASH);
    expect(intent.idempotencyKey).toBe(`session_fixture:${ACTION_HASH}`);

    const first = getEpochGuardFixture("impossible-collage-v1");
    const second = getEpochGuardFixture("impossible-collage-v1");
    expect(first).not.toBe(second);
    expect(first.initialSteps).not.toBe(second.initialSteps);
    expect(first).toEqual(second);
  });
});
