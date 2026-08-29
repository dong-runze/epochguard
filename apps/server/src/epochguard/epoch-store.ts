import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EpochDatabaseSchema,
  type EpochDatabase,
} from "./types.js";

const emptyEpochDatabase = (): EpochDatabase => ({
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
});

/**
 * Single-process EpochGuard persistence.
 *
 * The Promise queue serializes writers in one Node.js process. It is not a
 * filesystem lock and must not be used by multiple processes or service
 * replicas against the same JSON file.
 */
export class EpochStore {
  private data: EpochDatabase = emptyEpochDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = EpochDatabaseSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      const initial = emptyEpochDatabase();
      await this.persist(initial);
      this.data = initial;
    }
  }

  snapshot(): EpochDatabase {
    return structuredClone(this.data);
  }

  async mutate<T>(
    mutation: (database: EpochDatabase) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      const result = await mutation(next);

      // The Store, not callers, owns the global response-ordering revision.
      next.snapshotRevision = this.data.snapshotRevision + 1;
      const validated = EpochDatabaseSchema.parse(next);

      // Publish only after the atomic replacement succeeds. Keeping a second
      // clone also prevents a mutation callback's returned value from aliasing
      // the committed in-memory database.
      await this.persist(validated);
      this.data = structuredClone(validated);
      return result;
    });

    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async persist(data: EpochDatabase): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
