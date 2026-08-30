import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import {
  epochGuardRoutes,
  type EpochGuardRouteServicePort,
} from "./epochguard/routes.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});

const EPOCHGUARD_ROLE_AGENT_NAMES = new Set([
  "EpochGuard Inventory Agent",
  "EpochGuard Budget Agent",
  "EpochGuard Policy Agent",
]);

export interface CreateAppOptions {
  /** Test-only seam; production callers default to apps/web/dist. */
  webRoot?: string;
  /** Test seam; production freezes IDs resolved from the initialized Agent list. */
  protectedAgentIds?: readonly string[];
}

function assertNameIsNotReserved(name: string | undefined): void {
  if (name !== undefined && EPOCHGUARD_ROLE_AGENT_NAMES.has(name.trim())) {
    throw new HttpError(403, "EpochGuard Role Agent identities are reserved");
  }
}

function resolveProtectedAgentIds(
  service: AgentService,
  override: readonly string[] | undefined,
): ReadonlySet<string> {
  const ids =
    override === undefined
      ? [...EPOCHGUARD_ROLE_AGENT_NAMES].map((name) => {
          const matches = service.listAgents().filter((agent) => agent.name === name);
          if (matches.length !== 1) {
            throw new Error(`Expected exactly one initialized ${name}`);
          }
          return matches[0]!.id;
        })
      : [...override];
  if (ids.length !== EPOCHGUARD_ROLE_AGENT_NAMES.size || new Set(ids).size !== ids.length) {
    throw new Error("EpochGuard requires exactly three unique protected Agent IDs");
  }
  return new Set(ids);
}

function assertAgentIsNotProtected(
  protectedAgentIds: ReadonlySet<string>,
  agentId: string,
): void {
  if (protectedAgentIds.has(agentId)) {
    throw new HttpError(
      403,
      "EpochGuard Role Agents are managed by the safety control plane",
    );
  }
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
  epochGuardService: EpochGuardRouteServicePort,
  options: CreateAppOptions = {},
): Promise<FastifyInstance> {
  const protectedAgentIds = resolveProtectedAgentIds(
    service,
    options.protectedAgentIds,
  );
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    assertNameIsNotReserved(body.name);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    assertAgentIsNotProtected(protectedAgentIds, id);
    const body = updateAgentBody.parse(request.body);
    assertNameIsNotReserved(body.name);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    assertAgentIsNotProtected(protectedAgentIds, id);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    assertAgentIsNotProtected(protectedAgentIds, id);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    assertAgentIsNotProtected(protectedAgentIds, id);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    assertAgentIsNotProtected(protectedAgentIds, id);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  await app.register(epochGuardRoutes, {
    prefix: "/api/epochguard",
    service: epochGuardService,
    nodeEnv: config.nodeEnv,
  });

  if (config.nodeEnv === "production") {
    const webRoot =
      options.webRoot ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
