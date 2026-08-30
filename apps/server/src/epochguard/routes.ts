import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { EpochGuardServiceError } from "./epochguard-service.js";
import {
  API_ERROR_STATUS,
  ApiErrorBodySchema,
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
  const body = (() => {
    try {
      return ApiErrorBodySchema.parse(error.body);
    } catch {
      throw new Error("EpochGuard Service emitted an invalid API error body.");
    }
  })();
  void reply.code(API_ERROR_STATUS[body.error]).send(body);
  return true;
}

type ClientInputResult<T> =
  | { ok: true; value: T }
  | { ok: false };

function parseClientInput<T>(
  reply: FastifyReply,
  operation: () => T,
): ClientInputResult<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    if (error instanceof z.ZodError) {
      void reply.code(400).send({
        error: "Invalid request",
        details: error.issues,
      });
      return { ok: false };
    }
    throw error;
  }
}

async function executeService<T>(
  reply: FastifyReply,
  operation: () => T | Promise<T>,
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (sendKnownError(error, reply)) return undefined;
    throw new Error("EpochGuard Service execution failed.");
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
      const input = parseClientInput(reply, () => {
        emptyObject.parse(request.query ?? {});
        return CreateSessionRequestSchema.parse(request.body);
      });
      if (!input.ok) return undefined;
      const snapshot = await executeService(reply, () =>
        service.createSession(input.value),
      );
      if (snapshot !== undefined) return reply.code(201).send(snapshot);
    });

    app.get("/sessions/:id", async (request, reply) => {
      const input = parseClientInput(reply, () => {
        emptyInput(request);
        return sessionParams.parse(request.params);
      });
      if (!input.ok) return undefined;
      const snapshot = await executeService(reply, () =>
        service.getSnapshot(input.value.id),
      );
      if (snapshot !== undefined) return reply.code(200).send(snapshot);
    });

    app.post("/sessions/:id/refresh", async (request, reply) => {
      const input = parseClientInput(reply, () => {
        emptyObject.parse(request.query ?? {});
        const { id } = sessionParams.parse(request.params);
        const body = RefreshSessionRequestSchema.parse(request.body);
        return { id, body };
      });
      if (!input.ok) return undefined;
      const snapshot = await executeService(reply, () =>
        service.refresh(input.value.id, input.value.body),
      );
      if (snapshot !== undefined) return reply.code(202).send(snapshot);
    });

    app.post("/sessions/:id/commit", async (request, reply) => {
      const input = parseClientInput(reply, () => {
        emptyObject.parse(request.query ?? {});
        const { id } = sessionParams.parse(request.params);
        const body = CommitSessionRequestSchema.parse(request.body);
        return { id, body };
      });
      if (!input.ok) return undefined;
      const result = await executeService(reply, () =>
        service.commit(input.value.id, input.value.body),
      );
      if (result !== undefined) return reply.code(200).send(result);
    });

    if (options.nodeEnv !== "production") {
      app.post("/demo/reset", async (request, reply) => {
        const input = parseClientInput(reply, () => {
          emptyObject.parse(request.query ?? {});
          emptyObject.parse(request.body ?? {});
          return true;
        });
        if (!input.ok) return undefined;
        const result = await executeService(reply, async () => {
          await service.resetDemo();
          return { ok: true as const };
        });
        if (result !== undefined) return reply.code(200).send(result);
      });

      app.get("/world", async (request, reply) => {
        const input = parseClientInput(reply, () => {
          emptyInput(request);
          return true;
        });
        if (!input.ok) return undefined;
        const result = await executeService(reply, () => service.getWorld());
        if (result !== undefined) return reply.code(200).send(result);
      });

      app.get("/effects/:campaignId", async (request, reply) => {
        const input = parseClientInput(reply, () => {
          emptyInput(request);
          return campaignParams.parse(request.params);
        });
        if (!input.ok) return undefined;
        const result = await executeService(reply, () =>
          service.getEffects(input.value.campaignId),
        );
        if (result !== undefined) return reply.code(200).send(result);
      });
    }
  };
