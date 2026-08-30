import { z } from "zod";
import type { WorkspaceManager } from "../workspace.js";
import {
  ActionIntentSchema,
  EvidencePackRelativePathSchema,
  ObservationReceiptSchema,
  RoleQuerySpecSchema,
  RunAssignmentSchema,
  buildRoleQuerySpec,
  canonicalJson,
  sha256Digest,
  type ActionIntent,
  type JsonValue,
  type ObservationReceipt,
  type ResourceVersion,
  type Role,
  type RoleQuerySpec,
  type RunAssignment,
  type Verdict,
} from "./types.js";
import {
  parseVerifiedResourceVersion,
  resourceIdFor,
} from "./world-ledger.js";

const InventoryValueSchema = z
  .object({ availableUnits: z.number().int().nonnegative() })
  .strict();
const BudgetValueSchema = z
  .object({ remainingBudgetCents: z.number().int().nonnegative() })
  .strict();
const PolicyValueSchema = z.object({ permitted: z.boolean() }).strict();

export interface EvidencePackBinding {
  runAssignmentId: string;
  sessionId: string;
  role: Role;
  actionHash: string;
  queryHash: string;
  roleProfileVersion: string;
  promptTemplateVersion: string;
}

export interface InventoryEvidencePack {
  assignment: EvidencePackBinding & { role: "inventory" };
  action: { campaignId: string; requestedUnits: number };
  observation: {
    receiptId: string;
    nonce: string;
    availableUnits: number;
    observedAtSeq: number;
  };
  decisionRule: "ALLOW iff availableUnits >= requestedUnits.";
  responseMarker: "EPOCH_DECISION";
}

export interface BudgetEvidencePack {
  assignment: EvidencePackBinding & { role: "budget" };
  action: { campaignId: string; estimatedCostCents: number };
  observation: {
    receiptId: string;
    nonce: string;
    remainingBudgetCents: number;
    observedAtSeq: number;
  };
  decisionRule: "ALLOW iff remainingBudgetCents >= estimatedCostCents.";
  responseMarker: "EPOCH_DECISION";
}

export interface PolicyEvidencePack {
  assignment: EvidencePackBinding & { role: "policy" };
  action: { campaignId: string; market: "SG" };
  observation: {
    receiptId: string;
    nonce: string;
    permitted: boolean;
    observedAtSeq: number;
  };
  decisionRule: "ALLOW iff permitted === true.";
  responseMarker: "EPOCH_DECISION";
}

export type EvidencePack =
  | InventoryEvidencePack
  | BudgetEvidencePack
  | PolicyEvidencePack;

/**
 * Recomputes the business verdict from authoritative Action and World values.
 * Model output is never an input to this function.
 */
export function evaluateAuthoritativeVerdict(
  role: Role,
  action: ActionIntent,
  value: ResourceVersion["value"],
): Verdict {
  switch (role) {
    case "inventory": {
      const observation = InventoryValueSchema.parse(value);
      return observation.availableUnits >= action.requestedUnits ? "ALLOW" : "DENY";
    }
    case "budget": {
      const observation = BudgetValueSchema.parse(value);
      return observation.remainingBudgetCents >= action.estimatedCostCents
        ? "ALLOW"
        : "DENY";
    }
    case "policy": {
      const observation = PolicyValueSchema.parse(value);
      return observation.permitted ? "ALLOW" : "DENY";
    }
  }
}

export interface EvidencePackBuildInput {
  action: ActionIntent;
  querySpec: RoleQuerySpec;
  assignment: RunAssignment;
  receipt: ObservationReceipt;
  resourceVersion: ResourceVersion;
  worldHeadSeq: number;
}

export interface BuiltCanonicalEvidencePack {
  payload: EvidencePack;
  canonicalText: string;
  canonicalBytes: Uint8Array;
  evidencePackHash: string;
  evidencePackRelativePath: string;
}

export interface WrittenCanonicalEvidencePack
  extends BuiltCanonicalEvidencePack {
  writtenRelativePath: string;
}

type EvidenceWorkspace = Pick<WorkspaceManager, "writeEvidencePackAtomic">;

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

export function evidencePackRelativePath(
  sessionId: string,
  role: Role,
  assignmentId: string,
): string {
  return EvidencePackRelativePathSchema.parse(
    `.epochguard/sessions/${sessionId}/${role}/${assignmentId}.json`,
  );
}

function bindingFor(
  assignment: RunAssignment,
): EvidencePackBinding {
  return {
    runAssignmentId: assignment.assignmentId,
    sessionId: assignment.sessionId,
    role: assignment.role,
    actionHash: assignment.actionHash,
    queryHash: assignment.queryHash,
    roleProfileVersion: assignment.roleProfileVersion,
    promptTemplateVersion: assignment.promptTemplateVersion,
  };
}

function assertBindings(
  action: ActionIntent,
  querySpec: RoleQuerySpec,
  assignment: RunAssignment,
  receipt: ObservationReceipt,
  resourceVersion: ResourceVersion,
  worldHeadSeq: number,
): void {
  if (!Number.isSafeInteger(worldHeadSeq) || worldHeadSeq < 0) {
    throw new Error("Evidence Pack World head must be a non-negative safe integer");
  }
  if (
    assignment.sessionId !== action.sessionId ||
    assignment.actionHash !== action.actionHash
  ) {
    throw new Error("Evidence Pack Assignment is not bound to its ActionIntent");
  }
  if (
    assignment.role !== querySpec.role ||
    assignment.queryHash !== querySpec.queryHash
  ) {
    throw new Error("Evidence Pack Assignment is not bound to its RoleQuerySpec");
  }
  const expectedQuerySpec = buildRoleQuerySpec(action, assignment.role);
  assertCanonicalEqual(
    querySpec,
    expectedQuerySpec,
    "Evidence Pack RoleQuerySpec does not reconstruct from ActionIntent",
  );

  if (
    receipt.receiptId !== assignment.receiptId ||
    receipt.runAssignmentId !== assignment.assignmentId ||
    receipt.sessionId !== assignment.sessionId ||
    receipt.actionHash !== assignment.actionHash ||
    receipt.agentId !== assignment.agentId ||
    receipt.role !== assignment.role ||
    receipt.queryHash !== assignment.queryHash ||
    receipt.source !== querySpec.source ||
    receipt.entityKey !== querySpec.entityKey
  ) {
    throw new Error("Evidence Pack Receipt binding does not match its Assignment");
  }

  if (
    resourceVersion.resourceId !==
      resourceIdFor(receipt.source, receipt.entityKey) ||
    resourceVersion.sourceRevision !== receipt.sourceRevision ||
    resourceVersion.valueHash !== receipt.valueHash
  ) {
    throw new Error("Evidence Pack ResourceVersion does not match its Receipt");
  }
  if (
    receipt.observedAtSeq > worldHeadSeq ||
    receipt.observedAtSeq < resourceVersion.validFromSeq ||
    (resourceVersion.validUntilSeq !== null &&
      receipt.observedAtSeq >= resourceVersion.validUntilSeq)
  ) {
    throw new Error("Evidence Pack Receipt is outside its authoritative interval");
  }
  if (
    resourceVersion.validUntilSeq !== null &&
    resourceVersion.validUntilSeq > worldHeadSeq
  ) {
    throw new Error("Evidence Pack finite horizon is ahead of the World head");
  }

  const expectedPath = evidencePackRelativePath(
    assignment.sessionId,
    assignment.role,
    assignment.assignmentId,
  );
  if (assignment.evidencePackRelativePath !== expectedPath) {
    throw new Error("Assignment Evidence Pack path is not assignment-scoped");
  }
}

function buildPayload(
  querySpec: RoleQuerySpec,
  assignment: RunAssignment,
  receipt: ObservationReceipt,
  resourceVersion: ResourceVersion,
): EvidencePack {
  const assignmentBinding = bindingFor(assignment);
  switch (querySpec.role) {
    case "inventory": {
      const observation = InventoryValueSchema.parse(resourceVersion.value);
      return {
        assignment: { ...assignmentBinding, role: "inventory" },
        action: querySpec.actionProjection,
        observation: {
          receiptId: receipt.receiptId,
          nonce: receipt.nonce,
          availableUnits: observation.availableUnits,
          observedAtSeq: receipt.observedAtSeq,
        },
        decisionRule: "ALLOW iff availableUnits >= requestedUnits.",
        responseMarker: "EPOCH_DECISION",
      };
    }
    case "budget": {
      const observation = BudgetValueSchema.parse(resourceVersion.value);
      return {
        assignment: { ...assignmentBinding, role: "budget" },
        action: querySpec.actionProjection,
        observation: {
          receiptId: receipt.receiptId,
          nonce: receipt.nonce,
          remainingBudgetCents: observation.remainingBudgetCents,
          observedAtSeq: receipt.observedAtSeq,
        },
        decisionRule: "ALLOW iff remainingBudgetCents >= estimatedCostCents.",
        responseMarker: "EPOCH_DECISION",
      };
    }
    case "policy": {
      const observation = PolicyValueSchema.parse(resourceVersion.value);
      return {
        assignment: { ...assignmentBinding, role: "policy" },
        action: querySpec.actionProjection,
        observation: {
          receiptId: receipt.receiptId,
          nonce: receipt.nonce,
          permitted: observation.permitted,
          observedAtSeq: receipt.observedAtSeq,
        },
        decisionRule: "ALLOW iff permitted === true.",
        responseMarker: "EPOCH_DECISION",
      };
    }
  }
}

/**
 * Builds trusted bytes solely from persisted server records. Workspace content
 * is deliberately never an input to this pure reconstruction.
 */
export function buildCanonicalEvidencePack(
  input: EvidencePackBuildInput,
): BuiltCanonicalEvidencePack {
  const action = ActionIntentSchema.parse(input.action);
  const querySpec = RoleQuerySpecSchema.parse(input.querySpec);
  const assignment = RunAssignmentSchema.parse(input.assignment);
  const receipt = ObservationReceiptSchema.parse(input.receipt);
  const resourceVersion = parseVerifiedResourceVersion(input.resourceVersion);
  assertBindings(
    action,
    querySpec,
    assignment,
    receipt,
    resourceVersion,
    input.worldHeadSeq,
  );

  const payload = buildPayload(
    querySpec,
    assignment,
    receipt,
    resourceVersion,
  );
  const canonicalText = asCanonicalJson(payload);
  const canonicalBytes = Buffer.from(canonicalText, "utf8");
  return {
    payload,
    canonicalText,
    canonicalBytes,
    evidencePackHash: sha256Digest(canonicalBytes),
    evidencePackRelativePath: assignment.evidencePackRelativePath,
  };
}

/** Checks the stored expected hash during later authoritative reconstruction. */
export function assertEvidencePackHash(
  assignmentInput: RunAssignment,
  built: BuiltCanonicalEvidencePack,
): void {
  const assignment = RunAssignmentSchema.parse(assignmentInput);
  if (assignment.evidencePackHash !== built.evidencePackHash) {
    throw new Error("Stored Evidence Pack hash does not match reconstruction");
  }
}

export class EvidencePackWriter {
  constructor(private readonly workspace: EvidenceWorkspace) {}

  buildCanonicalPack(
    input: EvidencePackBuildInput,
  ): BuiltCanonicalEvidencePack {
    return buildCanonicalEvidencePack(input);
  }

  async writeCanonicalPack(
    input: EvidencePackBuildInput,
  ): Promise<WrittenCanonicalEvidencePack> {
    const built = this.buildCanonicalPack(input);
    const assignment = RunAssignmentSchema.parse(input.assignment);
    assertEvidencePackHash(assignment, built);
    const writtenRelativePath = await this.workspace.writeEvidencePackAtomic(
      assignment.agentId,
      assignment.sessionId,
      assignment.role,
      assignment.assignmentId,
      built.canonicalBytes,
    );
    if (writtenRelativePath !== built.evidencePackRelativePath) {
      throw new Error("Workspace wrote Evidence Pack to an unexpected path");
    }
    return { ...built, writtenRelativePath };
  }
}
