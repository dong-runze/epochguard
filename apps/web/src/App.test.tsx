import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  getRuntimeDisplayLabel,
  getRuntimeReadiness,
  SessionSafetyWorkspace,
} from "./App";
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
