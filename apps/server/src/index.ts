import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { DualScenarioEpochGuardService } from "./epochguard/dual-scenario-service.js";
import { EpochGuardService } from "./epochguard/epochguard-service.js";
import { EpochStore } from "./epochguard/epoch-store.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const normalEpochStore = new EpochStore(
  path.join(config.dataDirectory, "epochguard-normal.json"),
);
const impossibleEpochStore = new EpochStore(
  path.join(config.dataDirectory, "epochguard-impossible.json"),
);
const normalEpochGuard = new EpochGuardService({
  store: normalEpochStore,
  agents: service,
  workspaces,
});
const impossibleEpochGuard = new EpochGuardService({
  store: impossibleEpochStore,
  agents: service,
  workspaces,
});
const epochGuard = new DualScenarioEpochGuardService({
  normal: { store: normalEpochStore, service: normalEpochGuard },
  impossible: {
    store: impossibleEpochStore,
    service: impossibleEpochGuard,
  },
});
await epochGuard.initialize();

const app = await createApp(config, service, epochGuard);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
