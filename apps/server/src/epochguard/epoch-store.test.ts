import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EpochStore } from "./epoch-store.js";
import {
  EpochDatabaseSchema,
  GOLDEN_ACTION_HASH,
  GOLDEN_ACTION_INPUT,
  ROLES,
  buildRoleQuerySpec,
  sha256Digest,
  type EpochDatabase,
} from "./types.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-29T12:00:00.000Z";
const startedAt = "2026-08-29T12:00:01.000Z";
const completedAt = "2026-08-29T12:00:02.000Z";
const digest = sha256Digest("epoch-store-test");

const emptyDatabase = (): EpochDatabase => ({
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

async function temporaryStore() {
  const root = await mkdtemp(path.join(tmpdir(), "epochguard-store-test-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, "data", "epochguard.json");
  return {
    root,
    filePath,
    store: new EpochStore(filePath),
  };
}

function populatedDatabase(): EpochDatabase {
  const sessionId = "session_store_restart";
  const action = {
    ...GOLDEN_ACTION_INPUT,
    actionId: "action_store_restart",
    sessionId,
    actionHash: GOLDEN_ACTION_HASH,
    idempotencyKey: `${sessionId}:${GOLDEN_ACTION_HASH}`,
  };
  const queries = ROLES.map((role) =>
    buildRoleQuerySpec(GOLDEN_ACTION_INPUT, role),
  );
  const decisionCertificateIds = ROLES.map(
    (role) => `decision_${role}_1`,
  ) as [string, string, string];
  const receiptIds = ROLES.map((role) => `receipt_${role}_1`) as [
    string,
    string,
    string,
  ];
  const sanitizedContent = "redacted output";

  return EpochDatabaseSchema.parse({
    schemaVersion: 1,
    snapshotRevision: 0,
    headSeq: 21,
    roleAgentRegistrations: ROLES.map((role) => ({
      role,
      agentId: `agent_${role}`,
      agentNameAtRegistration: `${role} agent`,
      roleProfileVersion: `${role}-v1`,
      agentsMdDigest: digest,
      registeredAt: timestamp,
    })),
    worldCommits: [
      {
        seq: 10,
        changes: ROLES.map((role) => ({
          resourceId: `resource_${role}`,
          previousVersionId: null,
          nextVersionId: `version_${role}_1`,
        })),
        reason: "Restart persistence fixture",
        createdAt: timestamp,
      },
    ],
    resourceVersions: ROLES.map((role) => ({
      id: `version_${role}_1`,
      resourceId: `resource_${role}`,
      sourceRevision: 10,
      value: { fixtureRole: role },
      valueHash: digest,
      validFromSeq: 10,
      validUntilSeq: null,
    })),
    roleQuerySpecs: queries,
    runAssignments: ROLES.map((role, index) => ({
      assignmentId: `assignment_${role}_1`,
      sessionId,
      actionHash: GOLDEN_ACTION_HASH,
      agentId: `agent_${role}`,
      agentNameAtAssignment: `${role} agent`,
      role,
      receiptId: receiptIds[index],
      queryHash: queries[index]?.queryHash,
      roleProfileVersion: `${role}-v1`,
      promptTemplateVersion: "epoch-prompt-v1",
      agentsMdDigest: digest,
      runtimeLabelAtDispatch: "ControlledRunner",
      evidencePackRelativePath:
        `.epochguard/sessions/${sessionId}/${role}/assignment_${role}_1.json`,
      evidencePackHash: digest,
      boundRunId: `run_${role}_1`,
      status: "CONSUMED",
      consumedByDecisionCertificateId: decisionCertificateIds[index],
      createdAt: timestamp,
      boundAt: timestamp,
      consumedAt: completedAt,
    })),
    receipts: ROLES.map((role, index) => ({
      schemaVersion: 1,
      receiptId: receiptIds[index],
      sessionId,
      actionHash: GOLDEN_ACTION_HASH,
      agentId: `agent_${role}`,
      runAssignmentId: `assignment_${role}_1`,
      role,
      source: role,
      entityKey: queries[index]?.entityKey,
      queryHash: queries[index]?.queryHash,
      sourceRevision: 10,
      valueHash: digest,
      observedAtSeq: 10,
      nonce: `${role}-${"n".repeat(40)}`,
      issuer: "epochguard",
      issuedAt: timestamp,
    })),
    sessions: [
      {
        sessionId,
        scenarioId: "normal-world-v1",
        action,
        actionHash: GOLDEN_ACTION_HASH,
        state: "COMMITTED",
        sessionRevision: 6,
        coordinationMode: "CONCURRENT",
        frozenAssignments: {
          inventoryAgentId: "agent_inventory",
          budgetAgentId: "agent_budget",
          policyAgentId: "agent_policy",
        },
        activeDecisionCertificateIds: {
          inventory: decisionCertificateIds[0],
          budget: decisionCertificateIds[1],
          policy: decisionCertificateIds[2],
        },
        activeAttemptIds: {
          inventory: null,
          budget: null,
          policy: null,
        },
        activeValidationId: "validation_valid_1",
        activeRefreshPlanId: null,
        activePermitId: "permit_1",
        stateUpdatedAt: completedAt,
        createdAt: timestamp,
      },
    ],
    attempts: ROLES.map((role) => ({
      attemptId: `attempt_${role}_1`,
      sessionId,
      actionHash: GOLDEN_ACTION_HASH,
      role,
      agentId: `agent_${role}`,
      assignmentId: `assignment_${role}_1`,
      runId: `run_${role}_1`,
      status: "ACCEPTED",
      runStartedAt: startedAt,
      runCompletedAt: completedAt,
      threadId: `thread_${role}_1`,
      usage: { inputTokens: 10, outputTokens: 5 },
      outputDigest: digest,
    })),
    decisions: ROLES.map((role, index) => ({
      certificateId: decisionCertificateIds[index],
      sessionId,
      actionHash: GOLDEN_ACTION_HASH,
      agentId: `agent_${role}`,
      runAssignmentId: `assignment_${role}_1`,
      runId: `run_${role}_1`,
      role,
      verdict: "ALLOW",
      receiptIds: [receiptIds[index]],
      decisionDigest: digest,
      status: "ACTIVE",
      supersededByCertificateId: null,
      constructedBy: "epochguard",
      createdAt: completedAt,
    })),
    validations: [
      {
        validationId: "validation_valid_1",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        baseSessionRevision: 5,
        decisionCertificateIds,
        dependencySetHash: digest,
        validatedHead: 10,
        outcome: "VALID_CURRENT_ALLOW",
        lowerBound: 10,
        upperBound: 11,
        jointValidityCertificateId: "jvc_1",
        noCutProofId: null,
        refreshPlanId: null,
        verificationLatencyMs: 1,
        createdAt: completedAt,
      },
      {
        validationId: "validation_no_cut_1",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        baseSessionRevision: 7,
        decisionCertificateIds,
        dependencySetHash: digest,
        validatedHead: 21,
        outcome: "NO_VALID_OBSERVED_WORLD_CUT",
        lowerBound: 21,
        upperBound: 20,
        jointValidityCertificateId: null,
        noCutProofId: "proof_1",
        refreshPlanId: "refresh_1",
        verificationLatencyMs: 2,
        createdAt: completedAt,
      },
    ],
    jointValidityCertificates: [
      {
        certificateId: "jvc_1",
        validationId: "validation_valid_1",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        dependencySetHash: digest,
        validatedAtHead: 10,
        selectedCutSeq: 10,
        currentHeadCovered: true,
        decisionCertificateIds,
        intervals: ROLES.map((role, index) => ({
          receiptId: receiptIds[index],
          source: role,
          sourceRevision: 10,
          from: 10,
          until: null,
        })),
        validatorVersion: "epochguard-jv-v1",
        createdAt: completedAt,
      },
    ],
    noCutProofs: [
      {
        proofId: "proof_1",
        validationId: "validation_no_cut_1",
        reason: "NO_VALID_OBSERVED_WORLD_CUT",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        dependencySetHash: digest,
        decisionCertificateIds,
        validatedAtHead: 21,
        lowerBound: 21,
        upperBound: 20,
        latestStartingReceiptId: receiptIds[2],
        earliestEndingReceiptId: receiptIds[1],
        conflictWitnessReceiptIds: [receiptIds[1], receiptIds[2]],
        refreshAgentIds: ["agent_budget"],
        createdAt: completedAt,
      },
    ],
    refreshPlans: [
      {
        refreshPlanId: "refresh_1",
        sessionId,
        baseSessionRevision: 7,
        validatedHead: 21,
        dependencySetHash: digest,
        activeDecisionCertificateIds: decisionCertificateIds,
        agentIds: ["agent_budget"],
        status: "AVAILABLE",
        claimedAttemptId: null,
      },
    ],
    permits: [
      {
        permitId: "permit_1",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        dependencySetHash: digest,
        jointValidityCertificateId: "jvc_1",
        validatedHead: 10,
        idempotencyKey: `${sessionId}:${GOLDEN_ACTION_HASH}`,
        status: "CONSUMED",
        issuedAt: completedAt,
        consumedAt: completedAt,
      },
    ],
    effects: [
      {
        effectId: "effect_1",
        type: "PUBLISH_CAMPAIGN",
        idempotencyKey: `${sessionId}:${GOLDEN_ACTION_HASH}`,
        permitId: "permit_1",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        dependencySetHash: digest,
        jointValidityCertificateId: "jvc_1",
        createdAt: completedAt,
      },
    ],
    diagnostics: [
      {
        diagnosticId: "diagnostic_1",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        sessionRevision: 7,
        fixtureRef: "fixture_store_restart",
        kind: "EXPECTED_BLOCK",
        stage: "VALIDATE",
        reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
        role: null,
        attemptId: null,
        assignmentId: null,
        runId: null,
        artifactRefs: [
          { kind: "VALIDATION", id: "validation_no_cut_1" },
          { kind: "PROOF", id: "proof_1" },
        ],
        causedByDiagnosticIds: [],
        expected: { effectCount: 0 },
        actual: { effectCount: 0 },
        rejectedOutputArtifactId: null,
        auditSeq: 1,
        recommendedAction: "REOBSERVE_INVALID",
      },
    ],
    rejectedOutputArtifacts: [
      {
        artifactId: "rejected_output_1",
        sessionId,
        attemptId: "attempt_budget_1",
        reason: "PARSE_REJECTED",
        originalDigest: digest,
        originalByteLength: sanitizedContent.length,
        sanitizedContent,
        sanitizedContentDigest: sha256Digest(sanitizedContent),
        truncated: false,
        redactionVersion: "epoch-redact-v1",
        createdAt: completedAt,
      },
    ],
    auditEvents: [
      {
        eventId: "event_1",
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        sessionRevision: 7,
        auditSeq: 1,
        type: "VALIDATION_COMPLETED",
        status: "BLOCKED",
        role: null,
        artifactRefs: [{ kind: "PROOF", id: "proof_1" }],
        createdAt: completedAt,
      },
    ],
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("EpochStore", () => {
  it("initializes the complete frozen database and returns isolated snapshots", async () => {
    const { filePath, store } = await temporaryStore();
    await store.initialize();

    expect(store.snapshot()).toEqual(emptyDatabase());
    expect(
      EpochDatabaseSchema.parse(JSON.parse(await readFile(filePath, "utf8"))),
    ).toEqual(emptyDatabase());

    const callerSnapshot = store.snapshot();
    callerSnapshot.headSeq = 99;
    callerSnapshot.auditEvents.push({
      eventId: "event_leaked",
      sessionId: "session_leaked",
      actionHash: GOLDEN_ACTION_HASH,
      sessionRevision: 1,
      auditSeq: 1,
      type: "MUST_NOT_LEAK",
      status: "MUST_NOT_LEAK",
      role: null,
      artifactRefs: [],
      createdAt: timestamp,
    });

    expect(store.snapshot()).toEqual(emptyDatabase());
  });

  it("serializes twenty concurrent mutations without losing updates", async () => {
    const { filePath, store } = await temporaryStore();
    await store.initialize();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.mutate((database) => {
          database.headSeq += 1;
          const sequence = database.headSeq;
          database.auditEvents.push({
            eventId: `event_concurrent_${sequence}`,
            sessionId: "session_concurrent",
            actionHash: GOLDEN_ACTION_HASH,
            sessionRevision: sequence,
            auditSeq: sequence,
            type: "CONCURRENT_MUTATION",
            status: "COMMITTED",
            role: null,
            artifactRefs: [],
            createdAt: timestamp,
          });
          return sequence;
        }),
      ),
    );

    expect(results).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    const snapshot = store.snapshot();
    expect(snapshot.snapshotRevision).toBe(20);
    expect(snapshot.headSeq).toBe(20);
    expect(snapshot.auditEvents.map((event) => event.auditSeq)).toEqual(results);

    const persisted = EpochDatabaseSchema.parse(
      JSON.parse(await readFile(filePath, "utf8")),
    );
    expect(persisted).toEqual(snapshot);
    await expect(access(`${filePath}.tmp`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not publish a failed write and keeps the writer queue recoverable", async () => {
    const { filePath, store } = await temporaryStore();
    await store.initialize();
    const dataDirectory = path.dirname(filePath);
    await rm(dataDirectory, { recursive: true, force: true });

    await expect(
      store.mutate((database) => {
        database.headSeq = 99;
        database.auditEvents.push({
          eventId: "event_failed_write",
          sessionId: "session_failure",
          actionHash: GOLDEN_ACTION_HASH,
          sessionRevision: 1,
          auditSeq: 1,
          type: "FAILED_WRITE",
          status: "MUST_NOT_PUBLISH",
          role: null,
          artifactRefs: [],
          createdAt: timestamp,
        });
      }),
    ).rejects.toThrow();

    expect(store.snapshot()).toEqual(emptyDatabase());

    await mkdir(dataDirectory, { recursive: true });
    await store.mutate((database) => {
      database.headSeq = 1;
      database.auditEvents.push({
        eventId: "event_recovered_write",
        sessionId: "session_failure",
        actionHash: GOLDEN_ACTION_HASH,
        sessionRevision: 1,
        auditSeq: 1,
        type: "RECOVERED_WRITE",
        status: "COMMITTED",
        role: null,
        artifactRefs: [],
        createdAt: timestamp,
      });
    });

    expect(store.snapshot()).toMatchObject({
      snapshotRevision: 1,
      headSeq: 1,
      auditEvents: [{ eventId: "event_recovered_write" }],
    });

    const restarted = new EpochStore(filePath);
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(store.snapshot());
  });

  it("restores every frozen collection and its stable IDs after restart", async () => {
    const { filePath, store } = await temporaryStore();
    await store.initialize();
    const fixture = populatedDatabase();

    await store.mutate((database) => {
      Object.assign(database, fixture);
    });
    const committed = store.snapshot();
    expect(committed.snapshotRevision).toBe(1);

    const restarted = new EpochStore(filePath);
    await restarted.initialize();
    const recovered = restarted.snapshot();
    expect(recovered).toEqual(committed);
    expect({
      roleAgentRegistrations: recovered.roleAgentRegistrations.map(
        (record) => `${record.role}:${record.agentId}`,
      ),
      worldCommits: recovered.worldCommits.map((record) => record.seq),
      resourceVersions: recovered.resourceVersions.map((record) => record.id),
      roleQuerySpecs: recovered.roleQuerySpecs.map((record) => record.queryHash),
      runAssignments: recovered.runAssignments.map(
        (record) => record.assignmentId,
      ),
      receipts: recovered.receipts.map((record) => record.receiptId),
      sessions: recovered.sessions.map((record) => record.sessionId),
      attempts: recovered.attempts.map((record) => record.attemptId),
      decisions: recovered.decisions.map((record) => record.certificateId),
      validations: recovered.validations.map((record) => record.validationId),
      jointValidityCertificates: recovered.jointValidityCertificates.map(
        (record) => record.certificateId,
      ),
      noCutProofs: recovered.noCutProofs.map((record) => record.proofId),
      refreshPlans: recovered.refreshPlans.map((record) => record.refreshPlanId),
      permits: recovered.permits.map((record) => record.permitId),
      effects: recovered.effects.map((record) => record.effectId),
      diagnostics: recovered.diagnostics.map((record) => record.diagnosticId),
      rejectedOutputArtifacts: recovered.rejectedOutputArtifacts.map(
        (record) => record.artifactId,
      ),
      auditEvents: recovered.auditEvents.map((record) => record.eventId),
    }).toEqual({
      roleAgentRegistrations: [
        "inventory:agent_inventory",
        "budget:agent_budget",
        "policy:agent_policy",
      ],
      worldCommits: [10],
      resourceVersions: [
        "version_inventory_1",
        "version_budget_1",
        "version_policy_1",
      ],
      roleQuerySpecs: fixture.roleQuerySpecs.map((record) => record.queryHash),
      runAssignments: [
        "assignment_inventory_1",
        "assignment_budget_1",
        "assignment_policy_1",
      ],
      receipts: [
        "receipt_inventory_1",
        "receipt_budget_1",
        "receipt_policy_1",
      ],
      sessions: ["session_store_restart"],
      attempts: [
        "attempt_inventory_1",
        "attempt_budget_1",
        "attempt_policy_1",
      ],
      decisions: [
        "decision_inventory_1",
        "decision_budget_1",
        "decision_policy_1",
      ],
      validations: ["validation_valid_1", "validation_no_cut_1"],
      jointValidityCertificates: ["jvc_1"],
      noCutProofs: ["proof_1"],
      refreshPlans: ["refresh_1"],
      permits: ["permit_1"],
      effects: ["effect_1"],
      diagnostics: ["diagnostic_1"],
      rejectedOutputArtifacts: ["rejected_output_1"],
      auditEvents: ["event_1"],
    });
  });

  it("fails closed on malformed, unsupported, missing, or extra persisted data", async () => {
    const { root } = await temporaryStore();
    const { auditEvents: _auditEvents, ...missingCollection } = emptyDatabase();
    const candidates = [
      { name: "malformed", content: "{not-json" },
      {
        name: "unsupported",
        content: JSON.stringify({ ...emptyDatabase(), schemaVersion: 2 }),
      },
      { name: "missing-collection", content: JSON.stringify(missingCollection) },
      {
        name: "extra-collection",
        content: JSON.stringify({
          ...emptyDatabase(),
          browserTrustedState: [],
        }),
      },
    ];

    for (const candidate of candidates) {
      const filePath = path.join(root, `${candidate.name}.json`);
      await writeFile(filePath, candidate.content, "utf8");
      const store = new EpochStore(filePath);

      await expect(store.initialize(), candidate.name).rejects.toThrow();
      expect(await readFile(filePath, "utf8"), candidate.name).toBe(
        candidate.content,
      );
      expect(store.snapshot(), candidate.name).toEqual(emptyDatabase());
    }
  });

  it("rejects an invalid mutation without publishing it and then recovers", async () => {
    const { store } = await temporaryStore();
    await store.initialize();

    await expect(
      store.mutate((database) => {
        (database as EpochDatabase & { untrusted: boolean }).untrusted = true;
      }),
    ).rejects.toThrow();
    expect(store.snapshot()).toEqual(emptyDatabase());

    await store.mutate((database) => {
      database.headSeq = 1;
    });
    expect(store.snapshot()).toMatchObject({
      snapshotRevision: 1,
      headSeq: 1,
    });
  });
});
