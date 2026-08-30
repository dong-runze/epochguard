import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import type { EpochGuardRouteServicePort } from "./epochguard/routes.js";
import type { SessionDashboardSnapshot } from "./epochguard/types.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const protectedAgentIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;
const appOptions = { protectedAgentIds } as const;
const roleAgentNames = [
  "EpochGuard Inventory Agent",
  "EpochGuard Budget Agent",
  "EpochGuard Policy Agent",
] as const;

const sessionSnapshot = {
  sessionId: "session_demo",
  scenarioId: "normal-world-v1",
  sessionRevision: 1,
} as unknown as SessionDashboardSnapshot;

function epochGuardService(): EpochGuardRouteServicePort {
  return {
    createSession: async () => sessionSnapshot,
    getSnapshot: () => sessionSnapshot,
    refresh: async () => sessionSnapshot,
    commit: async () => ({
      status: "REJECTED",
      reasonCode: "CONSISTENT_DENY",
      message: "Protected effect remains locked.",
      effectsInSession: 0,
      error: null,
    }),
    resetDemo: async () => undefined,
    getWorld: () => ({
      snapshotRevision: 0,
      headSeq: 0,
      worldCommits: [],
      resourceVersions: [],
    }),
    getEffects: (campaignId) => ({ campaignId, effects: [] }),
  };
}

const createSessionPayload = {
  scenarioId: "normal-world-v1",
  assignments: {
    inventory: "agent_inventory",
    budget: "agent_budget",
    policy: "agent_policy",
  },
};

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
      epochGuardService(),
      appOptions,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);

    const epochGuardDenied = await app.inject({
      method: "GET",
      url: "/api/epochguard/sessions/session_demo",
    });
    expect(epochGuardDenied.statusCode).toBe(401);
    const epochGuardAllowed = await app.inject({
      method: "GET",
      url: "/api/epochguard/sessions/session_demo",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(epochGuardAllowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      epochGuardService(),
      appOptions,
    );
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("registers all four formal EpochGuard routes after the Starter API", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      epochGuardService(),
      appOptions,
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/epochguard/sessions",
      payload: createSessionPayload,
    });
    const read = await app.inject({
      method: "GET",
      url: "/api/epochguard/sessions/session_demo",
    });
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/epochguard/sessions/session_demo/refresh",
      payload: {
        expectedSessionRevision: 1,
        refreshPlanId: "refresh_demo",
      },
    });
    const committed = await app.inject({
      method: "POST",
      url: "/api/epochguard/sessions/session_demo/commit",
      payload: { expectedSessionRevision: 1 },
    });

    expect(created.statusCode).toBe(201);
    expect(read.statusCode).toBe(200);
    expect(refreshed.statusCode).toBe(202);
    expect(committed.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(
      200,
    );
    await app.close();
  });

  it("reserves EpochGuard Role identities and blocks ordinary Agent mutations", async () => {
    const protectedId = protectedAgentIds[0];
    const mutations = {
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
      deleteAgent: vi.fn(),
      startAgent: vi.fn(),
      stopAgent: vi.fn(),
      sendMessage: vi.fn(),
    };
    const protectedService = {
      ...service,
      ...mutations,
      getAgent: () => ({
        id: protectedId,
        name: "Renamed after initialization",
      }),
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      protectedService,
      epochGuardService(),
      appOptions,
    );

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { name: "EpochGuard Budget Agent" },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/agents/${protectedId}`,
        payload: { description: "changed" },
      }),
      app.inject({ method: "DELETE", url: `/api/agents/${protectedId}` }),
      app.inject({ method: "POST", url: `/api/agents/${protectedId}/start` }),
      app.inject({ method: "POST", url: `/api/agents/${protectedId}/stop` }),
      app.inject({
        method: "POST",
        url: `/api/agents/${protectedId}/messages`,
        payload: { content: "bypass" },
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      403, 403, 403, 403, 403, 403,
    ]);
    for (const mutation of Object.values(mutations)) {
      expect(mutation).not.toHaveBeenCalled();
    }
    await app.close();
  });

  it("derives and freezes exactly three unique protected Role Agent IDs", async () => {
    const roleAgents = roleAgentNames.map((name, index) => ({
      id: protectedAgentIds[index]!,
      name,
    }));
    const initializedService = {
      ...service,
      listAgents: () => roleAgents,
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      initializedService,
      epochGuardService(),
    );
    await app.close();

    await expect(
      createApp(
        loadConfig({ NODE_ENV: "test" }),
        service,
        epochGuardService(),
      ),
    ).rejects.toThrow("Expected exactly one initialized EpochGuard Inventory Agent");
    await expect(
      createApp(
        loadConfig({ NODE_ENV: "test" }),
        initializedService,
        epochGuardService(),
        {
          protectedAgentIds: [
            protectedAgentIds[0],
            protectedAgentIds[0],
            protectedAgentIds[2],
          ],
        },
      ),
    ).rejects.toThrow("exactly three unique protected Agent IDs");
  });

  it("authenticates only four formal EpochGuard routes in production without a prior Web build", async () => {
    const webRoot = await mkdtemp(path.join(tmpdir(), "epochguard-web-root-"));
    await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>test</title>");
    const token = "production-test-token-1234567890";
    const formalRequests = [
      {
        method: "POST" as const,
        url: "/api/epochguard/sessions",
        payload: createSessionPayload,
      },
      {
        method: "GET" as const,
        url: "/api/epochguard/sessions/session_demo",
      },
      {
        method: "POST" as const,
        url: "/api/epochguard/sessions/session_demo/refresh",
        payload: {
          expectedSessionRevision: 1,
          refreshPlanId: "refresh_demo",
        },
      },
      {
        method: "POST" as const,
        url: "/api/epochguard/sessions/session_demo/commit",
        payload: { expectedSessionRevision: 1 },
      },
    ];
    const app = await createApp(
      loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        APP_AUTH_TOKEN: token,
      }),
      service,
      epochGuardService(),
      { webRoot, protectedAgentIds },
    );
    try {
      const denied = await Promise.all(
        formalRequests.map((request) => app.inject(request)),
      );
      expect(denied.map((response) => response.statusCode)).toEqual([
        401, 401, 401, 401,
      ]);

      const formal = await Promise.all(
        formalRequests.map((request) =>
          app.inject({
            ...request,
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
      );
      expect(formal.map((response) => response.statusCode)).toEqual([
        201, 200, 202, 200,
      ]);

      const authorization = { authorization: `Bearer ${token}` };
      const forbidden = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/epochguard/demo/reset",
          headers: authorization,
          payload: {},
        }),
        app.inject({
          method: "GET",
          url: "/api/epochguard/world",
          headers: authorization,
        }),
        app.inject({
          method: "GET",
          url: "/api/epochguard/effects/campaign_42",
          headers: authorization,
        }),
        app.inject({
          method: "POST",
          url: "/api/epochguard/validate",
          headers: authorization,
          payload: {},
        }),
        app.inject({
          method: "GET",
          url: "/api/epochguard/debug",
          headers: authorization,
        }),
      ]);
      for (const response of forbidden) {
        expect(response.statusCode).toBe(404);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.json()).toEqual({ error: "API route not found" });
      }
    } finally {
      await app.close();
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
