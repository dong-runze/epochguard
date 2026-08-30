import { describe, expect, it } from "vitest";
import {
  GOLDEN_ACTION_HASH,
  GOLDEN_ACTION_INPUT,
  EpochDatabaseSchema,
  buildRoleQuerySpec,
  canonicalJson,
  sha256Digest,
  type AgentDecisionEnvelope,
  type EpochDatabase,
} from "./types.js";
import {
  DecisionNormalizationError,
  EPOCH_DECISION_CLOSE_MARKER,
  EPOCH_DECISION_OPEN_MARKER,
  EPOCH_REDACTION_VERSION,
  MAX_DECISION_OUTPUT_BYTES,
  normalizeAndConsumeDecision,
  parseDecisionEnvelope,
  redactRejectedDecisionOutput,
} from "./decision-parser.js";

const NOW = "2026-08-29T12:00:00.000Z";
const COMPLETED = "2026-08-29T12:00:01.000Z";
const DIGEST = `sha256:${"1".repeat(64)}`;

function renderEnvelope(envelope: unknown): string {
  return `${EPOCH_DECISION_OPEN_MARKER}\n${JSON.stringify(envelope)}\n${EPOCH_DECISION_CLOSE_MARKER}`;
}

function makeFixture() {
  const role = "budget" as const;
  const sessionId = "session_decision_1";
  const assignmentId = "assignment_budget_1";
  const attemptId = "attempt_budget_1";
  const runId = "run_budget_1";
  const receiptId = "receipt_budget_1";
  const nonce = "n".repeat(32);
  const query = buildRoleQuerySpec(GOLDEN_ACTION_INPUT, role);
  const envelope: AgentDecisionEnvelope = {
    schemaVersion: 1,
    sessionId,
    actionHash: GOLDEN_ACTION_HASH,
    runAssignmentId: assignmentId,
    role,
    receiptId,
    nonce,
    verdict: "ALLOW",
    reason: "The authoritative budget covers the requested spend.",
  };
  const rawOutput = renderEnvelope(envelope);
  const database: EpochDatabase = {
    schemaVersion: 1,
    snapshotRevision: 0,
    headSeq: 19,
    roleAgentRegistrations: [
      {
        role,
        agentId: "agent_budget",
        agentNameAtRegistration: "Budget Agent",
        roleProfileVersion: "budget-v1",
        agentsMdDigest: DIGEST,
        registeredAt: NOW,
      },
    ],
    worldCommits: [],
    resourceVersions: [],
    roleQuerySpecs: [query],
    runAssignments: [
      {
        assignmentId,
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        agentId: "agent_budget",
        agentNameAtAssignment: "Budget Agent",
        role,
        receiptId,
        queryHash: query.queryHash,
        roleProfileVersion: "budget-v1",
        promptTemplateVersion: "epoch-prompt-v1",
        agentsMdDigest: DIGEST,
        runtimeLabelAtDispatch: "ControlledRunner",
        evidencePackRelativePath:
          ".epochguard/sessions/session_decision_1/budget/assignment_budget_1.json",
        evidencePackHash: DIGEST,
        boundRunId: runId,
        status: "BOUND",
        consumedByDecisionCertificateId: null,
        createdAt: NOW,
        boundAt: NOW,
        consumedAt: null,
      },
    ],
    receipts: [
      {
        schemaVersion: 1,
        receiptId,
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        agentId: "agent_budget",
        runAssignmentId: assignmentId,
        role,
        source: role,
        entityKey: GOLDEN_ACTION_INPUT.campaignId,
        queryHash: query.queryHash,
        sourceRevision: 19,
        valueHash: DIGEST,
        observedAtSeq: 19,
        nonce,
        issuer: "epochguard",
        issuedAt: NOW,
      },
    ],
    sessions: [
      {
        sessionId,
        scenarioId: "impossible-collage-v1",
        action: {
          ...GOLDEN_ACTION_INPUT,
          actionId: "action_decision_1",
          sessionId,
          actionHash: GOLDEN_ACTION_HASH,
          idempotencyKey: `${sessionId}:${GOLDEN_ACTION_HASH}`,
        },
        actionHash: GOLDEN_ACTION_HASH,
        state: "COLLECTING",
        sessionRevision: 3,
        coordinationMode: "CONCURRENT",
        frozenAssignments: {
          inventoryAgentId: "agent_inventory",
          budgetAgentId: "agent_budget",
          policyAgentId: "agent_policy",
        },
        activeDecisionCertificateIds: {
          inventory: null,
          budget: null,
          policy: null,
        },
        activeAttemptIds: {
          inventory: null,
          budget: attemptId,
          policy: null,
        },
        activeValidationId: null,
        activeRefreshPlanId: null,
        activePermitId: null,
        stateUpdatedAt: NOW,
        createdAt: NOW,
      },
    ],
    attempts: [
      {
        attemptId,
        sessionId,
        actionHash: GOLDEN_ACTION_HASH,
        role,
        agentId: "agent_budget",
        assignmentId,
        runId,
        status: "COMPLETED",
        runStartedAt: NOW,
        runCompletedAt: COMPLETED,
        threadId: "thread_budget_1",
        usage: null,
        outputDigest: sha256Digest(rawOutput),
      },
    ],
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
  return { database, envelope, rawOutput, attemptId };
}

function replaceEnvelope(
  fixture: ReturnType<typeof makeFixture>,
  mutate: (envelope: any) => void,
): void {
  const envelope = structuredClone(fixture.envelope) as any;
  mutate(envelope);
  fixture.rawOutput = renderEnvelope(envelope);
  fixture.database.attempts[0]!.outputDigest = sha256Digest(fixture.rawOutput);
}

function replaceRawOutput(
  fixture: ReturnType<typeof makeFixture>,
  rawOutput: string,
): void {
  fixture.rawOutput = rawOutput;
  fixture.database.attempts[0]!.outputDigest = sha256Digest(rawOutput);
}

function parserFailure(rawOutput: string): DecisionNormalizationError {
  let failure: unknown;
  try {
    parseDecisionEnvelope(rawOutput);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(DecisionNormalizationError);
  return failure as DecisionNormalizationError;
}

function commitMutation<T>(
  database: EpochDatabase,
  operation: (draft: EpochDatabase) => T,
): { database: EpochDatabase; result: T } {
  const draft = structuredClone(database);
  const result = operation(draft);
  return { database: draft, result };
}

function expectNormalizationFailure(
  fixture: ReturnType<typeof makeFixture>,
  reasonCode: string,
): void {
  const before = structuredClone(fixture.database);
  try {
    normalizeAndConsumeDecision(
      fixture.database,
      fixture.attemptId,
      fixture.rawOutput,
      { certificateId: "decision_rejected", createdAt: COMPLETED },
    );
    throw new Error("Expected normalization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionNormalizationError);
    expect((error as DecisionNormalizationError).reasonCode).toBe(reasonCode);
  }
  expect(fixture.database).toEqual(before);
}

describe("Decision parser and normalizer", () => {
  it("accepts exactly one strict marker envelope up to the 16 KiB byte boundary", () => {
    const fixture = makeFixture();
    expect(parseDecisionEnvelope(fixture.rawOutput)).toEqual(fixture.envelope);

    const padding = " ".repeat(
      MAX_DECISION_OUTPUT_BYTES - Buffer.byteLength(fixture.rawOutput, "utf8"),
    );
    const boundaryOutput = `${padding}${fixture.rawOutput}`;
    expect(Buffer.byteLength(boundaryOutput, "utf8")).toBe(
      MAX_DECISION_OUTPUT_BYTES,
    );
    expect(parseDecisionEnvelope(boundaryOutput)).toEqual(fixture.envelope);
  });

  it("rejects missing/duplicate markers, malformed JSON, extra fields, and free text", () => {
    const fixture = makeFixture();
    const withExtraField = renderEnvelope({
      ...fixture.envelope,
      runId: "untrusted_run",
    });
    const malformedJson = `${EPOCH_DECISION_OPEN_MARKER}{bad json${EPOCH_DECISION_CLOSE_MARKER}`;
    const candidates = [
      JSON.stringify(fixture.envelope),
      `${fixture.rawOutput}\n${fixture.rawOutput}`,
      malformedJson,
      withExtraField,
      `explanation\n${fixture.rawOutput}`,
      `${fixture.rawOutput}\nfinished`,
      "x".repeat(MAX_DECISION_OUTPUT_BYTES + 1),
    ];
    for (const candidate of candidates) {
      expect(() => parseDecisionEnvelope(candidate)).toThrowError(
        DecisionNormalizationError,
      );
      try {
        parseDecisionEnvelope(candidate);
      } catch (error) {
        expect((error as DecisionNormalizationError).reasonCode).toBe(
          "OUTPUT_MALFORMED",
        );
      }
    }
  });

  it("commits a deterministic redacted artifact for an authoritative parse rejection", () => {
    const fixture = makeFixture();
    const secrets = [
      "token-secret-0123456789",
      "password-secret-0123456789",
      `sk-proj-${"fake".repeat(6)}`,
      "bearer.secret.0123456789",
      "private-key-body-secret-0123456789",
      `AKIA${"1234567890ABCDEF"}`,
      "quoted-bearer-secret-0123456789",
    ];
    const malformed = [
      "model preface without the required Epoch marker",
      `token=${secrets[0]}`,
      `password: "${secrets[1]}"`,
      `OPENAI_API_KEY='${secrets[2]}'`,
      `Authorization: Bearer ${secrets[3]}`,
      `Authorization: Bearer "${secrets[6]}"`,
      secrets[5],
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      secrets[4],
      "-----END OPENSSH PRIVATE KEY-----",
      "tail remains visible",
    ].join("\n");
    const rawOutput = `${malformed}${" ".repeat(
      MAX_DECISION_OUTPUT_BYTES - Buffer.byteLength(malformed, "utf8"),
    )}`;
    expect(Buffer.byteLength(rawOutput, "utf8")).toBe(
      MAX_DECISION_OUTPUT_BYTES,
    );
    replaceRawOutput(fixture, rawOutput);
    const boundSnapshot = structuredClone(fixture.database);

    const committed = commitMutation(fixture.database, (draft) =>
      normalizeAndConsumeDecision(draft, fixture.attemptId, rawOutput, {
        certificateId: "decision_must_not_exist",
        rejectedOutputArtifactId: "artifact_parse_rejected_1",
        createdAt: COMPLETED,
      }),
    );

    expect(fixture.database).toEqual(boundSnapshot);
    expect(committed.result).toMatchObject({
      status: "OUTPUT_REJECTED",
      decision: null,
      reasonCode: "OUTPUT_MALFORMED",
    });
    if (committed.result.status !== "OUTPUT_REJECTED") {
      throw new Error("Expected rejected output");
    }
    const artifact = committed.result.rejectedOutputArtifact;
    expect(artifact).toMatchObject({
      artifactId: "artifact_parse_rejected_1",
      sessionId: "session_decision_1",
      attemptId: fixture.attemptId,
      reason: "PARSE_REJECTED",
      originalDigest: sha256Digest(rawOutput),
      originalByteLength: MAX_DECISION_OUTPUT_BYTES,
      truncated: false,
      redactionVersion: EPOCH_REDACTION_VERSION,
      createdAt: COMPLETED,
    });
    expect(artifact.sanitizedContent).not.toBeNull();
    const sanitizedContent = artifact.sanitizedContent!;
    expect(artifact.sanitizedContentDigest).toBe(
      sha256Digest(sanitizedContent),
    );
    expect(Buffer.byteLength(sanitizedContent, "utf8")).toBeLessThanOrEqual(
      MAX_DECISION_OUTPUT_BYTES,
    );
    expect(sanitizedContent).toContain("*".repeat(secrets[0].length));
    expect(sanitizedContent.split("\n")).toHaveLength(
      rawOutput.split("\n").length,
    );
    expect(sanitizedContent).toContain("tail remains visible");
    for (const secret of secrets) {
      expect(sanitizedContent).not.toContain(secret);
    }
    expect(redactRejectedDecisionOutput(rawOutput)).toBe(sanitizedContent);
    expect(redactRejectedDecisionOutput(sanitizedContent)).toBe(
      sanitizedContent,
    );

    const originalFailure = parserFailure(rawOutput);
    const replayFailure = parserFailure(sanitizedContent);
    expect({
      reasonCode: replayFailure.reasonCode,
      message: replayFailure.message,
    }).toEqual({
      reasonCode: originalFailure.reasonCode,
      message: originalFailure.message,
    });

    expect(committed.database.rejectedOutputArtifacts).toEqual([artifact]);
    expect(committed.database.runAssignments[0]).toMatchObject({
      status: "REJECTED",
      consumedByDecisionCertificateId: null,
      consumedAt: null,
    });
    expect(committed.database.attempts[0]!.status).toBe("OUTPUT_REJECTED");
    expect(committed.database.decisions).toEqual([]);
    expect(
      committed.database.sessions[0]!.activeDecisionCertificateIds,
    ).toEqual(boundSnapshot.sessions[0]!.activeDecisionCertificateIds);
    expect(committed.database.sessions[0]!.activeAttemptIds).toEqual(
      boundSnapshot.sessions[0]!.activeAttemptIds,
    );
    expect(EpochDatabaseSchema.safeParse(committed.database).success).toBe(
      true,
    );

    const afterRejection = structuredClone(committed.database);
    expect(() =>
      normalizeAndConsumeDecision(
        committed.database,
        fixture.attemptId,
        rawOutput,
        { rejectedOutputArtifactId: "artifact_parse_rejected_2" },
      ),
    ).toThrowError(DecisionNormalizationError);
    expect(committed.database).toEqual(afterRejection);
  });

  it("redacts fictional Basic, AWS, Ark, database, and one-line continuation credentials", () => {
    const fixture = makeFixture();
    const secrets = {
      basic: "RklDVElUSU9VUy1CQVNJQy0wMTIzNDU2Nzg5",
      aws: "fictitious-aws-secret-access-key-0123456789",
      arkCamel: "fictitious-ark-camel-key-0123456789",
      arkSnake: "fictitious-ark-snake-key-0123456789",
      arkEscaped: "fictitious-ark-escaped-key-0123456789",
      arkMultiEscaped: "fictitious-ark-multi-escaped-key-0123456789",
      databaseUser: "fictitious_db_user",
      databasePassword: "fictitious_db_password_0123456789",
      continuedBearer: "fictitious-cross-line-bearer-0123456789",
      continuedLabel: "fictitious-cross-line-label-0123456789",
    };
    const multiEscapeLayer = "\\".repeat(3);
    const rawOutput = [
      `Authorization: Basic ${secrets.basic}`,
      `AWS_SECRET_ACCESS_KEY=${secrets.aws}`,
      `arkApiKey: "${secrets.arkCamel}"`,
      `{"ARK_API_KEY":"${secrets.arkSnake}"}`,
      `payload={\\"arkApiKey\\":\\"${secrets.arkEscaped}\\"}`,
      `${multiEscapeLayer}"ARK_API_KEY${multiEscapeLayer}":${multiEscapeLayer}"${secrets.arkMultiEscaped}${multiEscapeLayer}"`,
      `connection=postgresql://${secrets.databaseUser}:${secrets.databasePassword}@db.invalid/epochguard`,
      "Authorization: Bearer",
      `  "${secrets.continuedBearer}"`,
      "ARK_API_KEY:",
      `  ${secrets.continuedLabel}`,
      "line after continued credentials remains intact",
    ].join("\n");
    replaceRawOutput(fixture, rawOutput);
    const originalFailure = parserFailure(rawOutput);

    const result = normalizeAndConsumeDecision(
      fixture.database,
      fixture.attemptId,
      rawOutput,
      {
        rejectedOutputArtifactId: "artifact_credential_matrix",
        createdAt: COMPLETED,
      },
    );
    expect(result.status).toBe("OUTPUT_REJECTED");
    if (result.status !== "OUTPUT_REJECTED") {
      throw new Error("Expected credential matrix rejection");
    }
    const sanitizedContent = result.rejectedOutputArtifact.sanitizedContent!;
    for (const secret of Object.values(secrets)) {
      expect(sanitizedContent).not.toContain(secret);
    }
    expect(sanitizedContent).toContain("db.invalid/epochguard");
    expect(sanitizedContent).toContain(
      "line after continued credentials remains intact",
    );
    expect(sanitizedContent.split("\n")).toHaveLength(
      rawOutput.split("\n").length,
    );
    expect(Buffer.byteLength(sanitizedContent, "utf8")).toBe(
      Buffer.byteLength(rawOutput, "utf8"),
    );
    expect(redactRejectedDecisionOutput(sanitizedContent)).toBe(
      sanitizedContent,
    );
    const replayFailure = parserFailure(sanitizedContent);
    expect({
      reasonCode: replayFailure.reasonCode,
      message: replayFailure.message,
    }).toEqual({
      reasonCode: originalFailure.reasonCode,
      message: originalFailure.message,
    });
    expect(fixture.database.decisions).toEqual([]);
  });

  it("does not consume an ordinary unindented line after an empty secret label", () => {
    const fixture = makeFixture();
    const rawOutput = "client-secret=\nvisible_line=must_stay";
    replaceRawOutput(fixture, rawOutput);

    const committed = commitMutation(fixture.database, (draft) =>
      normalizeAndConsumeDecision(draft, fixture.attemptId, rawOutput, {
        rejectedOutputArtifactId: "artifact_empty_label_boundary",
        createdAt: COMPLETED,
      }),
    );
    expect(committed.result.status).toBe("OUTPUT_REJECTED");
    if (committed.result.status !== "OUTPUT_REJECTED") {
      throw new Error("Expected empty-label rejection");
    }
    expect(
      committed.result.rejectedOutputArtifact.sanitizedContent,
    ).toBe(rawOutput);
    expect(committed.database.rejectedOutputArtifacts).toEqual([
      committed.result.rejectedOutputArtifact,
    ]);
    expect(committed.database.runAssignments[0]).toMatchObject({
      status: "REJECTED",
      consumedByDecisionCertificateId: null,
      consumedAt: null,
    });
    expect(committed.database.attempts[0]!.status).toBe("OUTPUT_REJECTED");
    expect(committed.database.decisions).toEqual([]);
  });

  it("preserves schema and JSON parser failures while masking necessary length and newlines", () => {
    const source = makeFixture();
    const schemaSecret = "fictitious-schema-ark-key-0123456789";
    const privateSecret = "fictitious-private-key-line-0123456789";
    const jsonSecret = "fictitious-malformed-json-key-0123456789";
    const overlongReason = `ARK_API_KEY=${schemaSecret}${"x".repeat(1_001)}`;
    const privateKeyJson = JSON.stringify({
      ...source.envelope,
      reason: "private-key-placeholder",
    }).replace(
      '"reason":"private-key-placeholder"',
      `"reason":"-----BEGIN PRIVATE KEY-----\n${privateSecret}\n-----END PRIVATE KEY-----"`,
    );
    const cases = [
      {
        name: "schema length",
        rawOutput: renderEnvelope({
          ...source.envelope,
          reason: overlongReason,
        }),
        secret: schemaSecret,
        expectedMessage: "Decision envelope failed the strict contract schema",
      },
      {
        name: "unescaped private-key newlines",
        rawOutput:
          `${EPOCH_DECISION_OPEN_MARKER}\n${privateKeyJson}\n` +
          EPOCH_DECISION_CLOSE_MARKER,
        secret: privateSecret,
        expectedMessage: "Decision envelope contains invalid JSON",
      },
      {
        name: "malformed JSON",
        rawOutput:
          `${EPOCH_DECISION_OPEN_MARKER}\n` +
          `{"ARK_API_KEY":"${jsonSecret}",}\n` +
          EPOCH_DECISION_CLOSE_MARKER,
        secret: jsonSecret,
        expectedMessage: "Decision envelope contains invalid JSON",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const fixture = makeFixture();
      expect(Buffer.byteLength(testCase.rawOutput, "utf8")).toBeLessThanOrEqual(
        MAX_DECISION_OUTPUT_BYTES,
      );
      replaceRawOutput(fixture, testCase.rawOutput);
      const originalFailure = parserFailure(testCase.rawOutput);
      expect(originalFailure.message, testCase.name).toBe(
        testCase.expectedMessage,
      );

      const result = normalizeAndConsumeDecision(
        fixture.database,
        fixture.attemptId,
        testCase.rawOutput,
        {
          rejectedOutputArtifactId: `artifact_structure_${index}`,
          createdAt: COMPLETED,
        },
      );
      expect(result.status, testCase.name).toBe("OUTPUT_REJECTED");
      if (result.status !== "OUTPUT_REJECTED") {
        throw new Error(`Expected ${testCase.name} rejection`);
      }
      const sanitizedContent = result.rejectedOutputArtifact.sanitizedContent!;
      expect(sanitizedContent, testCase.name).not.toContain(testCase.secret);
      expect(Buffer.byteLength(sanitizedContent, "utf8"), testCase.name).toBe(
        Buffer.byteLength(testCase.rawOutput, "utf8"),
      );
      expect(sanitizedContent.split("\n").length, testCase.name).toBe(
        testCase.rawOutput.split("\n").length,
      );
      expect(redactRejectedDecisionOutput(sanitizedContent), testCase.name).toBe(
        sanitizedContent,
      );
      const replayFailure = parserFailure(sanitizedContent);
      expect(
        {
          reasonCode: replayFailure.reasonCode,
          message: replayFailure.message,
        },
        testCase.name,
      ).toEqual({
        reasonCode: originalFailure.reasonCode,
        message: originalFailure.message,
      });
      expect(fixture.database.runAssignments[0]).toMatchObject({
        status: "REJECTED",
        consumedByDecisionCertificateId: null,
        consumedAt: null,
      });
      expect(fixture.database.attempts[0]!.status).toBe("OUTPUT_REJECTED");
      expect(fixture.database.decisions).toEqual([]);
    }
  });

  it("persists PARSE_REJECTED for marker, JSON, and strict-schema failures", () => {
    const source = makeFixture();
    const cases = [
      {
        name: "marker",
        rawOutput: JSON.stringify(source.envelope),
      },
      {
        name: "JSON",
        rawOutput:
          `${EPOCH_DECISION_OPEN_MARKER}{bad json` +
          EPOCH_DECISION_CLOSE_MARKER,
      },
      {
        name: "strict schema",
        rawOutput: renderEnvelope({
          ...source.envelope,
          unexpectedToolArgument: "publish-now",
        }),
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const fixture = makeFixture();
      replaceRawOutput(fixture, testCase.rawOutput);
      const originalFailure = parserFailure(testCase.rawOutput);
      const result = normalizeAndConsumeDecision(
        fixture.database,
        fixture.attemptId,
        testCase.rawOutput,
        {
          rejectedOutputArtifactId: `artifact_parse_kind_${index}`,
          createdAt: COMPLETED,
        },
      );
      expect(result.status, testCase.name).toBe("OUTPUT_REJECTED");
      if (result.status !== "OUTPUT_REJECTED") {
        throw new Error(`Expected ${testCase.name} rejection`);
      }
      expect(result.rejectedOutputArtifact).toMatchObject({
        reason: "PARSE_REJECTED",
        originalDigest: sha256Digest(testCase.rawOutput),
        originalByteLength: Buffer.byteLength(testCase.rawOutput, "utf8"),
        sanitizedContent: testCase.rawOutput,
        sanitizedContentDigest: sha256Digest(testCase.rawOutput),
        truncated: false,
      });
      const replayFailure = parserFailure(
        result.rejectedOutputArtifact.sanitizedContent!,
      );
      expect({
        reasonCode: replayFailure.reasonCode,
        message: replayFailure.message,
      }).toEqual({
        reasonCode: originalFailure.reasonCode,
        message: originalFailure.message,
      });
      expect(fixture.database.runAssignments[0]!.status).toBe("REJECTED");
      expect(fixture.database.attempts[0]!.status).toBe("OUTPUT_REJECTED");
      expect(fixture.database.decisions).toEqual([]);
    }
  });

  it("preserves the parser failure when a private-key block contains Epoch markers", () => {
    const fixture = makeFixture();
    const privateSecret = "marker-private-key-secret-0123456789";
    const rawOutput = [
      "-----BEGIN PRIVATE KEY-----",
      renderEnvelope(fixture.envelope),
      privateSecret,
      "-----END PRIVATE KEY-----",
    ].join("\n");
    replaceRawOutput(fixture, rawOutput);
    const originalFailure = parserFailure(rawOutput);
    expect(originalFailure.message).toContain("leading or trailing free text");
    const decisionPointersBefore = structuredClone(
      fixture.database.sessions[0]!.activeDecisionCertificateIds,
    );
    const attemptPointersBefore = structuredClone(
      fixture.database.sessions[0]!.activeAttemptIds,
    );

    const result = normalizeAndConsumeDecision(
      fixture.database,
      fixture.attemptId,
      rawOutput,
      {
        rejectedOutputArtifactId: "artifact_private_key_markers",
        createdAt: COMPLETED,
      },
    );
    expect(result.status).toBe("OUTPUT_REJECTED");
    if (result.status !== "OUTPUT_REJECTED") {
      throw new Error("Expected private-key marker rejection");
    }
    const sanitizedContent = result.rejectedOutputArtifact.sanitizedContent!;
    expect(sanitizedContent).not.toContain(privateSecret);
    expect(
      sanitizedContent.split(EPOCH_DECISION_OPEN_MARKER).length - 1,
    ).toBe(1);
    expect(
      sanitizedContent.split(EPOCH_DECISION_CLOSE_MARKER).length - 1,
    ).toBe(1);
    expect(Buffer.byteLength(sanitizedContent, "utf8")).toBe(
      Buffer.byteLength(rawOutput, "utf8"),
    );
    expect(sanitizedContent.split("\n")).toHaveLength(
      rawOutput.split("\n").length,
    );
    expect(redactRejectedDecisionOutput(sanitizedContent)).toBe(
      sanitizedContent,
    );
    const replayFailure = parserFailure(sanitizedContent);
    expect({
      reasonCode: replayFailure.reasonCode,
      message: replayFailure.message,
    }).toEqual({
      reasonCode: originalFailure.reasonCode,
      message: originalFailure.message,
    });
    expect(fixture.database.runAssignments[0]).toMatchObject({
      status: "REJECTED",
      consumedByDecisionCertificateId: null,
      consumedAt: null,
    });
    expect(fixture.database.attempts[0]!.status).toBe("OUTPUT_REJECTED");
    expect(fixture.database.decisions).toEqual([]);
    expect(
      fixture.database.sessions[0]!.activeDecisionCertificateIds,
    ).toEqual(decisionPointersBefore);
    expect(fixture.database.sessions[0]!.activeAttemptIds).toEqual(
      attemptPointersBefore,
    );
  });

  it("commits a replay-equivalent artifact for private-key text with an unescaped quote", () => {
    const fixture = makeFixture();
    const privateSecret = "fictitious-unescaped-private-secret-0123456789";
    const malformedJson = JSON.stringify({
      ...fixture.envelope,
      reason: "private-key-placeholder",
    }).replace(
      '"reason":"private-key-placeholder"',
      `"reason":"-----BEGIN PRIVATE KEY-----${privateSecret}\\\\segment"unescaped"-----END PRIVATE KEY-----"`,
    );
    const rawOutput =
      `${EPOCH_DECISION_OPEN_MARKER}\n${malformedJson}\n` +
      EPOCH_DECISION_CLOSE_MARKER;
    replaceRawOutput(fixture, rawOutput);
    const originalFailure = parserFailure(rawOutput);
    expect(originalFailure.message).toBe(
      "Decision envelope contains invalid JSON",
    );
    const databaseBefore = structuredClone(fixture.database);

    const committed = commitMutation(fixture.database, (draft) =>
      normalizeAndConsumeDecision(draft, fixture.attemptId, rawOutput, {
        rejectedOutputArtifactId: "artifact_private_key_quote",
        createdAt: COMPLETED,
      }),
    );
    expect(committed.result.status).toBe("OUTPUT_REJECTED");
    if (committed.result.status !== "OUTPUT_REJECTED") {
      throw new Error("Expected private-key quote rejection");
    }
    const artifact = committed.result.rejectedOutputArtifact;
    const sanitizedContent = artifact.sanitizedContent!;
    expect(sanitizedContent).not.toContain(privateSecret);
    expect(sanitizedContent).toContain("\\\\");
    expect(Buffer.byteLength(sanitizedContent, "utf8")).toBe(
      Buffer.byteLength(rawOutput, "utf8"),
    );
    expect(redactRejectedDecisionOutput(sanitizedContent)).toBe(
      sanitizedContent,
    );
    const replayFailure = parserFailure(sanitizedContent);
    expect({
      reasonCode: replayFailure.reasonCode,
      message: replayFailure.message,
    }).toEqual({
      reasonCode: originalFailure.reasonCode,
      message: originalFailure.message,
    });
    expect(committed.database.rejectedOutputArtifacts).toEqual([artifact]);
    expect(committed.database.runAssignments[0]).toMatchObject({
      status: "REJECTED",
      consumedByDecisionCertificateId: null,
      consumedAt: null,
    });
    expect(committed.database.attempts[0]!.status).toBe("OUTPUT_REJECTED");
    expect(committed.database.decisions).toEqual([]);
    expect(
      committed.database.sessions[0]!.activeDecisionCertificateIds,
    ).toEqual(databaseBefore.sessions[0]!.activeDecisionCertificateIds);
    expect(committed.database.sessions[0]!.activeAttemptIds).toEqual(
      databaseBefore.sessions[0]!.activeAttemptIds,
    );
  });

  it("commits redacted artifacts for complete and unterminated PGP private-key blocks", () => {
    const cases = [
      {
        name: "complete",
        secret: "fictitious-pgp-complete-payload-0123456789",
        render: (envelope: string, secret: string) =>
          [
            "-----BEGIN PGP PRIVATE KEY BLOCK-----",
            secret,
            "-----END PGP PRIVATE KEY BLOCK-----",
            envelope,
          ].join("\n"),
      },
      {
        name: "unterminated",
        secret: "fictitious-pgp-unterminated-payload-0123456789",
        render: (envelope: string, secret: string) =>
          [
            envelope,
            "-----BEGIN PGP PRIVATE KEY BLOCK-----",
            secret,
          ].join("\n"),
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const fixture = makeFixture();
      const rawOutput = testCase.render(fixture.rawOutput, testCase.secret);
      replaceRawOutput(fixture, rawOutput);
      const originalFailure = parserFailure(rawOutput);
      expect(originalFailure.message, testCase.name).toBe(
        "Decision envelope cannot have leading or trailing free text",
      );

      const committed = commitMutation(fixture.database, (draft) =>
        normalizeAndConsumeDecision(draft, fixture.attemptId, rawOutput, {
          rejectedOutputArtifactId: `artifact_pgp_${index}`,
          createdAt: COMPLETED,
        }),
      );
      expect(committed.result.status, testCase.name).toBe("OUTPUT_REJECTED");
      if (committed.result.status !== "OUTPUT_REJECTED") {
        throw new Error(`Expected ${testCase.name} PGP rejection`);
      }
      const artifact = committed.result.rejectedOutputArtifact;
      const sanitizedContent = artifact.sanitizedContent!;
      expect(sanitizedContent, testCase.name).not.toContain(testCase.secret);
      expect(Buffer.byteLength(sanitizedContent, "utf8"), testCase.name).toBe(
        Buffer.byteLength(rawOutput, "utf8"),
      );
      expect(sanitizedContent.split("\n").length, testCase.name).toBe(
        rawOutput.split("\n").length,
      );
      expect(
        sanitizedContent.split(EPOCH_DECISION_OPEN_MARKER).length - 1,
        testCase.name,
      ).toBe(1);
      expect(
        sanitizedContent.split(EPOCH_DECISION_CLOSE_MARKER).length - 1,
        testCase.name,
      ).toBe(1);
      expect(redactRejectedDecisionOutput(sanitizedContent), testCase.name).toBe(
        sanitizedContent,
      );
      const replayFailure = parserFailure(sanitizedContent);
      expect(
        {
          reasonCode: replayFailure.reasonCode,
          message: replayFailure.message,
        },
        testCase.name,
      ).toEqual({
        reasonCode: originalFailure.reasonCode,
        message: originalFailure.message,
      });
      expect(committed.database.rejectedOutputArtifacts).toEqual([artifact]);
      expect(committed.database.runAssignments[0]).toMatchObject({
        status: "REJECTED",
        consumedByDecisionCertificateId: null,
        consumedAt: null,
      });
      expect(committed.database.attempts[0]!.status).toBe("OUTPUT_REJECTED");
      expect(committed.database.decisions).toEqual([]);
    }
  });

  it("stores no rejected content or fragment when authoritative output exceeds 16 KiB", () => {
    const fixture = makeFixture();
    const secret = "oversized-token-secret-0123456789";
    const rawOutput = `token=${secret}\n${"x".repeat(
      MAX_DECISION_OUTPUT_BYTES + 1,
    )}`;
    replaceRawOutput(fixture, rawOutput);
    const pointersBefore = structuredClone(
      fixture.database.sessions[0]!.activeDecisionCertificateIds,
    );
    const attemptsBefore = structuredClone(
      fixture.database.sessions[0]!.activeAttemptIds,
    );

    const result = normalizeAndConsumeDecision(
      fixture.database,
      fixture.attemptId,
      rawOutput,
      {
        rejectedOutputArtifactId: "artifact_too_large_1",
        createdAt: COMPLETED,
      },
    );

    expect(result).toMatchObject({
      status: "OUTPUT_REJECTED",
      decision: null,
      reasonCode: "OUTPUT_MALFORMED",
    });
    if (result.status !== "OUTPUT_REJECTED") {
      throw new Error("Expected rejected output");
    }
    expect(result.rejectedOutputArtifact).toEqual({
      artifactId: "artifact_too_large_1",
      sessionId: "session_decision_1",
      attemptId: fixture.attemptId,
      reason: "OUTPUT_TOO_LARGE",
      originalDigest: sha256Digest(rawOutput),
      originalByteLength: Buffer.byteLength(rawOutput, "utf8"),
      sanitizedContent: null,
      sanitizedContentDigest: null,
      truncated: true,
      redactionVersion: EPOCH_REDACTION_VERSION,
      createdAt: COMPLETED,
    });
    expect(JSON.stringify(result.rejectedOutputArtifact)).not.toContain(secret);
    expect(JSON.stringify(fixture.database)).not.toContain(secret);
    expect(fixture.database.runAssignments[0]).toMatchObject({
      status: "REJECTED",
      consumedByDecisionCertificateId: null,
      consumedAt: null,
    });
    expect(fixture.database.attempts[0]!.status).toBe("OUTPUT_REJECTED");
    expect(fixture.database.decisions).toEqual([]);
    expect(
      fixture.database.sessions[0]!.activeDecisionCertificateIds,
    ).toEqual(pointersBefore);
    expect(fixture.database.sessions[0]!.activeAttemptIds).toEqual(
      attemptsBefore,
    );
    expect(EpochDatabaseSchema.safeParse(fixture.database).success).toBe(true);
  });

  it("does not audit forged, digest-mismatched, or non-terminal output", () => {
    const malformed = "token=not-authoritative-secret-0123456789";

    const forgedAttempt = makeFixture();
    const forgedBefore = structuredClone(forgedAttempt.database);
    expect(() =>
      normalizeAndConsumeDecision(
        forgedAttempt.database,
        "attempt_forged",
        malformed,
        { rejectedOutputArtifactId: "artifact_forged" },
      ),
    ).toThrowError(DecisionNormalizationError);
    expect(forgedAttempt.database).toEqual(forgedBefore);

    const digestMismatch = makeFixture();
    digestMismatch.rawOutput = malformed;
    expectNormalizationFailure(digestMismatch, "BINDING_MISMATCH");
    expect(digestMismatch.database.rejectedOutputArtifacts).toEqual([]);

    const nonTerminal = makeFixture();
    replaceRawOutput(nonTerminal, malformed);
    nonTerminal.database.attempts[0]!.status = "RUNNING";
    expectNormalizationFailure(nonTerminal, "DECISION_INVALID");
    expect(nonTerminal.database.rejectedOutputArtifacts).toEqual([]);

    const crossSession = makeFixture();
    replaceRawOutput(crossSession, malformed);
    crossSession.database.attempts[0]!.sessionId = "session_other";
    expectNormalizationFailure(crossSession, "BINDING_MISMATCH");
    expect(crossSession.database.rejectedOutputArtifacts).toEqual([]);
  });

  it("fails closed on a duplicate rejected-output artifact ID without mutation", () => {
    const fixture = makeFixture();
    fixture.database.rejectedOutputArtifacts.push({
      artifactId: "artifact_duplicate",
      sessionId: "session_existing",
      attemptId: "attempt_existing",
      reason: "PARSE_REJECTED",
      originalDigest: sha256Digest("existing raw output"),
      originalByteLength: 19,
      sanitizedContent: "existing sanitized output",
      sanitizedContentDigest: sha256Digest("existing sanitized output"),
      truncated: false,
      redactionVersion: EPOCH_REDACTION_VERSION,
      createdAt: NOW,
    });
    const malformed = "password=duplicate-artifact-secret-0123456789";
    replaceRawOutput(fixture, malformed);
    const before = structuredClone(fixture.database);

    try {
      normalizeAndConsumeDecision(
        fixture.database,
        fixture.attemptId,
        malformed,
        {
          rejectedOutputArtifactId: "artifact_duplicate",
          createdAt: COMPLETED,
        },
      );
      throw new Error("Expected duplicate artifact ID to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionNormalizationError);
      expect((error as DecisionNormalizationError).reasonCode).toBe(
        "DECISION_INVALID",
      );
    }
    expect(fixture.database).toEqual(before);
  });

  it("constructs a server Decision and consumes its Assignment exactly once", () => {
    const fixture = makeFixture();
    const result = normalizeAndConsumeDecision(
      fixture.database,
      fixture.attemptId,
      fixture.rawOutput,
      { certificateId: "decision_budget_1", createdAt: COMPLETED },
    );

    expect(result).toMatchObject({
      status: "ACCEPTED",
      rejectedOutputArtifact: null,
      reasonCode: null,
    });
    if (result.status !== "ACCEPTED") {
      throw new Error("Expected an accepted Decision");
    }
    const decision = result.decision;

    expect(decision).toMatchObject({
      certificateId: "decision_budget_1",
      agentId: "agent_budget",
      runId: "run_budget_1",
      role: "budget",
      receiptIds: ["receipt_budget_1"],
      verdict: "ALLOW",
      status: "ACTIVE",
      decisionDigest: sha256Digest(canonicalJson(fixture.envelope)),
    });
    expect(fixture.database.runAssignments[0]).toMatchObject({
      status: "CONSUMED",
      consumedByDecisionCertificateId: "decision_budget_1",
      consumedAt: COMPLETED,
    });
    expect(fixture.database.attempts[0]!.status).toBe("ACCEPTED");
    expect(
      fixture.database.sessions[0]!.activeDecisionCertificateIds.budget,
    ).toBe("decision_budget_1");
    expect(fixture.database.sessions[0]!.activeAttemptIds.budget).toBeNull();

    const afterFirstConsumption = structuredClone(fixture.database);
    expect(() =>
      normalizeAndConsumeDecision(
        fixture.database,
        fixture.attemptId,
        fixture.rawOutput,
        { certificateId: "decision_budget_2", createdAt: COMPLETED },
      ),
    ).toThrowError(DecisionNormalizationError);
    expect(fixture.database).toEqual(afterFirstConsumption);
    expect(fixture.database.decisions).toHaveLength(1);
  });

  it("fails closed for every Session/Action/Role/Run/Agent/Receipt/nonce replay", () => {
    const cases: Array<{
      name: string;
      reasonCode: string;
      mutate: (fixture: ReturnType<typeof makeFixture>) => void;
    }> = [
      {
        name: "cross-session envelope",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.sessionId = "session_other";
          }),
      },
      {
        name: "cross-action envelope",
        reasonCode: "ACTION_HASH_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.actionHash = `sha256:${"f".repeat(64)}`;
          }),
      },
      {
        name: "cross-role envelope",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.role = "policy";
          }),
      },
      {
        name: "cross-assignment envelope",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.runAssignmentId = "assignment_other";
          }),
      },
      {
        name: "cross-receipt envelope",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.receiptId = "receipt_other";
          }),
      },
      {
        name: "old nonce",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) =>
          replaceEnvelope(fixture, (envelope) => {
            envelope.nonce = "o".repeat(32);
          }),
      },
      {
        name: "cross-run Attempt",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) => {
          fixture.database.attempts[0]!.runId = "run_other";
        },
      },
      {
        name: "cross-agent Attempt",
        reasonCode: "BINDING_MISMATCH",
        mutate: (fixture) => {
          fixture.database.attempts[0]!.agentId = "agent_other";
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = makeFixture();
      testCase.mutate(fixture);
      expectNormalizationFailure(fixture, testCase.reasonCode);
    }
  });

  it("rejects canonical query, profile, output-digest, and active-Attempt drift", () => {
    const queryDrift = makeFixture();
    queryDrift.database.runAssignments[0]!.queryHash =
      `sha256:${"f".repeat(64)}`;
    expectNormalizationFailure(queryDrift, "QUERY_HASH_MISMATCH");

    const profileDrift = makeFixture();
    profileDrift.database.roleAgentRegistrations[0]!.agentsMdDigest =
      `sha256:${"a".repeat(64)}`;
    expectNormalizationFailure(profileDrift, "ROLE_PROFILE_MISMATCH");

    const outputDrift = makeFixture();
    outputDrift.database.attempts[0]!.outputDigest = `sha256:${"b".repeat(64)}`;
    expectNormalizationFailure(outputDrift, "BINDING_MISMATCH");

    const inactiveAttempt = makeFixture();
    inactiveAttempt.database.sessions[0]!.activeAttemptIds.budget =
      "attempt_other";
    expectNormalizationFailure(inactiveAttempt, "BINDING_MISMATCH");
  });

  it("supersedes only the prior active Decision when a refreshed Decision is accepted", () => {
    const fixture = makeFixture();
    fixture.database.decisions.push({
      certificateId: "decision_budget_old",
      sessionId: "session_decision_1",
      actionHash: GOLDEN_ACTION_HASH,
      agentId: "agent_budget",
      runAssignmentId: "assignment_budget_old",
      runId: "run_budget_old",
      role: "budget",
      verdict: "ALLOW",
      receiptIds: ["receipt_budget_old"],
      decisionDigest: DIGEST,
      status: "ACTIVE",
      supersededByCertificateId: null,
      constructedBy: "epochguard",
      createdAt: NOW,
    });
    fixture.database.sessions[0]!.activeDecisionCertificateIds.budget =
      "decision_budget_old";

    normalizeAndConsumeDecision(
      fixture.database,
      fixture.attemptId,
      fixture.rawOutput,
      { certificateId: "decision_budget_new", createdAt: COMPLETED },
    );
    expect(fixture.database.decisions[0]).toMatchObject({
      status: "SUPERSEDED",
      supersededByCertificateId: "decision_budget_new",
    });
    expect(
      fixture.database.sessions[0]!.activeDecisionCertificateIds.budget,
    ).toBe("decision_budget_new");
  });
});
