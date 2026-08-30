import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EpochGuardServiceError } from "./epochguard-service.js";
import { epochGuardRoutes, type EpochGuardRouteServicePort } from "./routes.js";
import {
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_VERSION,
  NORMAL_READY_GOLDEN_SNAPSHOT,
  PROJECTION_MISMATCH_MESSAGE,
  SESSION_NOT_FOUND_MESSAGE,
  STALE_VIEW_MESSAGE,
  SessionDashboardSnapshotSchema,
  UNSUPPORTED_SCHEMA_MESSAGE,
  makeAgentsBusyError,
  makeRoleProfileMismatchError,
  makeUnstableWorldError,
  type EffectRecord,
  type EpochDatabase,
} from "./types.js";
import type { CommitProtectedEffectResult } from "./effect-gate.js";

const PREFIX = "/api/epochguard";
const SESSION_ID = "session_normal_golden";
const REFRESH_PLAN_ID = "refresh_plan_1";
const CAMPAIGN_ID = "campaign_normal_1";

const createRequest = {
  scenarioId: "normal-world-v1" as const,
  assignments: {
    inventory: "agent_inventory_1",
    budget: "agent_budget_1",
    policy: "agent_policy_1",
  },
};

const refreshRequest = {
  expectedSessionRevision: 5,
  refreshPlanId: REFRESH_PLAN_ID,
};

const commitRequest = {
  expectedSessionRevision: 5,
};

const openedApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openedApps.splice(0).map((app) => app.close()));
});

function makeService() {
  const snapshot = SessionDashboardSnapshotSchema.parse(
    NORMAL_READY_GOLDEN_SNAPSHOT,
  );
  const effect: EffectRecord = {
    effectId: "effect_normal_1",
    type: "PUBLISH_CAMPAIGN",
    idempotencyKey: "epochguard:session_normal_golden:permit_normal_1",
    permitId: "permit_normal_1",
    sessionId: SESSION_ID,
    actionHash: snapshot.actionHash,
    dependencySetHash: `sha256:${"1".repeat(64)}`,
    jointValidityCertificateId: "jvc_normal_1",
    createdAt: snapshot.generatedAt,
  };
  const commitResult: CommitProtectedEffectResult = {
    status: "COMMITTED",
    created: true,
    effect,
    effectsInSession: 1,
  };
  const world = {
    snapshotRevision: 1,
    headSeq: 0,
    worldCommits: [],
    resourceVersions: [],
  } satisfies Pick<
    EpochDatabase,
    "snapshotRevision" | "headSeq" | "worldCommits" | "resourceVersions"
  >;

  return {
    createSession: vi.fn(async () => snapshot),
    getSnapshot: vi.fn(() => snapshot),
    refresh: vi.fn(async () => snapshot),
    commit: vi.fn(async () => commitResult),
    resetDemo: vi.fn(async () => undefined),
    getWorld: vi.fn(() => world),
    getEffects: vi.fn((campaignId: string) => ({
      campaignId,
      effects: [] as EffectRecord[],
    })),
  } satisfies EpochGuardRouteServicePort;
}

async function buildApp(
  nodeEnv: "development" | "test" | "production",
  service = makeService(),
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  openedApps.push(app);
  await app.register(epochGuardRoutes, {
    prefix: PREFIX,
    service,
    nodeEnv,
  });
  await app.ready();
  return app;
}

describe("EpochGuard routes", () => {
  it("registers the four relative public routes with their frozen statuses", async () => {
    const service = makeService();
    const app = await buildApp("test", service);

    const created = await app.inject({
      method: "POST",
      url: `${PREFIX}/sessions`,
      payload: createRequest,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(NORMAL_READY_GOLDEN_SNAPSHOT);
    expect(service.createSession).toHaveBeenCalledOnce();
    expect(service.createSession).toHaveBeenCalledWith(createRequest);

    const fetched = await app.inject({
      method: "GET",
      url: `${PREFIX}/sessions/${SESSION_ID}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(NORMAL_READY_GOLDEN_SNAPSHOT);
    expect(service.getSnapshot).toHaveBeenCalledWith(SESSION_ID);

    const refreshed = await app.inject({
      method: "POST",
      url: `${PREFIX}/sessions/${SESSION_ID}/refresh`,
      payload: refreshRequest,
    });
    expect(refreshed.statusCode).toBe(202);
    expect(refreshed.json()).toEqual(NORMAL_READY_GOLDEN_SNAPSHOT);
    expect(service.refresh).toHaveBeenCalledWith(SESSION_ID, refreshRequest);

    const committed = await app.inject({
      method: "POST",
      url: `${PREFIX}/sessions/${SESSION_ID}/commit`,
      payload: commitRequest,
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({
      status: "COMMITTED",
      created: true,
      effectsInSession: 1,
    });
    expect(service.commit).toHaveBeenCalledWith(SESSION_ID, commitRequest);
  });

  it("strictly rejects public body, query, and opaque-id violations before calling the service", async () => {
    const service = makeService();
    const app = await buildApp("test", service);
    const rejected = await Promise.all([
      app.inject({
        method: "POST",
        url: `${PREFIX}/sessions?head=10`,
        payload: createRequest,
      }),
      app.inject({
        method: "POST",
        url: `${PREFIX}/sessions`,
        payload: { ...createRequest, agentId: "agent_inventory_1" },
      }),
      app.inject({
        method: "GET",
        url: `${PREFIX}/sessions/${SESSION_ID}?head=10`,
      }),
      app.inject({
        method: "GET",
        url: `${PREFIX}/sessions/bad!`,
      }),
      app.inject({
        method: "GET",
        url: `${PREFIX}/sessions/${SESSION_ID}`,
        headers: {
          "content-type": "application/json",
          "content-length": "11",
        },
        payload: '{"head":10}',
      }),
      app.inject({
        method: "POST",
        url: `${PREFIX}/sessions/${SESSION_ID}/refresh`,
        payload: {
          ...refreshRequest,
          agentId: "agent_budget_1",
          head: 10,
          receipt: "receipt_1",
          permitId: "permit_1",
          effectsInSession: 0,
        },
      }),
      app.inject({
        method: "POST",
        url: `${PREFIX}/sessions/${SESSION_ID}/refresh?head=10`,
        payload: refreshRequest,
      }),
      app.inject({
        method: "POST",
        url: `${PREFIX}/sessions/bad!/refresh`,
        payload: refreshRequest,
      }),
      app.inject({
        method: "POST",
        url: `${PREFIX}/sessions/${SESSION_ID}/commit`,
        payload: {
          ...commitRequest,
          agentId: "agent_policy_1",
          head: 10,
          receipt: "receipt_1",
          permitId: "permit_1",
          effectCount: 1,
        },
      }),
      app.inject({
        method: "POST",
        url: `${PREFIX}/sessions/${SESSION_ID}/commit?head=10`,
        payload: commitRequest,
      }),
      app.inject({
        method: "POST",
        url: `${PREFIX}/sessions/bad!/commit`,
        payload: commitRequest,
      }),
    ]);

    expect(rejected.map((response) => response.statusCode)).toEqual(
      Array.from({ length: rejected.length }, () => 400),
    );
    expect(service.createSession).not.toHaveBeenCalled();
    expect(service.getSnapshot).not.toHaveBeenCalled();
    expect(service.refresh).not.toHaveBeenCalled();
    expect(service.commit).not.toHaveBeenCalled();
  });

  it("sends typed 404, 409, 422, and 500 API errors with their exact bodies", async () => {
    const service = makeService();
    const app = await buildApp("test", service);

    const notFound = {
      error: "SESSION_NOT_FOUND" as const,
      message: SESSION_NOT_FOUND_MESSAGE,
      sessionId: "session_missing",
    };
    service.getSnapshot.mockImplementationOnce(() => {
      throw new EpochGuardServiceError(418, notFound);
    });
    const notFoundResponse = await app.inject({
      method: "GET",
      url: `${PREFIX}/sessions/session_missing`,
    });
    expect(notFoundResponse.statusCode).toBe(404);
    expect(notFoundResponse.json()).toEqual(notFound);

    const stale = {
      error: "STALE_VIEW" as const,
      message: STALE_VIEW_MESSAGE,
      sessionId: SESSION_ID,
      expectedSessionRevision: 4,
      actualSessionRevision: 5,
    };
    service.refresh.mockImplementationOnce(async () => {
      throw new EpochGuardServiceError(418, stale);
    });
    const staleResponse = await app.inject({
      method: "POST",
      url: `${PREFIX}/sessions/${SESSION_ID}/refresh`,
      payload: refreshRequest,
    });
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json()).toEqual(stale);

    const unsupported = {
      error: "UNSUPPORTED_SCHEMA" as const,
      message: UNSUPPORTED_SCHEMA_MESSAGE,
      expectedSchemaVersion: CONTRACT_SCHEMA_VERSION,
      expectedContractVersion: CONTRACT_VERSION,
      receivedSchemaVersion: null,
      receivedContractVersion: null,
    };
    service.createSession.mockImplementationOnce(async () => {
      throw new EpochGuardServiceError(418, unsupported);
    });
    const unsupportedResponse = await app.inject({
      method: "POST",
      url: `${PREFIX}/sessions`,
      payload: createRequest,
    });
    expect(unsupportedResponse.statusCode).toBe(422);
    expect(unsupportedResponse.json()).toEqual(unsupported);

    const projectionMismatch = {
      error: "PROJECTION_MISMATCH" as const,
      message: PROJECTION_MISMATCH_MESSAGE,
      sessionId: SESSION_ID,
      snapshotRevision: 12,
    };
    service.getSnapshot.mockImplementationOnce(() => {
      throw new EpochGuardServiceError(418, projectionMismatch);
    });
    const mismatchResponse = await app.inject({
      method: "GET",
      url: `${PREFIX}/sessions/${SESSION_ID}`,
    });
    expect(mismatchResponse.statusCode).toBe(500);
    expect(mismatchResponse.json()).toEqual(projectionMismatch);
  });

  it("derives canonical v7 conflict statuses from parsed bodies rather than constructor status", async () => {
    const service = makeService();
    const app = await buildApp("test", service);

    const unstable = makeUnstableWorldError(null, 12);
    service.createSession.mockImplementationOnce(async () => {
      throw new EpochGuardServiceError(418, unstable);
    });
    const unstableResponse = await app.inject({
      method: "POST",
      url: `${PREFIX}/sessions`,
      payload: createRequest,
    });
    expect(unstableResponse.statusCode).toBe(409);
    expect(unstableResponse.json()).toEqual(unstable);

    const mismatch = makeRoleProfileMismatchError(
      "inventory",
      createRequest.assignments.inventory,
    );
    service.createSession.mockImplementationOnce(async () => {
      throw new EpochGuardServiceError(418, mismatch);
    });
    const mismatchResponse = await app.inject({
      method: "POST",
      url: `${PREFIX}/sessions`,
      payload: createRequest,
    });
    expect(mismatchResponse.statusCode).toBe(409);
    expect(mismatchResponse.json()).toEqual(mismatch);

    const busy = makeAgentsBusyError(SESSION_ID, createRequest.assignments);
    service.resetDemo.mockImplementationOnce(async () => {
      throw new EpochGuardServiceError(418, busy);
    });
    const busyResponse = await app.inject({
      method: "POST",
      url: `${PREFIX}/demo/reset`,
    });
    expect(busyResponse.statusCode).toBe(409);
    expect(busyResponse.json()).toEqual(busy);
  });

  it("rejects arbitrary Service error bodies at construction and the HTTP boundary", async () => {
    const arbitraryBody = {
      error: "INVENTED_PUBLIC_ERROR",
      message: "This body must never be sent.",
      arbitrary: true,
    };
    expect(
      () => new EpochGuardServiceError(200, arbitraryBody as never),
    ).toThrow();

    const service = makeService();
    const app = await buildApp("test", service);
    const forged = new EpochGuardServiceError(
      200,
      makeUnstableWorldError(null, 0),
    );
    Object.defineProperty(forged, "body", { value: arbitraryBody });
    service.createSession.mockImplementationOnce(async () => {
      throw forged;
    });

    const response = await app.inject({
      method: "POST",
      url: `${PREFIX}/sessions`,
      payload: createRequest,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toEqual(arbitraryBody);
    expect(response.json().error).not.toBe(arbitraryBody.error);
    expect(JSON.stringify(response.json())).not.toContain(arbitraryBody.error);
    expect(JSON.stringify(response.json())).not.toContain(arbitraryBody.message);
  });

  it("treats internal Service Zod failures as a redacted 500 rather than client input", async () => {
    const service = makeService();
    const app = await buildApp("test", service);
    service.createSession.mockImplementationOnce(async () => {
      z.object({ internalPersistenceField: z.string() }).parse({
        internalPersistenceField: 42,
      });
      throw new Error("unreachable");
    });

    const response = await app.inject({
      method: "POST",
      url: `${PREFIX}/sessions`,
      payload: createRequest,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty("issues");
    expect(JSON.stringify(response.json())).not.toContain(
      "internalPersistenceField",
    );
    expect(JSON.stringify(response.json())).not.toContain("expected string");
  });

  it("redacts ordinary internal Service failures as generic 500 responses", async () => {
    const service = makeService();
    const app = await buildApp("test", service);
    service.getSnapshot.mockImplementationOnce(() => {
      throw new Error("sensitive persistence path C:/private/epochguard.json");
    });

    const response = await app.inject({
      method: "GET",
      url: `${PREFIX}/sessions/${SESSION_ID}`,
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.stringify(response.json())).not.toContain("sensitive");
    expect(JSON.stringify(response.json())).not.toContain("epochguard.json");
  });

  it.each(["test", "development"] as const)(
    "exposes strict debug routes in %s but never exposes /validate",
    async (nodeEnv) => {
      const service = makeService();
      const app = await buildApp(nodeEnv, service);

      const reset = await app.inject({
        method: "POST",
        url: `${PREFIX}/demo/reset`,
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toEqual({ ok: true });

      const world = await app.inject({
        method: "GET",
        url: `${PREFIX}/world`,
      });
      expect(world.statusCode).toBe(200);
      expect(world.json()).toEqual({
        snapshotRevision: 1,
        headSeq: 0,
        worldCommits: [],
        resourceVersions: [],
      });

      const effects = await app.inject({
        method: "GET",
        url: `${PREFIX}/effects/${CAMPAIGN_ID}`,
      });
      expect(effects.statusCode).toBe(200);
      expect(effects.json()).toEqual({ campaignId: CAMPAIGN_ID, effects: [] });

      const strictDebugResponses = await Promise.all([
        app.inject({
          method: "POST",
          url: `${PREFIX}/demo/reset`,
          payload: { force: true },
        }),
        app.inject({
          method: "POST",
          url: `${PREFIX}/demo/reset?force=true`,
        }),
        app.inject({
          method: "GET",
          url: `${PREFIX}/world?head=10`,
        }),
        app.inject({
          method: "GET",
          url: `${PREFIX}/world`,
          headers: {
            "content-type": "application/json",
            "content-length": "11",
          },
          payload: '{"head":10}',
        }),
        app.inject({
          method: "GET",
          url: `${PREFIX}/effects/bad!`,
        }),
        app.inject({
          method: "GET",
          url: `${PREFIX}/effects/${CAMPAIGN_ID}?head=10`,
        }),
      ]);
      expect(
        strictDebugResponses.map((response) => response.statusCode),
      ).toEqual(Array.from({ length: strictDebugResponses.length }, () => 400));
      expect(service.resetDemo).toHaveBeenCalledTimes(1);
      expect(service.getWorld).toHaveBeenCalledTimes(1);
      expect(service.getEffects).toHaveBeenCalledTimes(1);

      for (const method of ["GET", "POST"] as const) {
        const validate = await app.inject({
          method,
          url: `${PREFIX}/validate`,
        });
        expect(validate.statusCode).toBe(404);
      }
    },
  );

  it("does not register any debug or validation route in production", async () => {
    const service = makeService();
    const app = await buildApp("production", service);
    const absent = await Promise.all([
      app.inject({ method: "POST", url: `${PREFIX}/demo/reset` }),
      app.inject({ method: "GET", url: `${PREFIX}/world` }),
      app.inject({
        method: "GET",
        url: `${PREFIX}/effects/${CAMPAIGN_ID}`,
      }),
      app.inject({ method: "GET", url: `${PREFIX}/validate` }),
      app.inject({ method: "POST", url: `${PREFIX}/validate` }),
    ]);

    expect(absent.map((response) => response.statusCode)).toEqual(
      Array.from({ length: absent.length }, () => 404),
    );
    expect(service.resetDemo).not.toHaveBeenCalled();
    expect(service.getWorld).not.toHaveBeenCalled();
    expect(service.getEffects).not.toHaveBeenCalled();
  });
});
