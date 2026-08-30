import {
  CONTRACT_DIGEST,
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_VERSION,
  PROJECTION_MISMATCH_MESSAGE,
  UNSUPPORTED_SCHEMA_MESSAGE,
  safeDecodeSessionDashboardSnapshot,
  type SessionDashboardSnapshot,
} from "./contracts";

export type SnapshotDecodeFailure =
  | {
      kind: "UNSUPPORTED_SCHEMA";
      message: typeof UNSUPPORTED_SCHEMA_MESSAGE;
      receivedSchemaVersion: number | null;
      receivedContractVersion: string | null;
    }
  | {
      kind: "PROJECTION_MISMATCH";
      message: typeof PROJECTION_MISMATCH_MESSAGE;
      issues: string[];
    };

export type SnapshotDecodeResult =
  | { ok: true; snapshot: SessionDashboardSnapshot }
  | { ok: false; failure: SnapshotDecodeFailure };

function asRecord(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function unsupportedFailure(input: unknown): SnapshotDecodeFailure | null {
  const record = asRecord(input);
  const schemaVersion = record?.schemaVersion;
  const contractVersion = record?.contractVersion;
  const contractDigest = record?.contractDigest;
  if (
    schemaVersion === CONTRACT_SCHEMA_VERSION &&
    contractVersion === CONTRACT_VERSION &&
    contractDigest === CONTRACT_DIGEST
  ) {
    return null;
  }
  return {
    kind: "UNSUPPORTED_SCHEMA",
    message: UNSUPPORTED_SCHEMA_MESSAGE,
    receivedSchemaVersion:
      typeof schemaVersion === "number" && Number.isInteger(schemaVersion)
        ? schemaVersion
        : null,
    receivedContractVersion:
      typeof contractVersion === "string" ? contractVersion : null,
  };
}

/** Decode every HTTP and Mock payload through the active frozen contract. */
export function decodeEpochGuardSnapshot(input: unknown): SnapshotDecodeResult {
  const unsupported = unsupportedFailure(input);
  if (unsupported !== null) return { ok: false, failure: unsupported };

  const result = safeDecodeSessionDashboardSnapshot(input);
  if (result.success) return { ok: true, snapshot: result.data };

  return {
    ok: false,
    failure: {
      kind: "PROJECTION_MISMATCH",
      message: PROJECTION_MISMATCH_MESSAGE,
      issues: result.error.issues.slice(0, 6).map((issue) => {
        const path = issue.path.length === 0 ? "snapshot" : issue.path.join(".");
        return `${path}: ${issue.message}`;
      }),
    },
  };
}
