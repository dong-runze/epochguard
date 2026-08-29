import {
  CONTRACT_DIGEST,
  CONTRACT_VERSION,
  SessionDashboardSnapshotSchema,
  type Role,
  type SessionDashboardSnapshot,
} from "../contracts";

export const MOCK_PREVIEW_NOTICE =
  "MOCK DATA PREVIEW — NOT A REAL AGENT RUN" as const;

export const MOCK_SCENARIO_KEYS = [
  "collecting",
  "normal-ready",
  "normal-released",
  "impossible-blocked",
  "refreshing-budget",
  "recovered-deny",
  "run-failed",
  "unsupported",
  "stale",
] as const;

export type MockScenarioKey = (typeof MOCK_SCENARIO_KEYS)[number];

const ACTION = {
  type: "PUBLISH_CAMPAIGN" as const,
  campaignId: "campaign_42",
  requestedUnits: 1,
  estimatedCostCents: 500_000,
  market: "SG" as const,
};

// Frozen outputs of the authoritative v6 canonicalization. Preview code never
// derives or uses these values as a safety decision.
const ACTION_HASH =
  "sha256:bd99e824e58087f03cd1018fe7457865a596ae74ffbb5a707b1d2c3b6da5c202";
const NO_CUT_DEPENDENCY_SET_HASH =
  "sha256:aa533795f68bda5370637d67adbb89fe6608bbb71357d367d6fe0ac67ad64cfe";

const ROLE_META = {
  inventory: {
    agentId: "agent_inventory",
    name: "Inventory Sentinel",
    digestCharacter: "a",
  },
  budget: {
    agentId: "agent_budget",
    name: "Budget Auditor",
    digestCharacter: "b",
  },
  policy: {
    agentId: "agent_policy",
    name: "Policy Verifier",
    digestCharacter: "c",
  },
} as const;

const ROLE_FACTS = {
  inventory: "1 launch slot is available for campaign_42.",
  budget: "SGD 8,000 remains before the competing campaign settles.",
  policy: "The SG campaign policy currently permits publication.",
} as const;

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function runtimeProof(
  sessionId: string,
  role: Role,
  runNumber: number,
  startedAt: string,
  completedAt: string,
) {
  const suffix = `${role}_${runNumber}`;
  return {
    assignmentId: `assignment_${suffix}`,
    threadId: `thread_${role}`,
    runtimeLabel: "Codex CLI · Ark · isolated workspace",
    roleProfileVersion: `${role}-v1`,
    promptTemplateVersion: "epoch-prompt-v1",
    agentsMdDigest: digest(ROLE_META[role].digestCharacter),
    evidencePackRelativePath: `.epochguard/sessions/${sessionId}/${role}/assignment_${suffix}.json`,
    evidencePackHash: digest(runNumber === 1 ? "d" : "e"),
    runStartedAt: startedAt,
    runCompletedAt: completedAt,
    outputDigest: digest(runNumber === 1 ? "f" : "9"),
    usage: {
      inputTokens: 612 + runNumber * 11,
      cachedInputTokens: 128,
      outputTokens: 94 + runNumber * 7,
    },
  };
}

function decision(
  sessionId: string,
  role: Role,
  options: {
    runNumber: number;
    verdict: "ALLOW" | "DENY";
    factSummary: string;
    evidenceState: "CURRENT" | "RETAINED" | "INVALID_AT_HEAD";
    receiptId: string;
    sourceRevision: number;
    observedAtSeq: number;
    validFromSeq: number;
    validUntilSeq: number | null;
    startedAt: string;
    completedAt: string;
  },
) {
  return {
    certificateId: `certificate_${role}_${options.runNumber}`,
    runId: `run_${role}_${options.runNumber}`,
    verdict: options.verdict,
    factSummary: options.factSummary,
    evidenceState: options.evidenceState,
    receipt: {
      receiptId: options.receiptId,
      sourceRevision: options.sourceRevision,
      observedAtSeq: options.observedAtSeq,
      validFromSeq: options.validFromSeq,
      validUntilSeq: options.validUntilSeq,
    },
    runtimeProof: runtimeProof(
      sessionId,
      role,
      options.runNumber,
      options.startedAt,
      options.completedAt,
    ),
  };
}

function pendingAgent(
  sessionId: string,
  role: Role,
  startedAt: string,
) {
  return {
    role,
    agentId: ROLE_META[role].agentId,
    agentNameAtAssignment: ROLE_META[role].name,
    runCount: 1,
    activeDecision: null,
    inFlightAttempt: {
      attemptId: `attempt_${role}_1`,
      assignmentId: `assignment_${role}_1`,
      runId: `run_${role}_1`,
      status: "RUNNING" as const,
      runStartedAt: startedAt,
      runCompletedAt: null,
    },
  };
}

function baseSnapshot(options: {
  snapshotRevision: number;
  sessionRevision: number;
  stateUpdatedAt: string;
  generatedAt: string;
  sessionId: string;
  scenarioId: "normal-world-v1" | "impossible-collage-v1";
  worldHead: number;
}) {
  return {
    schemaVersion: 1 as const,
    contractVersion: CONTRACT_VERSION,
    contractDigest: CONTRACT_DIGEST,
    snapshotRevision: options.snapshotRevision,
    sessionRevision: options.sessionRevision,
    stateUpdatedAt: options.stateUpdatedAt,
    generatedAt: options.generatedAt,
    sessionId: options.sessionId,
    scenarioId: options.scenarioId,
    coordinationMode: "CONCURRENT" as const,
    action: ACTION,
    actionHash: ACTION_HASH,
    worldHead: options.worldHead,
  };
}

function parseSnapshot(input: unknown): SessionDashboardSnapshot {
  return SessionDashboardSnapshotSchema.parse(input);
}

const collectingSessionId = "session_collecting";
const collecting = parseSnapshot({
  ...baseSnapshot({
    snapshotRevision: 11,
    sessionRevision: 2,
    stateUpdatedAt: "2026-08-29T16:00:02.000Z",
    generatedAt: "2026-08-29T16:00:02.120Z",
    sessionId: collectingSessionId,
    scenarioId: "normal-world-v1",
    worldHead: 10,
  }),
  sessionState: "COLLECTING",
  gate: {
    state: "WAITING",
    reasonCode: null,
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  },
  metrics: {
    activeDecisions: 0,
    requiredDecisions: 3,
    allowDecisions: 0,
    denyDecisions: 0,
    reobservedAgents: 0,
    totalAgents: 3,
    rerunsAvoided: 0,
    verificationLatencyMs: null,
  },
  agents: [
    pendingAgent(collectingSessionId, "inventory", "2026-08-29T16:00:00.100Z"),
    pendingAgent(collectingSessionId, "budget", "2026-08-29T16:00:00.260Z"),
    pendingAgent(collectingSessionId, "policy", "2026-08-29T16:00:00.410Z"),
  ],
  jointValidity: {
    state: "PENDING",
    lowerBound: null,
    upperBound: null,
    currentHeadCovered: null,
    noCutProof: null,
  },
  refreshPlan: null,
  availableActions: [],
  latestDiagnostics: [],
  events: [
    {
      eventId: "event_dispatch_started",
      sequence: 1,
      type: "SESSION_DISPATCHED",
      status: "RUNNING",
      role: null,
      summary: "Three isolated Role Agent Runs were dispatched.",
      createdAt: "2026-08-29T16:00:00.000Z",
    },
  ],
});

const normalSessionId = "session_normal";
const normalDecisions = (["inventory", "budget", "policy"] as const).map(
  (role, index) => ({
    role,
    agentId: ROLE_META[role].agentId,
    agentNameAtAssignment: ROLE_META[role].name,
    runCount: 1,
    activeDecision: decision(normalSessionId, role, {
      runNumber: 1,
      verdict: "ALLOW",
      factSummary: ROLE_FACTS[role],
      evidenceState: "CURRENT",
      receiptId: `receipt_${role}_v10`,
      sourceRevision: 10,
      observedAtSeq: 10,
      validFromSeq: 10,
      validUntilSeq: null,
      startedAt: `2026-08-29T16:01:0${index}.000Z`,
      completedAt: `2026-08-29T16:01:1${index}.000Z`,
    }),
    inFlightAttempt: null,
  }),
);

const normalReady = parseSnapshot({
  ...baseSnapshot({
    snapshotRevision: 21,
    sessionRevision: 5,
    stateUpdatedAt: "2026-08-29T16:01:20.000Z",
    generatedAt: "2026-08-29T16:01:20.080Z",
    sessionId: normalSessionId,
    scenarioId: "normal-world-v1",
    worldHead: 10,
  }),
  sessionState: "READY_AT_CURRENT_HEAD",
  gate: {
    state: "READY",
    reasonCode: null,
    effectsInSession: 0,
    permitId: "permit_normal",
    effectId: null,
  },
  metrics: {
    activeDecisions: 3,
    requiredDecisions: 3,
    allowDecisions: 3,
    denyDecisions: 0,
    reobservedAgents: 0,
    totalAgents: 3,
    rerunsAvoided: 0,
    verificationLatencyMs: 8.4,
  },
  agents: normalDecisions,
  jointValidity: {
    state: "VALID_CURRENT",
    lowerBound: 10,
    upperBound: 11,
    currentHeadCovered: true,
    noCutProof: null,
  },
  refreshPlan: null,
  availableActions: ["COMMIT"],
  latestDiagnostics: [],
  events: [
    {
      eventId: "event_normal_ready",
      sequence: 4,
      type: "VALIDATION_COMPLETED",
      status: "READY_AT_CURRENT_HEAD",
      role: null,
      summary: "All three active Decisions cover current world head v10.",
      createdAt: "2026-08-29T16:01:20.000Z",
    },
  ],
});

const normalReleased = parseSnapshot({
  ...normalReady,
  snapshotRevision: 22,
  sessionRevision: 6,
  stateUpdatedAt: "2026-08-29T16:01:23.000Z",
  generatedAt: "2026-08-29T16:01:23.070Z",
  sessionState: "COMMITTED",
  gate: {
    state: "RELEASED",
    reasonCode: null,
    effectsInSession: 1,
    permitId: "permit_normal",
    effectId: "effect_normal",
  },
  availableActions: [],
  events: [
    ...normalReady.events,
    {
      eventId: "event_normal_released",
      sequence: 5,
      type: "EFFECT_COMMITTED",
      status: "RELEASED",
      role: null,
      summary: "The protected Mock Publish Effect was released exactly once.",
      createdAt: "2026-08-29T16:01:23.000Z",
    },
  ],
});

const impossibleSessionId = "session_impossible";
const impossibleDecisions = [
  {
    role: "inventory" as const,
    agentId: ROLE_META.inventory.agentId,
    agentNameAtAssignment: ROLE_META.inventory.name,
    runCount: 1,
    activeDecision: decision(impossibleSessionId, "inventory", {
      runNumber: 1,
      verdict: "ALLOW",
      factSummary: ROLE_FACTS.inventory,
      evidenceState: "CURRENT",
      receiptId: "receipt_inventory_v18",
      sourceRevision: 18,
      observedAtSeq: 18,
      validFromSeq: 18,
      validUntilSeq: null,
      startedAt: "2026-08-29T16:03:00.000Z",
      completedAt: "2026-08-29T16:03:10.000Z",
    }),
    inFlightAttempt: null,
  },
  {
    role: "budget" as const,
    agentId: ROLE_META.budget.agentId,
    agentNameAtAssignment: ROLE_META.budget.name,
    runCount: 1,
    activeDecision: decision(impossibleSessionId, "budget", {
      runNumber: 1,
      verdict: "ALLOW",
      factSummary: ROLE_FACTS.budget,
      evidenceState: "INVALID_AT_HEAD",
      receiptId: "receipt_budget_v19",
      sourceRevision: 19,
      observedAtSeq: 19,
      validFromSeq: 19,
      validUntilSeq: 20,
      startedAt: "2026-08-29T16:03:00.200Z",
      completedAt: "2026-08-29T16:03:11.000Z",
    }),
    inFlightAttempt: null,
  },
  {
    role: "policy" as const,
    agentId: ROLE_META.policy.agentId,
    agentNameAtAssignment: ROLE_META.policy.name,
    runCount: 1,
    activeDecision: decision(impossibleSessionId, "policy", {
      runNumber: 1,
      verdict: "ALLOW",
      factSummary: ROLE_FACTS.policy,
      evidenceState: "CURRENT",
      receiptId: "receipt_policy_v21",
      sourceRevision: 21,
      observedAtSeq: 21,
      validFromSeq: 21,
      validUntilSeq: null,
      startedAt: "2026-08-29T16:03:00.400Z",
      completedAt: "2026-08-29T16:03:09.000Z",
    }),
    inFlightAttempt: null,
  },
];

const noCutProof = {
  proofId: "proof_impossible",
  dependencySetHash: NO_CUT_DEPENDENCY_SET_HASH,
  lowerBound: 21,
  upperBound: 20,
  witness: [
    {
      role: "budget" as const,
      receiptId: "receipt_budget_v19",
      from: 19,
      until: 20,
    },
    {
      role: "policy" as const,
      receiptId: "receipt_policy_v21",
      from: 21,
      until: null,
    },
  ],
};

const impossibleBlocked = parseSnapshot({
  ...baseSnapshot({
    snapshotRevision: 70,
    sessionRevision: 7,
    stateUpdatedAt: "2026-08-29T16:03:14.000Z",
    generatedAt: "2026-08-29T16:03:14.090Z",
    sessionId: impossibleSessionId,
    scenarioId: "impossible-collage-v1",
    worldHead: 21,
  }),
  sessionState: "BLOCKED_NO_CUT",
  gate: {
    state: "LOCKED",
    reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  },
  metrics: {
    activeDecisions: 3,
    requiredDecisions: 3,
    allowDecisions: 3,
    denyDecisions: 0,
    reobservedAgents: 0,
    totalAgents: 3,
    rerunsAvoided: 2,
    verificationLatencyMs: 6.8,
  },
  agents: impossibleDecisions,
  jointValidity: {
    state: "NO_CUT",
    lowerBound: 21,
    upperBound: 20,
    currentHeadCovered: false,
    noCutProof,
  },
  refreshPlan: {
    refreshPlanId: "refresh_budget",
    status: "AVAILABLE",
    agentIds: [ROLE_META.budget.agentId],
    reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
  },
  availableActions: ["REOBSERVE_INVALID"],
  latestDiagnostics: [
    {
      diagnosticId: "diagnostic_no_cut",
      kind: "EXPECTED_BLOCK",
      stage: "VALIDATE",
      reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
      role: null,
      relevantIds: [
        { kind: "PROOF", id: "proof_impossible" },
        { kind: "RECEIPT", id: "receipt_budget_v19" },
        { kind: "RECEIPT", id: "receipt_policy_v21" },
      ],
      auditSeq: 7,
      recommendedAction: "REOBSERVE_INVALID",
    },
  ],
  events: [
    {
      eventId: "event_all_allow",
      sequence: 6,
      type: "DECISIONS_COMPOSED",
      status: "THREE_ALLOW",
      role: null,
      summary: "All three locally valid Role Decisions returned ALLOW.",
      createdAt: "2026-08-29T16:03:13.000Z",
    },
    {
      eventId: "event_no_cut",
      sequence: 7,
      type: "VALIDATION_COMPLETED",
      status: "BLOCKED_NO_CUT",
      role: null,
      summary: "No shared observed-world revision exists; the Effect Gate stayed locked.",
      createdAt: "2026-08-29T16:03:14.000Z",
    },
  ],
});

const refreshingBudget = parseSnapshot({
  ...impossibleBlocked,
  snapshotRevision: 71,
  sessionRevision: 8,
  stateUpdatedAt: "2026-08-29T16:03:18.000Z",
  generatedAt: "2026-08-29T16:03:18.070Z",
  sessionState: "REOBSERVING",
  metrics: {
    ...impossibleBlocked.metrics,
    reobservedAgents: 1,
  },
  agents: impossibleBlocked.agents.map((agent) =>
    agent.role !== "budget"
      ? agent
      : {
          ...agent,
          runCount: 2,
          inFlightAttempt: {
            attemptId: "attempt_budget_2",
            assignmentId: "assignment_budget_2",
            runId: "run_budget_2",
            status: "RUNNING" as const,
            runStartedAt: "2026-08-29T16:03:18.000Z",
            runCompletedAt: null,
          },
        },
  ),
  refreshPlan: {
    ...impossibleBlocked.refreshPlan!,
    status: "CLAIMED",
  },
  availableActions: [],
  events: [
    ...impossibleBlocked.events,
    {
      eventId: "event_budget_refresh",
      sequence: 8,
      type: "REOBSERVATION_STARTED",
      status: "RUNNING",
      role: "budget",
      summary: "Only the invalid Budget evidence owner is running again.",
      createdAt: "2026-08-29T16:03:18.000Z",
    },
  ],
});

const recoveredDecisions = impossibleBlocked.agents.map((agent) => {
  if (agent.role === "budget") {
    return {
      ...agent,
      runCount: 2,
      activeDecision: decision(impossibleSessionId, "budget", {
        runNumber: 2,
        verdict: "DENY",
        factSummary: "SGD 0 remains after the competing campaign settles.",
        evidenceState: "CURRENT",
        receiptId: "receipt_budget_v20",
        sourceRevision: 20,
        observedAtSeq: 21,
        validFromSeq: 20,
        validUntilSeq: null,
        startedAt: "2026-08-29T16:03:18.000Z",
        completedAt: "2026-08-29T16:03:27.000Z",
      }),
      inFlightAttempt: null,
    };
  }
  return {
    ...agent,
    activeDecision:
      agent.activeDecision === null
        ? null
        : { ...agent.activeDecision, evidenceState: "RETAINED" as const },
  };
});

const recoveredDeny = parseSnapshot({
  ...baseSnapshot({
    snapshotRevision: 72,
    sessionRevision: 10,
    stateUpdatedAt: "2026-08-29T16:03:28.000Z",
    generatedAt: "2026-08-29T16:03:28.080Z",
    sessionId: impossibleSessionId,
    scenarioId: "impossible-collage-v1",
    worldHead: 21,
  }),
  sessionState: "CONSISTENT_DENY",
  gate: {
    state: "LOCKED",
    reasonCode: "CONSISTENT_DENY",
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  },
  metrics: {
    activeDecisions: 3,
    requiredDecisions: 3,
    allowDecisions: 2,
    denyDecisions: 1,
    reobservedAgents: 1,
    totalAgents: 3,
    rerunsAvoided: 2,
    verificationLatencyMs: 5.9,
  },
  agents: recoveredDecisions,
  jointValidity: {
    state: "VALID_CURRENT",
    lowerBound: 21,
    upperBound: 22,
    currentHeadCovered: true,
    noCutProof: null,
  },
  refreshPlan: {
    refreshPlanId: "refresh_budget",
    status: "COMPLETED",
    agentIds: [ROLE_META.budget.agentId],
    reasonCode: "NO_VALID_OBSERVED_WORLD_CUT",
  },
  availableActions: [],
  latestDiagnostics: impossibleBlocked.latestDiagnostics,
  events: [
    ...impossibleBlocked.events,
    {
      eventId: "event_recovered_deny",
      sequence: 10,
      type: "VALIDATION_COMPLETED",
      status: "CONSISTENT_DENY",
      role: "budget",
      summary: "Current evidence is jointly valid and Budget safely returned DENY.",
      createdAt: "2026-08-29T16:03:28.000Z",
    },
  ],
});

const failedSessionId = "session_failed";
const failedAgents = normalDecisions.map((agent) => {
  if (agent.role !== "policy") {
    return {
      ...agent,
      activeDecision:
        agent.activeDecision === null
          ? null
          : {
              ...agent.activeDecision,
              certificateId: `failed_${agent.activeDecision.certificateId}`,
              runId: `failed_${agent.activeDecision.runId}`,
              receipt: {
                ...agent.activeDecision.receipt,
                receiptId: `failed_${agent.activeDecision.receipt.receiptId}`,
              },
              runtimeProof: {
                ...runtimeProof(
                  failedSessionId,
                  agent.role,
                  1,
                  "2026-08-29T16:05:00.000Z",
                  "2026-08-29T16:05:08.000Z",
                ),
              },
            },
    };
  }
  return {
    role: "policy" as const,
    agentId: ROLE_META.policy.agentId,
    agentNameAtAssignment: ROLE_META.policy.name,
    runCount: 1,
    activeDecision: null,
    inFlightAttempt: {
      attemptId: "attempt_policy_failed",
      assignmentId: "assignment_policy_failed",
      runId: "run_policy_failed",
      status: "FAILED" as const,
      runStartedAt: "2026-08-29T16:05:00.300Z",
      runCompletedAt: "2026-08-29T16:05:06.000Z",
    },
  };
});

const runFailed = parseSnapshot({
  ...baseSnapshot({
    snapshotRevision: 91,
    sessionRevision: 4,
    stateUpdatedAt: "2026-08-29T16:05:06.000Z",
    generatedAt: "2026-08-29T16:05:06.060Z",
    sessionId: failedSessionId,
    scenarioId: "normal-world-v1",
    worldHead: 10,
  }),
  sessionState: "FAILED",
  gate: {
    state: "FAILED",
    reasonCode: "RUN_FAILED",
    effectsInSession: 0,
    permitId: null,
    effectId: null,
  },
  metrics: {
    activeDecisions: 2,
    requiredDecisions: 3,
    allowDecisions: 2,
    denyDecisions: 0,
    reobservedAgents: 0,
    totalAgents: 3,
    rerunsAvoided: 0,
    verificationLatencyMs: null,
  },
  agents: failedAgents,
  jointValidity: {
    state: "PENDING",
    lowerBound: null,
    upperBound: null,
    currentHeadCovered: null,
    noCutProof: null,
  },
  refreshPlan: null,
  availableActions: [],
  latestDiagnostics: [
    {
      diagnosticId: "diagnostic_policy_run_failed",
      kind: "SYSTEM_FAILURE",
      stage: "RUN",
      reasonCode: "RUN_FAILED",
      role: "policy",
      relevantIds: [
        { kind: "ATTEMPT", id: "attempt_policy_failed" },
        { kind: "RUN", id: "run_policy_failed" },
      ],
      auditSeq: 4,
      recommendedAction: "NEW_SESSION",
    },
  ],
  events: [
    {
      eventId: "event_policy_failed",
      sequence: 4,
      type: "RUN_TERMINATED",
      status: "FAILED",
      role: "policy",
      summary: "The Policy Run failed; join and Effect release both failed closed.",
      createdAt: "2026-08-29T16:05:06.000Z",
    },
  ],
});

const unsupported = {
  ...normalReady,
  contractVersion: "epochguard-contract-v999",
};

export interface MockScenarioDefinition {
  key: MockScenarioKey;
  label: string;
  description: string;
  sessionId: string;
  payload: unknown;
}

export const MOCK_SCENARIOS: Readonly<Record<MockScenarioKey, MockScenarioDefinition>> = {
  collecting: {
    key: "collecting",
    label: "Collecting",
    description: "Three isolated Runs are still in flight.",
    sessionId: collecting.sessionId,
    payload: collecting,
  },
  "normal-ready": {
    key: "normal-ready",
    label: "Normal · Ready",
    description: "Three current ALLOW Decisions; Commit is available.",
    sessionId: normalReady.sessionId,
    payload: normalReady,
  },
  "normal-released": {
    key: "normal-released",
    label: "Normal · Released 1",
    description: "The protected Effect was released exactly once.",
    sessionId: normalReleased.sessionId,
    payload: normalReleased,
  },
  "impossible-blocked": {
    key: "impossible-blocked",
    label: "Impossible · Blocked 0",
    description: "Three ALLOW Decisions have no shared observed-world cut.",
    sessionId: impossibleBlocked.sessionId,
    payload: impossibleBlocked,
  },
  "refreshing-budget": {
    key: "refreshing-budget",
    label: "Refreshing Budget",
    description: "The old Budget Decision remains visible beside its new Attempt.",
    sessionId: refreshingBudget.sessionId,
    payload: refreshingBudget,
  },
  "recovered-deny": {
    key: "recovered-deny",
    label: "Recovered · Deny 0",
    description: "Current evidence is valid; Budget safely denies publication.",
    sessionId: recoveredDeny.sessionId,
    payload: recoveredDeny,
  },
  "run-failed": {
    key: "run-failed",
    label: "Run Failed",
    description: "One Role Run fails and the Effect Gate closes.",
    sessionId: runFailed.sessionId,
    payload: runFailed,
  },
  unsupported: {
    key: "unsupported",
    label: "Unsupported Schema",
    description: "A foreign contract version disables every action.",
    sessionId: normalReady.sessionId,
    payload: unsupported,
  },
  stale: {
    key: "stale",
    label: "Stale Connection",
    description: "The last confirmed Snapshot remains visible while actions close.",
    sessionId: normalReady.sessionId,
    payload: normalReady,
  },
};

export function mockScenario(key: MockScenarioKey): MockScenarioDefinition {
  return MOCK_SCENARIOS[key];
}
