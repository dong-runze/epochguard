import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { EpochGuardServiceError } from "./epochguard-service.js";
import {
  API_ERROR_STATUS,
  CommitSessionRequestSchema,
  CreateSessionRequestSchema,
  OpaqueIdSchema,
  RefreshSessionRequestSchema,
  type CommitSessionRequest,
  type CreateSessionRequest,
  type EffectRecord,
  type EpochDatabase,
  type RefreshSessionRequest,
  type SessionDashboardSnapshot,
} from "./types.js";
import type { CommitProtectedEffectResult } from "./effect-gate.js";

const emptyObject = z.object({}).strict();
const sessionParams = z.object({ id: OpaqueIdSchema }).strict();
const campaignParams = z.object({ campaignId: OpaqueIdSchema }).strict();

export interface EpochGuardRouteServicePort {
  createSession(request: CreateSessionRequest): Promise<SessionDashboardSnapshot>;
  getSnapshot(sessionId: string): SessionDashboardSnapshot;
  refresh(
    sessionId: string,
    request: RefreshSessionRequest,
  ): Promise<SessionDashboardSnapshot>;
  commit(
    sessionId: string,
    request: CommitSessionRequest,
  ): Promise<CommitProtectedEffectResult>;
  resetDemo(): Promise<void>;
  getWorld(): Pick<
    EpochDatabase,
    "snapshotRevision" | "headSeq" | "worldCommits" | "resourceVersions"
  >;
  getEffects(campaignId: string): {
    campaignId: string;
    effects: EffectRecord[];
  };
}

interface EpochGuardRoutesOptions {
  service: EpochGuardRouteServicePort;
  nodeEnv: "development" | "test" | "production";
}

function emptyInput(request: {
  query: unknown;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}): void {
  emptyObject.parse(request.query ?? {});
  const contentLength = request.headers["content-length"];
  const contentLengths = Array.isArray(contentLength)
    ? contentLength
    : contentLength === undefined
      ? []
      : [contentLength];
  const hasWireBody =
    contentLengths.some((value) => {
      const parsed = Number(value);
      return !Number.isFinite(parsed) || parsed > 0;
    }) || request.headers["transfer-encoding"] !== undefined;
  if (request.body !== undefined || hasWireBody) {
    z.undefined().parse("GET requests do not accept a body");
  }
}

function sendKnownError(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof EpochGuardServiceError)) return false;
  const code =
    typeof error.body.error === "string" &&
    Object.prototype.hasOwnProperty.call(API_ERROR_STATUS, error.body.error)
      ? API_ERROR_STATUS[
          error.body.error as keyof typeof API_ERROR_STATUS
        ]
      : error.statusCode;
  void reply.code(code).send(error.body);
  return true;
}

async function routeCall<T>(
  reply: FastifyReply,
  operation: () => T | Promise<T>,
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (sendKnownError(error, reply)) return undefined;
    if (error instanceof z.ZodError) {
      void reply.code(400).send({
        error: "Invalid request",
        details: error.issues,
      });
      return undefined;
    }
    throw error;
  }
}

/**
 * Relative EpochGuard API plugin. EG-09 owns registration with the
 * `/api/epochguard` prefix and the surrounding authentication boundary.
 */
export const epochGuardRoutes: FastifyPluginAsync<EpochGuardRoutesOptions> =
  async (app, options) => {
    const { service } = options;

    app.post("/sessions", async (request, reply) => {
      const snapshot = await routeCall(reply, () => {
        emptyObject.parse(request.query ?? {});
        return service.createSession(
          CreateSessionRequestSchema.parse(request.body),
        );
      });
      if (snapshot !== undefined) return reply.code(201).send(snapshot);
    });

    app.get("/sessions/:id", async (request, reply) => {
      const snapshot = await routeCall(reply, () => {
        emptyInput(request);
        const { id } = sessionParams.parse(request.params);
        return service.getSnapshot(id);
      });
      if (snapshot !== undefined) return reply.code(200).send(snapshot);
    });

    app.post("/sessions/:id/refresh", async (request, reply) => {
      const snapshot = await routeCall(reply, () => {
        emptyObject.parse(request.query ?? {});
        const { id } = sessionParams.parse(request.params);
        const body = RefreshSessionRequestSchema.parse(request.body);
        return service.refresh(id, body);
      });
      if (snapshot !== undefined) return reply.code(202).send(snapshot);
    });

    app.post("/sessions/:id/commit", async (request, reply) => {
      const result = await routeCall(reply, () => {
        emptyObject.parse(request.query ?? {});
        const { id } = sessionParams.parse(request.params);
        const body = CommitSessionRequestSchema.parse(request.body);
        return service.commit(id, body);
      });
      if (result !== undefined) return reply.code(200).send(result);
    });

    if (options.nodeEnv !== "production") {
      app.post("/demo/reset", async (request, reply) => {
        const result = await routeCall(reply, async () => {
          emptyObject.parse(request.query ?? {});
          emptyObject.parse(request.body ?? {});
          await service.resetDemo();
          return { ok: true as const };
        });
        if (result !== undefined) return reply.code(200).send(result);
      });

      app.get("/world", async (request, reply) => {
        const result = await routeCall(reply, () => {
          emptyInput(request);
          return service.getWorld();
        });
        if (result !== undefined) return reply.code(200).send(result);
      });

      app.get("/effects/:campaignId", async (request, reply) => {
        const result = await routeCall(reply, () => {
          emptyInput(request);
          const { campaignId } = campaignParams.parse(request.params);
          return service.getEffects(campaignId);
        });
        if (result !== undefined) return reply.code(200).send(result);
      });
    }
  };
