import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildCreateSessionRequest,
  decodeStoredSessionId,
  getRuntimeDisplayLabel,
  getRuntimeReadiness,
  inspectionFocusForSessionAcquisition,
  requestEpochGuardSession,
  SavedEpochGuardChat,
  SafetyRolePicker,
  SessionSafetyWorkspace,
} from "./App";
import {
  AgentCard,
  AgentDecisionFlow,
  FinalProtectedOutput,
} from "./epochguard/EpochGuardDashboard";
import {
  CONTRACT_DIGEST,
  CONTRACT_VERSION,
  SessionDashboardSnapshotSchema,
  type CreateSessionRequest,
  type Role,
} from "./epochguard/contracts";
import { mockScenario } from "./epochguard/preview/mock-snapshots";
import type { Agent, SystemInfo } from "./types";

const agents: Agent[] = [
  "Inventory",
  "Budget",
  "Policy",
].map((role, index) => ({
  id: `agent_${index}`,
  name: `EpochGuard ${role} Agent`,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: `/workspace/${role.toLowerCase()}`,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
}));

const readySystem: SystemInfo = {
  arkConfigured: true,
  arkBaseUrl: "https://ark.example.invalid/api/v3",
  arkModel: "ep-test",
  codexAvailable: true,
  codexSandboxMode: "read-only",
  runtimeProvider: "local-process",
  containerEngine: null,
  runtime: "Codex CLI in local process",
};

describe("Session Safety stored Session contract", () => {
  const currentEntry = {
    storageVersion: 1,
    contractVersion: CONTRACT_VERSION,
    contractDigest: CONTRACT_DIGEST,
    scenarioId: "normal-world-v1",
    sessionId: "session_stored",
  };

  it("restores only a Session stored under the current v8 contract", () => {
    expect(
      decodeStoredSessionId(
        JSON.stringify(currentEntry),
        "normal-world-v1",
      ),
    ).toBe("session_stored");
    expect(
      decodeStoredSessionId(
        JSON.stringify({
          ...currentEntry,
          contractVersion: "epochguard-contract-v7",
        }),
        "normal-world-v1",
      ),
    ).toBeNull();
    expect(
      decodeStoredSessionId(
        JSON.stringify({
          ...currentEntry,
          contractDigest:
            "sha256:4dfbeb9e55de7ca17a19f5fb8f99494b17e441af0f877767027284d3ae646361",
        }),
        "normal-world-v1",
      ),
    ).toBeNull();
  });
});

describe("Session Safety runtime readiness", () => {
  const unavailableCases: Array<{
    system: SystemInfo | null;
    reason: string;
  }> = [
    {
      system: null,
      reason: "Checking the current server runtime configuration.",
    },
    {
      system: { ...readySystem, arkConfigured: false },
      reason:
        "Configure ARK_API_KEY and ARK_MODEL in the current server environment, then restart the server.",
    },
    {
      system: { ...readySystem, codexAvailable: false },
      reason:
        "Codex CLI is unavailable in the local server process. Install @openai/codex, then restart the server.",
    },
  ];

  it.each(unavailableCases)(
    "fails closed when the runtime is unavailable",
    ({ system, reason }) => {
      expect(getRuntimeReadiness(system)).toEqual({ ready: false, reason });
    },
  );

  it("reports a fully configured runtime as ready", () => {
    expect(getRuntimeReadiness(readySystem)).toEqual({ ready: true, reason: null });
  });

  it("distinguishes the local process from an actual container", () => {
    expect(getRuntimeDisplayLabel(readySystem)).toBe("Local process · Codex CLI");
    expect(
      getRuntimeDisplayLabel({
        ...readySystem,
        runtimeProvider: "container",
        containerEngine: "docker",
        runtime: "Codex CLI in docker Runtime",
      }),
    ).toBe("Local container · Codex CLI");
  });

  it("renders the Session create control disabled with the readiness reason", () => {
    const reason = getRuntimeReadiness({
      ...readySystem,
      arkConfigured: false,
    }).reason;
    const markup = renderToStaticMarkup(
      <SessionSafetyWorkspace
        agents={agents}
        runtimeReady={false}
        runtimeReadinessReason={reason}
        scenarioId="normal-world-v1"
        onScenarioIdChange={vi.fn()}
        sessionIds={{
          "normal-world-v1": null,
          "impossible-collage-v1": null,
        }}
        setSessionIds={vi.fn()}
        pendingOperation={null}
        beginOperation={vi.fn(() => 1)}
        finishOperation={vi.fn()}
      />,
    );

    expect(markup).toContain("Runtime is not ready");
    expect(markup).toContain("current server environment");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Run Normal World<\/button>/);
  });
});

describe("Session Safety protected Role inspection", () => {
  const baseWorkspaceProps = {
    agents,
    runtimeReady: true,
    runtimeReadinessReason: null,
    scenarioId: "normal-world-v1" as const,
    onScenarioIdChange: vi.fn(),
    sessionIds: {
      "normal-world-v1": null,
      "impossible-collage-v1": null,
    },
    setSessionIds: vi.fn(),
    pendingOperation: null,
    beginOperation: vi.fn(() => 1),
    finishOperation: vi.fn(),
  };

  it("defaults to an accessible, read-only Inventory inspection", () => {
    const markup = renderToStaticMarkup(
      <SessionSafetyWorkspace {...baseWorkspaceProps} />,
    );

    expect(markup).toContain(
      'class="safety-role-summary" role="group" aria-label="Protected Role Agents"',
    );
    expect(markup).toMatch(
      /<button[^>]*class="safety-role-card"[^>]*aria-pressed="true"[^>]*>[\s\S]*?Inventory Role/,
    );
    expect(
      markup.match(/class="safety-role-card"[^>]*aria-pressed="false"/g),
    ).toHaveLength(2);
    expect(markup).toContain('aria-controls="safety-role-inspection"');
    expect(markup).toContain('aria-label="Inventory Role Agent inspection"');
    expect(markup).toContain("Lifecycle: ready");
    expect(markup).toContain('<dd title="agent_0">agent_0</dd>');
    expect(markup).toContain("epochguard-inventory-v1");
    expect(markup).toContain("Expected profile");
    expect(markup).toContain(
      "Dedicated inventory evidence owner for EpochGuard demo sessions.",
    );
    expect(markup).toContain(
      "Role focus changes this read-only inspection only.",
    );
    expect(markup).toContain(
      "authoritative frozen profile appears in Run-bound evidence.",
    );
  });

  it("shows the description returned by the real Agent API", () => {
    const apiDescription = "Inventory profile loaded from the Agent record.";
    const markup = renderToStaticMarkup(
      <SessionSafetyWorkspace
        {...baseWorkspaceProps}
        agents={agents.map((agent) =>
          agent.id === "agent_0"
            ? { ...agent, description: apiDescription }
            : agent,
        )}
      />,
    );

    expect(markup).toContain(apiDescription);
    expect(markup).not.toContain(
      "Dedicated inventory evidence owner for EpochGuard demo sessions.",
    );
  });

  it("continues the selected Agent ID into highlighted, open run-bound evidence", () => {
    const snapshot = SessionDashboardSnapshotSchema.parse(
      mockScenario("normal-ready").payload,
    );
    const budgetAgent = snapshot.agents.find(
      (agent) => agent.role === "budget",
    )!;
    const markup = renderToStaticMarkup(
      <AgentCard
        agent={budgetAgent}
        witnessReceiptIds={new Set()}
        isInspectionFocus
      />,
    );

    expect(markup).toContain("eg-agent-card-focus");
    expect(markup).toContain(
      'aria-label="Budget Agent evidence selected before Run"',
    );
    expect(markup).toContain("Selected before Run");
    expect(markup).toContain(`<code>${budgetAgent.agentId}</code>`);
    expect(markup).toMatch(/<details[^>]*open=""[^>]*>/);
    expect(markup).toContain("Run-bound evidence");
    expect(markup).toContain(budgetAgent.activeDecision!.runId);
    expect(markup).toContain(
      budgetAgent.activeDecision!.runtimeProof.assignmentId,
    );
    expect(markup).toContain(
      budgetAgent.activeDecision!.runtimeProof.roleProfileVersion,
    );
    expect(markup).toContain(
      budgetAgent.activeDecision!.runtimeProof.promptTemplateVersion,
    );

    const nonFocusedMarkup = renderToStaticMarkup(
      <AgentCard
        agent={budgetAgent}
        witnessReceiptIds={new Set()}
      />,
    );
    expect(nonFocusedMarkup).not.toContain("eg-agent-card-focus");
    expect(nonFocusedMarkup).not.toContain("Selected before Run");
    expect(nonFocusedMarkup).not.toMatch(/<details[^>]*open(?:="")?[^>]*>/);
    expect(nonFocusedMarkup).toContain("Run-bound evidence");
  });

  it("does not claim before-Run provenance for an existing recovered Session", () => {
    const snapshot = SessionDashboardSnapshotSchema.parse(
      mockScenario("normal-ready").payload,
    );
    const recoveredAgent = snapshot.agents[0]!;
    const recoveredFocus = inspectionFocusForSessionAcquisition({
      kind: "recovered",
      sessionId: snapshot.sessionId,
    });
    const markup = renderToStaticMarkup(
      <AgentCard
        agent={recoveredAgent}
        witnessReceiptIds={new Set()}
        isInspectionFocus={
          recoveredFocus?.sessionId === snapshot.sessionId &&
          recoveredFocus.agentId === recoveredAgent.agentId
        }
      />,
    );

    expect(recoveredFocus).toBeNull();
    expect(markup).not.toContain("eg-agent-card-focus");
    expect(markup).not.toContain("Selected before Run");
    expect(markup).not.toMatch(/<details[^>]*open(?:="")?[^>]*>/);
  });

  it("records before-Run provenance only for a newly created Session", () => {
    expect(
      inspectionFocusForSessionAcquisition({
        kind: "created",
        sessionId: "session_new",
        agentId: "agent_1",
      }),
    ).toEqual({ sessionId: "session_new", agentId: "agent_1" });
  });

  it("locks Role focus while the Run request is pending", () => {
    const markup = renderToStaticMarkup(
      <SafetyRolePicker
        agents={agents}
        focusedRole="budget"
        onFocus={vi.fn()}
        disabled
      />,
    );

    expect(markup.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
    expect(markup).toMatch(
      /<button[^>]*aria-pressed="true"[^>]*disabled=""[^>]*>[\s\S]*?Budget Role/,
    );
  });

  it.each([
    ["budget", "Budget", "epochguard-budget-v1"],
    ["policy", "Policy", "epochguard-policy-v1"],
  ] as const)(
    "shows the fixed %s Role lifecycle and profile when focused",
    (initialFocusedRole, label, profileVersion) => {
      const markup = renderToStaticMarkup(
        <SessionSafetyWorkspace
          {...baseWorkspaceProps}
          initialFocusedRole={initialFocusedRole}
        />,
      );

      expect(markup).toContain(`aria-label="${label} Role Agent inspection"`);
      expect(markup).toContain(profileVersion);
      expect(markup).toContain(`<dd>${label}</dd>`);
      expect(markup).toContain("<dd>ready</dd>");
    },
  );

  it("keeps Role focus callbacks outside the wired create request", async () => {
    const assignments = {
      inventory: "agent_0",
      budget: "agent_1",
      policy: "agent_2",
    };
    const baseline = buildCreateSessionRequest(
      "normal-world-v1",
      assignments,
    );
    let focusedRole: Role = "inventory";
    const createSession = vi.fn(async (_request: CreateSessionRequest) => ({
      accepted: true,
    }));

    for (const role of ["budget", "policy", "inventory"] as const) {
      const picker = SafetyRolePicker({
        agents,
        focusedRole,
        onFocus: (nextRole) => {
          focusedRole = nextRole;
        },
      });
      const buttons = Children.toArray(picker.props.children) as ReactElement<{
        onClick: () => void;
      }>[];
      const roleIndex = ["inventory", "budget", "policy"].indexOf(role);

      buttons[roleIndex]!.props.onClick();
      await requestEpochGuardSession(
        { createSession },
        "normal-world-v1",
        assignments,
      );

      expect(focusedRole).toBe(role);
    }
    expect(createSession).toHaveBeenCalledTimes(3);
    expect(createSession.mock.calls.map(([request]) => request)).toEqual([
      baseline,
      baseline,
      baseline,
    ]);
    expect(baseline).toEqual({
      scenarioId: "normal-world-v1",
      assignments,
    });
    expect(baseline).not.toHaveProperty("focusedRole");
  });
});

describe("Session Safety five-step live decision flow", () => {
  it("shows three Role Agents, the EpochGuard Gate, and one released Effect", () => {
    const snapshot = SessionDashboardSnapshotSchema.parse(
      mockScenario("normal-released").payload,
    );
    const markup = renderToStaticMarkup(
      <AgentDecisionFlow snapshot={snapshot} />,
    );

    expect(markup).toContain('aria-label="Five-step Agent decision flow"');
    expect(markup).toContain(
      "3 Agents agree in the same world → RELEASE exactly once",
    );
    expect(markup.match(/ROLE AGENT/g)).toHaveLength(3);
    expect(markup).toContain("Inventory Agent");
    expect(markup).toContain("Budget Agent");
    expect(markup).toContain("Policy Agent");
    expect(markup).toContain("EpochGuard Gate");
    expect(markup).toContain("ONE SHARED WORLD");
    expect(markup).toContain("Campaign Effect");
    expect(markup).toContain("RELEASED");
    expect(markup).toContain("1 effect · exactly once");
    expect(markup).toContain("Replay 1→5");
    expect(markup).toContain("SAVED REAL RUN");
  });

  it("makes the all-ALLOW impossible collage visibly fail closed", () => {
    const snapshot = SessionDashboardSnapshotSchema.parse(
      mockScenario("impossible-blocked").payload,
    );
    const markup = renderToStaticMarkup(
      <AgentDecisionFlow snapshot={snapshot} />,
    );

    expect(markup).toContain(
      "3 Agents say ALLOW, but not in the same world → BLOCK",
    );
    expect(markup.match(/>ALLOW</g)).toHaveLength(3);
    expect(markup).toContain("NO SHARED WORLD");
    expect(markup).toContain("L 21 ≥ U 20");
    expect(markup).toContain("LOCKED");
    expect(markup).toContain("0 effects released");
  });

  it("shows a terminal Role Run failure instead of an in-progress refresh", () => {
    const snapshot = SessionDashboardSnapshotSchema.parse(
      mockScenario("run-failed").payload,
    );
    const markup = renderToStaticMarkup(
      <AgentDecisionFlow snapshot={snapshot} />,
    );

    expect(markup).toContain("Runtime failure → FAIL CLOSED");
    expect(markup).toContain("RUN FAILED");
    expect(markup).not.toContain("RE-OBSERVING");
    expect(markup).toContain("FAIL-CLOSED");
    expect(markup).toContain("0 effects released");
  });

  it("keeps a retained ALLOW visible while its selective refresh is running", () => {
    const snapshot = SessionDashboardSnapshotSchema.parse(
      mockScenario("refreshing-budget").payload,
    );
    const markup = renderToStaticMarkup(
      <AgentDecisionFlow snapshot={snapshot} />,
    );

    expect(markup.match(/>ALLOW</g)).toHaveLength(3);
    expect(markup).toContain("Re-observing · retained [v19, v20)");
    expect(markup).toContain("NO SHARED WORLD");
    expect(markup).toContain("LOCKED");
  });

  it("does not describe a sequential fallback as parallel execution", () => {
    const baseline = SessionDashboardSnapshotSchema.parse(
      mockScenario("collecting").payload,
    );
    const markup = renderToStaticMarkup(
      <AgentDecisionFlow
        snapshot={{ ...baseline, coordinationMode: "SEQUENTIAL_FALLBACK" }}
      />,
    );

    expect(markup).toContain("3 Role Agents run sequentially");
    expect(markup).not.toContain("run in parallel");
  });

  it("shows a pending start without claiming execution has begun", () => {
    const baseline = SessionDashboardSnapshotSchema.parse(
      mockScenario("collecting").payload,
    );
    const markup = renderToStaticMarkup(
      <AgentDecisionFlow snapshot={{ ...baseline, coordinationMode: "PENDING" }} />,
    );

    expect(markup).toContain("3 Role Agents are starting");
    expect(markup).not.toContain("run in parallel");
  });
});

describe("Saved official Agent Chat replay", () => {
  const sessionIds = {
    "normal-world-v1": "session_normal",
    "impossible-collage-v1": "session_impossible",
  };

  it("projects all five Normal steps into the original chat message structure", () => {
    const snapshot = SessionDashboardSnapshotSchema.parse(
      mockScenario("normal-released").payload,
    );
    const markup = renderToStaticMarkup(
      <SavedEpochGuardChat
        snapshot={snapshot}
        scenarioId="normal-world-v1"
        sessionIds={sessionIds}
        onScenarioIdChange={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Saved real multi-Agent chat replay"');
    expect(markup).toContain("Agent Chat UI · saved decision replay");
    expect(markup).toContain("SAVED REAL RUN · READ ONLY");
    expect(markup).toContain("Snapshot-derived visualization");
    expect(markup).toContain("not a raw transcript");
    expect(markup.match(/STEP [1-5]\/5/g)).toHaveLength(5);
    expect(markup.match(/>ALLOW</g)).toHaveLength(3);
    expect(markup).toContain("ONE SHARED WORLD");
    expect(markup).toContain("L 10 &lt; U 11");
    expect(markup).toContain("PROTECTED EFFECT · FINAL OUTPUT");
    expect(markup).toContain("RELEASED");
    expect(markup).toContain("1 EFFECT");
    expect(markup).toContain("EXACTLY ONCE");
    expect(markup).toContain('aria-label="Saved replay is read only"');
    expect(markup).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("ends the Impossible replay with an explicit blocked user result", () => {
    const blocked = SessionDashboardSnapshotSchema.parse(
      mockScenario("impossible-blocked").payload,
    );
    const snapshot = {
      ...blocked,
      sessionState: "FAILED" as const,
      gate: {
        ...blocked.gate,
        state: "FAILED" as const,
        reasonCode: "RUN_FAILED" as const,
      },
      availableActions: [],
    };
    const markup = renderToStaticMarkup(
      <SavedEpochGuardChat
        snapshot={snapshot}
        scenarioId="impossible-collage-v1"
        sessionIds={sessionIds}
        onScenarioIdChange={vi.fn()}
      />,
    );

    expect(markup.match(/>ALLOW</g)).toHaveLength(3);
    expect(markup).toContain("NO SHARED WORLD");
    expect(markup).toContain("L 21 ≥ U 20");
    expect(markup).toContain("ACTION BLOCKED · FAIL-CLOSED");
    expect(markup).toContain("0 EFFECTS");
    expect(markup).toContain("NOT RELEASED");
    expect(markup).toContain("RUN FAILED");
    expect(markup).toContain("No publish mutation was emitted");
  });
});

describe("Session Safety final protected output", () => {
  it("shows the released action and exactly-once Effect as the final result", () => {
    const snapshot = SessionDashboardSnapshotSchema.parse(
      mockScenario("normal-released").payload,
    );
    const markup = renderToStaticMarkup(
      <FinalProtectedOutput snapshot={snapshot} />,
    );

    expect(markup).toContain('aria-label="Final protected output"');
    expect(markup).toContain("Final output · user-visible result");
    expect(markup).toContain("RELEASED");
    expect(markup).toContain("PUBLISH_CAMPAIGN");
    expect(markup).toContain("campaign_42");
    expect(markup).toContain("1 EFFECT");
    expect(markup).toContain("Exactly once");
    expect(markup).toContain("ONE SHARED WORLD · L 10 &lt; U 11");
    expect(markup).toContain("effect_normal");
    expect(markup).not.toContain("LOCAL MOCK");
  });

  it("shows no-cut blocking without inventing a released Effect", () => {
    const snapshot = SessionDashboardSnapshotSchema.parse(
      mockScenario("impossible-blocked").payload,
    );
    const markup = renderToStaticMarkup(
      <FinalProtectedOutput snapshot={snapshot} />,
    );

    expect(markup).toContain("ACTION BLOCKED");
    expect(markup).toContain("0 EFFECTS");
    expect(markup).toContain("No publish mutation emitted");
    expect(markup).toContain("NO SHARED WORLD · L 21 ≥ U 20");
    expect(markup).not.toContain("RELEASED");
  });

  it("labels the terminal Impossible failure as fail-closed with RUN_FAILED", () => {
    const blocked = SessionDashboardSnapshotSchema.parse(
      mockScenario("impossible-blocked").payload,
    );
    const snapshot = {
      ...blocked,
      sessionState: "FAILED" as const,
      gate: {
        ...blocked.gate,
        state: "FAILED" as const,
        reasonCode: "RUN_FAILED" as const,
      },
      availableActions: [],
    };
    const markup = renderToStaticMarkup(
      <FinalProtectedOutput snapshot={snapshot} />,
    );

    expect(markup).toContain("ACTION BLOCKED · FAIL-CLOSED");
    expect(markup).toContain("RUN FAILED");
    expect(markup).toContain("0 EFFECTS");
    expect(markup).toContain("NO SHARED WORLD · L 21 ≥ U 20");
    expect(markup).not.toContain("RELEASED");
  });
});
