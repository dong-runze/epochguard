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
  SafetyRolePicker,
  SessionSafetyWorkspace,
} from "./App";
import { AgentCard } from "./epochguard/EpochGuardDashboard";
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
