import {
  OpaqueIdSchema,
  ResourceVersionSchema,
  SourceSchema,
  WorldCommitSchema,
  canonicalJson,
  sha256Digest,
  type EpochDatabase,
  type JsonValue,
  type ResourceVersion,
  type Source,
  type WorldCommit,
} from "./types.js";

export interface WorldChangeInput {
  resourceId: string;
  value: JsonValue;
  sourceRevision?: number;
}

export interface WorldCommitInput {
  changes: readonly WorldChangeInput[];
  reason: string;
  expectedSeq?: number;
  createdAt?: string;
}

export interface WorldLedgerOptions {
  now?: () => string;
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function versionIdFor(
  resourceId: string,
  sourceRevision: number,
  validFromSeq: number,
  valueHash: string,
): string {
  const digest = sha256Digest(
    canonicalJson({
      resourceId,
      sourceRevision,
      validFromSeq,
      valueHash,
    }),
  );
  return `rv_${validFromSeq}_${digest.slice("sha256:".length)}`;
}

function assertWorldHead(database: EpochDatabase): void {
  if (!Number.isSafeInteger(database.headSeq) || database.headSeq < 0) {
    throw new Error("World head must be a non-negative safe integer");
  }
}

function openVersion(
  database: EpochDatabase,
  resourceId: string,
): ResourceVersion | undefined {
  const matches = database.resourceVersions.filter(
    (version) =>
      version.resourceId === resourceId && version.validUntilSeq === null,
  );
  if (matches.length > 1) {
    throw new Error(`Resource ${resourceId} has multiple open versions`);
  }
  return matches[0];
}

/** Maps the frozen query source and entity key to the authoritative resource. */
export function resourceIdFor(source: Source, entityKey: string): string {
  return OpaqueIdSchema.parse(
    `${SourceSchema.parse(source)}:${OpaqueIdSchema.parse(entityKey)}`,
  );
}

/** Resolves the unique version valid at an integer World sequence. */
export function resolveResourceVersionAt(
  database: EpochDatabase,
  resourceId: string,
  seq: number,
): ResourceVersion | undefined {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error("World sequence must be a non-negative safe integer");
  }
  const matches = database.resourceVersions.filter(
    (version) =>
      version.resourceId === resourceId &&
      version.validFromSeq <= seq &&
      (version.validUntilSeq === null || seq < version.validUntilSeq),
  );
  if (matches.length > 1) {
    throw new Error(`Resource ${resourceId} has overlapping versions at ${seq}`);
  }
  return matches[0];
}

/** Resolves the immutable version named by a Receipt's source revision. */
function resolveResourceVersionByResourceRevision(
  database: EpochDatabase,
  resourceId: string,
  sourceRevision: number,
): ResourceVersion | undefined {
  const matches = database.resourceVersions.filter(
    (version) =>
      version.resourceId === resourceId &&
      version.sourceRevision === sourceRevision,
  );
  if (matches.length > 1) {
    throw new Error(
      `Resource ${resourceId} has duplicate source revision ${sourceRevision}`,
    );
  }
  return matches[0];
}

/**
 * The sole public ResourceVersion identity rule used by Receipts: source,
 * entity key, and source revision. A revision is never matched globally.
 */
export function resolveResourceVersionByIdentity(
  database: EpochDatabase,
  source: Source,
  entityKey: string,
  sourceRevision: number,
): ResourceVersion | undefined {
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
    throw new Error("Source revision must be a non-negative safe integer");
  }
  return resolveResourceVersionByResourceRevision(
    database,
    resourceIdFor(source, entityKey),
    sourceRevision,
  );
}

/**
 * Append-only authoritative World ledger. A commit first constructs and
 * validates every new record, then closes old versions at the same sequence.
 */
export class WorldLedger {
  private readonly now: () => string;

  constructor(options: WorldLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  commit(database: EpochDatabase, input: WorldCommitInput): WorldCommit {
    assertWorldHead(database);
    if (input.changes.length === 0) {
      throw new Error("A World commit must change at least one resource");
    }

    const nextSeq = database.headSeq + 1;
    if (!Number.isSafeInteger(nextSeq)) {
      throw new Error("World head cannot be incremented safely");
    }
    if (input.expectedSeq !== undefined && input.expectedSeq !== nextSeq) {
      throw new Error(
        `Expected World sequence ${input.expectedSeq}, received ${nextSeq}`,
      );
    }
    if (database.worldCommits.some((commit) => commit.seq === nextSeq)) {
      throw new Error(`World commit sequence ${nextSeq} already exists`);
    }

    const sortedChanges = [...input.changes].sort((left, right) =>
      left.resourceId < right.resourceId
        ? -1
        : left.resourceId > right.resourceId
          ? 1
          : 0,
    );
    const resourceIds = new Set<string>();
    const pendingVersions: ResourceVersion[] = [];
    const versionsToClose: ResourceVersion[] = [];
    const knownVersionIds = new Set(
      database.resourceVersions.map((version) => version.id),
    );

    for (const change of sortedChanges) {
      if (resourceIds.has(change.resourceId)) {
        throw new Error(
          `World commit changes resource ${change.resourceId} more than once`,
        );
      }
      resourceIds.add(change.resourceId);

      const previous = openVersion(database, change.resourceId);
      if (previous !== undefined && previous.validFromSeq >= nextSeq) {
        throw new Error(
          `Open version for ${change.resourceId} starts at or after the next commit`,
        );
      }

      const sourceRevision = change.sourceRevision ?? nextSeq;
      if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
        throw new Error("Source revision must be a non-negative safe integer");
      }
      if (
        resolveResourceVersionByResourceRevision(
          database,
          change.resourceId,
          sourceRevision,
        ) !== undefined
      ) {
        throw new Error(
          `Resource ${change.resourceId} already has source revision ${sourceRevision}`,
        );
      }

      const value = cloneJson(change.value);
      const valueHash = sha256Digest(canonicalJson(value));
      const version = ResourceVersionSchema.parse({
        id: versionIdFor(
          change.resourceId,
          sourceRevision,
          nextSeq,
          valueHash,
        ),
        resourceId: change.resourceId,
        sourceRevision,
        value,
        valueHash,
        validFromSeq: nextSeq,
        validUntilSeq: null,
      });
      if (knownVersionIds.has(version.id)) {
        throw new Error(`Resource version ID collision: ${version.id}`);
      }
      knownVersionIds.add(version.id);
      pendingVersions.push(version);
      if (previous !== undefined) versionsToClose.push(previous);
    }

    const commit = WorldCommitSchema.parse({
      seq: nextSeq,
      changes: pendingVersions.map((version) => {
        const previous = openVersion(database, version.resourceId);
        return {
          resourceId: version.resourceId,
          previousVersionId: previous?.id ?? null,
          nextVersionId: version.id,
        };
      }),
      reason: input.reason,
      createdAt: input.createdAt ?? this.now(),
    });

    versionsToClose.map((version) =>
      ResourceVersionSchema.parse({ ...version, validUntilSeq: nextSeq }),
    );
    for (const version of versionsToClose) {
      version.validUntilSeq = nextSeq;
    }
    database.resourceVersions.push(...pendingVersions);
    database.worldCommits.push(commit);
    database.headSeq = nextSeq;
    return commit;
  }

  currentVersion(
    database: EpochDatabase,
    resourceId: string,
  ): ResourceVersion | undefined {
    assertWorldHead(database);
    return resolveResourceVersionAt(database, resourceId, database.headSeq);
  }
}
