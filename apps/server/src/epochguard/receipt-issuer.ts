import { randomBytes } from "node:crypto";
import {
  ActionIntentSchema,
  ObservationReceiptSchema,
  RoleQuerySpecSchema,
  RunAssignmentSchema,
  buildRoleQuerySpec,
  canonicalJson,
  type ActionIntent,
  type EpochDatabase,
  type JsonValue,
  type ObservationReceipt,
  type ResourceVersion,
  type RoleQuerySpec,
  type RunAssignment,
} from "./types.js";
import {
  resolveResourceVersionAt,
  resolveResourceVersionByIdentity,
  resourceIdFor,
} from "./world-ledger.js";

export interface ReceiptIssuerOptions {
  now?: () => string;
  nonceFactory?: () => string;
}

export interface IssueObservationInput {
  action: ActionIntent;
  assignment: RunAssignment;
  querySpec: RoleQuerySpec;
}

export interface IssuedObservation {
  receipt: ObservationReceipt;
  resourceVersion: ResourceVersion;
}

function asCanonicalJson(value: unknown): string {
  return canonicalJson(value as JsonValue);
}

function assertCanonicalEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (asCanonicalJson(actual) !== asCanonicalJson(expected)) {
    throw new Error(message);
  }
}

/**
 * Resolves and validates the authoritative interval behind a server Receipt.
 * A finite upper bound must already be at or behind the current World head.
 */
export function resolveReceiptResourceVersion(
  database: EpochDatabase,
  receiptInput: ObservationReceipt,
): ResourceVersion {
  const receipt = ObservationReceiptSchema.parse(receiptInput);
  if (receipt.observedAtSeq > database.headSeq) {
    throw new Error("Receipt observation is ahead of the authoritative World head");
  }

  const version = resolveResourceVersionByIdentity(
    database,
    receipt.source,
    receipt.entityKey,
    receipt.sourceRevision,
  );
  if (version === undefined) {
    throw new Error("Receipt source revision is not present in World history");
  }
  if (version.valueHash !== receipt.valueHash) {
    throw new Error("Receipt value hash does not match World history");
  }
  if (receipt.observedAtSeq < version.validFromSeq) {
    throw new Error("Receipt predates its ResourceVersion");
  }
  if (
    version.validUntilSeq !== null &&
    receipt.observedAtSeq >= version.validUntilSeq
  ) {
    throw new Error("Receipt is outside the ResourceVersion half-open interval");
  }
  if (
    version.validUntilSeq !== null &&
    version.validUntilSeq > database.headSeq
  ) {
    throw new Error("Finite ResourceVersion horizon is ahead of the World head");
  }
  return version;
}

/** Issues one server-owned, assignment-bound observation at the current head. */
export class ReceiptIssuer {
  private readonly now: () => string;
  private readonly nonceFactory: () => string;

  constructor(options: ReceiptIssuerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.nonceFactory =
      options.nonceFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  issue(
    database: EpochDatabase,
    input: IssueObservationInput,
  ): IssuedObservation {
    const action = ActionIntentSchema.parse(input.action);
    const assignment = RunAssignmentSchema.parse(input.assignment);
    const querySpec = RoleQuerySpecSchema.parse(input.querySpec);

    if (
      assignment.status !== "CREATED" ||
      assignment.boundRunId !== null ||
      assignment.consumedByDecisionCertificateId !== null
    ) {
      throw new Error("Receipt issuance requires an unused CREATED Assignment");
    }
    if (
      assignment.sessionId !== action.sessionId ||
      assignment.actionHash !== action.actionHash
    ) {
      throw new Error("Assignment is not bound to the supplied ActionIntent");
    }
    if (
      assignment.role !== querySpec.role ||
      assignment.queryHash !== querySpec.queryHash
    ) {
      throw new Error("Assignment is not bound to the supplied RoleQuerySpec");
    }

    const expectedQuerySpec = buildRoleQuerySpec(action, assignment.role);
    assertCanonicalEqual(
      querySpec,
      expectedQuerySpec,
      "RoleQuerySpec does not reconstruct from the frozen ActionIntent",
    );

    const storedAssignments = database.runAssignments.filter(
      (candidate) => candidate.assignmentId === assignment.assignmentId,
    );
    if (storedAssignments.length !== 1) {
      throw new Error("Receipt issuance requires exactly one stored Assignment");
    }
    assertCanonicalEqual(
      storedAssignments[0],
      assignment,
      "Stored Assignment differs from the Receipt issuance input",
    );

    const storedQueries = database.roleQuerySpecs.filter(
      (candidate) => candidate.queryHash === querySpec.queryHash,
    );
    if (storedQueries.length === 0) {
      throw new Error("Receipt issuance requires a stored RoleQuerySpec");
    }
    for (const storedQuery of storedQueries) {
      assertCanonicalEqual(
        storedQuery,
        querySpec,
        "Stored RoleQuerySpec differs from the Receipt issuance input",
      );
    }

    if (
      database.receipts.some(
        (receipt) =>
          receipt.receiptId === assignment.receiptId ||
          receipt.runAssignmentId === assignment.assignmentId,
      )
    ) {
      throw new Error("Assignment already has an issued Receipt");
    }

    const resourceId = resourceIdFor(querySpec.source, querySpec.entityKey);
    const resourceVersion = resolveResourceVersionAt(
      database,
      resourceId,
      database.headSeq,
    );
    if (resourceVersion === undefined) {
      throw new Error("No authoritative ResourceVersion exists at the World head");
    }

    const nonce = this.nonceFactory();
    if (database.receipts.some((receipt) => receipt.nonce === nonce)) {
      throw new Error("Receipt nonce has already been issued");
    }
    const receipt = ObservationReceiptSchema.parse({
      schemaVersion: 1,
      receiptId: assignment.receiptId,
      sessionId: assignment.sessionId,
      actionHash: assignment.actionHash,
      agentId: assignment.agentId,
      runAssignmentId: assignment.assignmentId,
      role: assignment.role,
      source: querySpec.source,
      entityKey: querySpec.entityKey,
      queryHash: querySpec.queryHash,
      sourceRevision: resourceVersion.sourceRevision,
      valueHash: resourceVersion.valueHash,
      observedAtSeq: database.headSeq,
      nonce,
      issuer: "epochguard",
      issuedAt: this.now(),
    });

    // Validate the complete temporal reconstruction before making it visible.
    resolveReceiptResourceVersion(database, receipt);
    database.receipts.push(receipt);
    return { receipt, resourceVersion };
  }
}
