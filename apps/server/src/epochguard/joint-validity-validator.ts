import { randomUUID } from "node:crypto";
import {
  JointValidityCertificateSchema,
  NoCutProofSchema,
  ROLES,
  ResourceVersionSchema,
  ValidationRecordSchema,
  canonicalJson,
  sha256Digest,
  type DependencyCertificate,
  type EpochDatabase,
  type FailureCode,
  type JointValidityCertificate,
  type NoCutProof,
  type ObservationReceipt,
  type ResourceVersion,
  type Role,
  type ValidationRecord,
} from "./types.js";
import {
  DecisionNormalizationError,
  resolveBoundDecision,
} from "./decision-parser.js";

export const JOINT_VALIDITY_VALIDATOR_VERSION = "epochguard-jv-v1" as const;

export class JointValidityValidationError extends Error {
  constructor(
    public readonly reasonCode: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = "JointValidityValidationError";
  }
}

/**
 * Narrow hand-off to the authoritative world-history index.  EG-03 must not
 * infer or duplicate EG-02's resourceId encoding, so every Receipt binding is
 * explicit in the lookup and repeated in the resolution for fail-closed
 * verification here.
 */
export type ResourceVersionLookup = Readonly<{
  receiptId: string;
  source: ObservationReceipt["source"];
  entityKey: string;
  sourceRevision: number;
  valueHash: string;
  observedAtSeq: number;
  validatedAtHead: number;
}>;

export type ResourceVersionResolution = Readonly<{
  source: ObservationReceipt["source"];
  entityKey: string;
  resourceVersion: ResourceVersion;
}>;

export type ResourceVersionResolver = (
  lookup: ResourceVersionLookup,
) => ResourceVersionResolution | null;

export type JointValidityValidationOptions = {
  resolveResourceVersion: ResourceVersionResolver;
  validationId?: string;
  jointValidityCertificateId?: string;
  noCutProofId?: string;
  createdAt?: string;
  verificationLatencyMs?: number;
};

export type JointValidityValidationResult = {
  validationRecord: ValidationRecord;
  jointValidityCertificate: JointValidityCertificate | null;
  noCutProof: NoCutProof | null;
  currentInvalidAgentIds: string[];
};

type ResolvedInterval = {
  role: Role;
  ownerAgentId: string;
  decision: DependencyCertificate;
  receipt: ObservationReceipt;
  version: ResourceVersion;
  effectiveUntil: number;
};

function fail(reasonCode: FailureCode, message: string): never {
  throw new JointValidityValidationError(reasonCode, message);
}

function requireUnique<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  label: string,
): T {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    fail("DECISION_INVALID", `${label} must resolve to exactly one record`);
  }
  return matches[0] as T;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function intervalCoversHead(interval: ResolvedInterval, head: number): boolean {
  return (
    interval.version.validFromSeq <= head &&
    (interval.version.validUntilSeq === null ||
      head < interval.version.validUntilSeq)
  );
}

export function jointValidityDependencySetHash(
  receiptIds: readonly string[],
): string {
  return sha256Digest(canonicalJson([...receiptIds].sort(compareIds)));
}

function activeDecisionTuple(
  database: Readonly<EpochDatabase>,
  sessionId: string,
): {
  session: EpochDatabase["sessions"][number];
  ids: [string, string, string];
  decisions: [
    DependencyCertificate,
    DependencyCertificate,
    DependencyCertificate,
  ];
} {
  const session = requireUnique(
    database.sessions,
    (candidate) => candidate.sessionId === sessionId,
    "EpochGuard Session",
  );
  const pointer = session.activeDecisionCertificateIds;
  const candidates = [pointer.inventory, pointer.budget, pointer.policy];
  if (candidates.some((id) => id === null)) {
    fail(
      "DECISION_INVALID",
      "Joint validity requires one active Decision for every frozen Role",
    );
  }
  const ids = candidates as [string, string, string];
  if (new Set(ids).size !== ROLES.length) {
    fail("DECISION_INVALID", "Active Decision IDs must be distinct");
  }
  const decisions = ids.map((id, index) => {
    const decision = requireUnique(
      database.decisions,
      (candidate) => candidate.certificateId === id,
      "Active Decision",
    );
    if (decision.role !== ROLES[index]) {
      fail(
        "DECISION_INVALID",
        "Active Decisions must be ordered inventory, budget, policy",
      );
    }
    return decision;
  }) as [DependencyCertificate, DependencyCertificate, DependencyCertificate];
  return { session, ids, decisions };
}

function resolveIntervals(
  database: Readonly<EpochDatabase>,
  session: EpochDatabase["sessions"][number],
  decisions: readonly DependencyCertificate[],
  head: number,
  resolver: ResourceVersionResolver,
): ResolvedInterval[] {
  const intervals = decisions.map((decision) => {
    let binding;
    try {
      binding = resolveBoundDecision(database, session, decision);
    } catch (error) {
      if (error instanceof DecisionNormalizationError) {
        fail(error.reasonCode, error.message);
      }
      throw error;
    }

    const lookup: ResourceVersionLookup = {
      receiptId: binding.receipt.receiptId,
      source: binding.receipt.source,
      entityKey: binding.receipt.entityKey,
      sourceRevision: binding.receipt.sourceRevision,
      valueHash: binding.receipt.valueHash,
      observedAtSeq: binding.receipt.observedAtSeq,
      validatedAtHead: head,
    };
    let candidate: ResourceVersionResolution | null;
    try {
      candidate = resolver(lookup);
    } catch {
      fail(
        "HISTORY_UNVERIFIABLE",
        `World history lookup failed for Receipt ${binding.receipt.receiptId}`,
      );
    }
    if (!candidate) {
      fail(
        "HISTORY_UNVERIFIABLE",
        `World history is unavailable for Receipt ${binding.receipt.receiptId}`,
      );
    }
    if (
      candidate.source !== lookup.source ||
      candidate.entityKey !== lookup.entityKey
    ) {
      fail(
        "BINDING_MISMATCH",
        `World history resource does not match Receipt ${binding.receipt.receiptId}`,
      );
    }
    const parsedVersion = ResourceVersionSchema.safeParse(
      candidate.resourceVersion,
    );
    if (!parsedVersion.success) {
      fail(
        "HISTORY_UNVERIFIABLE",
        `World history is unavailable for Receipt ${binding.receipt.receiptId}`,
      );
    }
    const version = parsedVersion.data;
    if (version.sourceRevision !== binding.receipt.sourceRevision) {
      fail(
        "HISTORY_UNVERIFIABLE",
        `World history revision does not match Receipt ${binding.receipt.receiptId}`,
      );
    }
    if (version.valueHash !== binding.receipt.valueHash) {
      fail(
        "BINDING_MISMATCH",
        `World history value does not match Receipt ${binding.receipt.receiptId}`,
      );
    }
    if (
      version.validUntilSeq !== null &&
      version.validUntilSeq > head
    ) {
      fail(
        "HISTORY_UNVERIFIABLE",
        "A closed Resource Version cannot end beyond the current World head",
      );
    }
    const effectiveUntil = version.validUntilSeq ?? head + 1;
    if (
      version.validFromSeq > binding.receipt.observedAtSeq ||
      binding.receipt.observedAtSeq >= effectiveUntil ||
      binding.receipt.observedAtSeq > head
    ) {
      fail(
        "HISTORY_UNVERIFIABLE",
        `Receipt ${binding.receipt.receiptId} is not inside its authoritative interval`,
      );
    }
    return {
      role: decision.role,
      ownerAgentId: decision.agentId,
      decision,
      receipt: binding.receipt,
      version,
      effectiveUntil,
    };
  });

  if (new Set(intervals.map((interval) => interval.receipt.receiptId)).size !== 3) {
    fail("DECISION_INVALID", "Active Decisions must bind three distinct Receipts");
  }
  return intervals;
}

function makeValidationRecord(
  values: {
    validationId: string;
    sessionId: string;
    actionHash: string;
    baseSessionRevision: number;
    decisionCertificateIds: [string, string, string];
    dependencySetHash: string;
    validatedHead: number;
    outcome: ValidationRecord["outcome"];
    lowerBound: number;
    upperBound: number;
    jointValidityCertificateId: string | null;
    noCutProofId: string | null;
    verificationLatencyMs: number;
    createdAt: string;
  },
): ValidationRecord {
  return ValidationRecordSchema.parse({
    ...values,
    refreshPlanId: null,
  });
}

export function validateJointValidity(
  database: Readonly<EpochDatabase>,
  sessionId: string,
  options: JointValidityValidationOptions,
): JointValidityValidationResult {
  const head = database.headSeq;
  if (!Number.isSafeInteger(head) || head < 0 || head >= Number.MAX_SAFE_INTEGER) {
    fail(
      "HISTORY_UNVERIFIABLE",
      "World head cannot be represented safely with the H+1 open-interval fence",
    );
  }

  const { session, ids, decisions } = activeDecisionTuple(database, sessionId);
  const intervals = resolveIntervals(
    database,
    session,
    decisions,
    head,
    options.resolveResourceVersion,
  );
  const receiptIds = intervals.map((interval) => interval.receipt.receiptId);
  const dependencySetHash = jointValidityDependencySetHash(receiptIds);
  const lowerBound = Math.max(
    ...intervals.map((interval) => interval.version.validFromSeq),
  );
  const upperBound = Math.min(
    ...intervals.map((interval) => interval.effectiveUntil),
  );
  const currentInvalidAgentIds = [
    ...new Set(
      intervals
        .filter((interval) => !intervalCoversHead(interval, head))
        .map((interval) => interval.ownerAgentId),
    ),
  ].sort(compareIds);

  const validationId = options.validationId ?? randomUUID();
  const createdAt = options.createdAt ?? new Date().toISOString();
  const verificationLatencyMs = options.verificationLatencyMs ?? 0;

  if (lowerBound >= upperBound) {
    if (currentInvalidAgentIds.length === 0) {
      fail(
        "HISTORY_UNVERIFIABLE",
        "A No-Cut result must have at least one invalid owner at the current head",
      );
    }
    const earliestEnding = intervals
      .filter((interval) => interval.effectiveUntil === upperBound)
      .sort((left, right) =>
        compareIds(left.receipt.receiptId, right.receipt.receiptId),
      )[0];
    const latestStarting = intervals
      .filter((interval) => interval.version.validFromSeq === lowerBound)
      .sort((left, right) =>
        compareIds(left.receipt.receiptId, right.receipt.receiptId),
      )[0];
    if (earliestEnding === undefined || latestStarting === undefined) {
      fail("HISTORY_UNVERIFIABLE", "Unable to construct a deterministic No-Cut witness");
    }
    const proofId = options.noCutProofId ?? randomUUID();
    const noCutProof = NoCutProofSchema.parse({
      proofId,
      validationId,
      reason: "NO_VALID_OBSERVED_WORLD_CUT",
      sessionId: session.sessionId,
      actionHash: session.actionHash,
      dependencySetHash,
      decisionCertificateIds: ids,
      validatedAtHead: head,
      lowerBound,
      upperBound,
      latestStartingReceiptId: latestStarting.receipt.receiptId,
      earliestEndingReceiptId: earliestEnding.receipt.receiptId,
      conflictWitnessReceiptIds: [
        earliestEnding.receipt.receiptId,
        latestStarting.receipt.receiptId,
      ],
      refreshAgentIds: currentInvalidAgentIds,
      createdAt,
    });
    const validationRecord = makeValidationRecord({
      validationId,
      sessionId: session.sessionId,
      actionHash: session.actionHash,
      baseSessionRevision: session.sessionRevision,
      decisionCertificateIds: ids,
      dependencySetHash,
      validatedHead: head,
      outcome: "NO_VALID_OBSERVED_WORLD_CUT",
      lowerBound,
      upperBound,
      jointValidityCertificateId: null,
      noCutProofId: proofId,
      verificationLatencyMs,
      createdAt,
    });
    return {
      validationRecord,
      jointValidityCertificate: null,
      noCutProof,
      currentInvalidAgentIds,
    };
  }

  if (currentInvalidAgentIds.length > 0) {
    const validationRecord = makeValidationRecord({
      validationId,
      sessionId: session.sessionId,
      actionHash: session.actionHash,
      baseSessionRevision: session.sessionRevision,
      decisionCertificateIds: ids,
      dependencySetHash,
      validatedHead: head,
      outcome: "HISTORICAL_BUT_STALE_NOW",
      lowerBound,
      upperBound,
      jointValidityCertificateId: null,
      noCutProofId: null,
      verificationLatencyMs,
      createdAt,
    });
    return {
      validationRecord,
      jointValidityCertificate: null,
      noCutProof: null,
      currentInvalidAgentIds,
    };
  }

  const outcome = decisions.some((decision) => decision.verdict === "DENY")
    ? "CONSISTENT_DENY"
    : "VALID_CURRENT_ALLOW";
  const jointValidityCertificateId =
    options.jointValidityCertificateId ?? randomUUID();
  const jointValidityCertificate = JointValidityCertificateSchema.parse({
    certificateId: jointValidityCertificateId,
    validationId,
    sessionId: session.sessionId,
    actionHash: session.actionHash,
    dependencySetHash,
    validatedAtHead: head,
    selectedCutSeq: head,
    currentHeadCovered: true,
    decisionCertificateIds: ids,
    intervals: intervals.map((interval) => ({
      receiptId: interval.receipt.receiptId,
      source: interval.receipt.source,
      sourceRevision: interval.receipt.sourceRevision,
      from: interval.version.validFromSeq,
      until: interval.version.validUntilSeq,
    })),
    validatorVersion: JOINT_VALIDITY_VALIDATOR_VERSION,
    createdAt,
  });
  const validationRecord = makeValidationRecord({
    validationId,
    sessionId: session.sessionId,
    actionHash: session.actionHash,
    baseSessionRevision: session.sessionRevision,
    decisionCertificateIds: ids,
    dependencySetHash,
    validatedHead: head,
    outcome,
    lowerBound,
    upperBound,
    jointValidityCertificateId,
    noCutProofId: null,
    verificationLatencyMs,
    createdAt,
  });
  return {
    validationRecord,
    jointValidityCertificate,
    noCutProof: null,
    currentInvalidAgentIds,
  };
}
