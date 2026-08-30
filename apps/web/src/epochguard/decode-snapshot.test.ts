import { describe, expect, it } from "vitest";
import {
  CONTRACT_DIGEST,
  CONTRACT_VERSION,
  SessionDashboardSnapshotSchema,
} from "./contracts";
import { decodeEpochGuardSnapshot } from "./decode-snapshot";
import { mockScenario } from "./preview/mock-snapshots";

describe("decodeEpochGuardSnapshot v8 boundary", () => {
  it("accepts the current v8 version/digest tuple", () => {
    const result = decodeEpochGuardSnapshot(
      mockScenario("normal-ready").payload,
    );

    expect(result.ok).toBe(true);
  });

  it.each([
    {
      contractVersion: "epochguard-contract-v7",
      contractDigest: CONTRACT_DIGEST,
    },
    {
      contractVersion: CONTRACT_VERSION,
      contractDigest:
        "sha256:4dfbeb9e55de7ca17a19f5fb8f99494b17e441af0f877767027284d3ae646361",
    },
  ])("rejects an obsolete contract tuple", (obsolete) => {
    const current = SessionDashboardSnapshotSchema.parse(
      mockScenario("normal-ready").payload,
    );
    const payload = { ...current, ...obsolete };

    expect(decodeEpochGuardSnapshot(payload)).toMatchObject({
      ok: false,
      failure: { kind: "UNSUPPORTED_SCHEMA" },
    });
  });

  it("classifies a malformed projection under the v8 tuple separately", () => {
    const current = SessionDashboardSnapshotSchema.parse(
      mockScenario("normal-ready").payload,
    );
    const payload = { ...current, agents: [] };

    expect(decodeEpochGuardSnapshot(payload)).toMatchObject({
      ok: false,
      failure: { kind: "PROJECTION_MISMATCH" },
    });
  });
});
