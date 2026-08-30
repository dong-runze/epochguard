import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  environment: Record<string, string> = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...environment,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("reports the configured execution boundary without calling a local process a container", async () => {
    const localService = await makeService();
    const containerService = await makeService(new FakeRunner(), {
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "docker",
    });

    await expect(localService.systemInfo()).resolves.toMatchObject({
      runtimeProvider: "local-process",
      containerEngine: null,
      runtime: "Codex CLI in local process",
    });
    await expect(containerService.systemInfo()).resolves.toMatchObject({
      runtimeProvider: "container",
      containerEngine: "docker",
      runtime: "Codex CLI in docker Runtime",
    });
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
    expect(service.getRun(run.id).threadId).toBe("fake-thread");
  });

  it("freezes thread evidence on the exact Run that completed", async () => {
    let runNumber = 0;
    const service = await makeService({
      run: async () => {
        runNumber += 1;
        return {
          output: `completed ${runNumber}`,
          threadId: `thread_${runNumber}`,
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Thread Evidence" });

    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const second = await service.sendMessage(agent.id, "second");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");

    expect(service.getRun(first.run.id).threadId).toBe("thread_1");
    expect(service.getRun(second.run.id).threadId).toBe("thread_2");
    expect(service.getAgent(agent.id).codexThreadId).toBe("thread_2");
  });

  it("migrates legacy Run records without threadId to null", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-legacy-run-test-"));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, "data");
    const databasePath = path.join(dataDirectory, "db.json");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      databasePath,
      JSON.stringify(
        {
          version: 1,
          agents: [],
          messages: [],
          runs: [
            {
              id: "legacy_completed_run",
              agentId: "deleted_agent",
              status: "completed",
              prompt: "legacy",
              output: "done",
              error: null,
              usage: null,
              startedAt: "2026-08-29T12:00:00.000Z",
              completedAt: "2026-08-29T12:00:01.000Z",
              createdAt: "2026-08-29T12:00:00.000Z",
            },
            {
              id: "legacy_queued_run",
              agentId: "deleted_agent",
              status: "queued",
              prompt: "queued before restart",
              output: null,
              error: null,
              usage: null,
              startedAt: null,
              completedAt: null,
              createdAt: "2026-08-29T12:00:02.000Z",
            },
            {
              id: "legacy_running_run",
              agentId: "deleted_agent",
              status: "running",
              prompt: "running before restart",
              output: null,
              error: null,
              usage: null,
              startedAt: "2026-08-29T12:00:03.000Z",
              completedAt: null,
              createdAt: "2026-08-29T12:00:03.000Z",
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dataDirectory,
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const store = new JsonStore(databasePath);
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
    );
    await service.initialize();

    expect(service.getRun("legacy_completed_run").threadId).toBeNull();
    expect(service.getRun("legacy_queued_run")).toMatchObject({
      status: "cancelled",
      threadId: null,
      error: "Server restarted while this run was active",
    });
    expect(service.getRun("legacy_running_run")).toMatchObject({
      status: "cancelled",
      threadId: null,
      error: "Server restarted while this run was active",
    });
    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as {
      runs: Array<{ threadId?: string | null }>;
    };
    expect(persisted.runs).toHaveLength(3);
    for (const run of persisted.runs) {
      expect(run).toHaveProperty("threadId", null);
    }
  });

  it("records a successful Runner result with nullable thread evidence", async () => {
    const service = await makeService({
      run: async () => ({ output: "completed without thread", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Nullable Thread" });
    const { run } = await service.sendMessage(agent.id, "complete without thread");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).threadId).toBeNull();
    expect(service.getAgent(agent.id).codexThreadId).toBeNull();
  });

  it("keeps two Agents isolated when their Runs complete in reverse order", async () => {
    const completions = new Map<string, (result: RunnerResult) => void>();
    const service = await makeService({
      run: (request) =>
        new Promise<RunnerResult>((resolve) => {
          completions.set(request.agentId, resolve);
        }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const firstAgent = await service.createAgent({ name: "First Agent" });
    const secondAgent = await service.createAgent({ name: "Second Agent" });
    const first = await service.sendMessage(firstAgent.id, "first pending");
    const second = await service.sendMessage(secondAgent.id, "second pending");
    await expect.poll(() => completions.size).toBe(2);

    completions.get(secondAgent.id)?.({
      output: "second completed first",
      threadId: "thread_second",
      usage: null,
    });
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    completions.get(firstAgent.id)?.({
      output: "first completed second",
      threadId: "thread_first",
      usage: null,
    });
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");

    expect(service.getRun(first.run.id).threadId).toBe("thread_first");
    expect(service.getRun(second.run.id).threadId).toBe("thread_second");
    expect(service.getAgent(firstAgent.id).codexThreadId).toBe("thread_first");
    expect(service.getAgent(secondAgent.id).codexThreadId).toBe("thread_second");
  });

  it("does not copy an old Agent thread onto a failed Run", async () => {
    let callCount = 0;
    const service = await makeService({
      run: async () => {
        callCount += 1;
        if (callCount === 1) {
          return { output: "seed", threadId: "thread_old", usage: null };
        }
        throw new Error("runner failed");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Failure Isolation" });
    const seed = await service.sendMessage(agent.id, "seed thread");
    await expect.poll(() => service.getRun(seed.run.id).status).toBe("completed");
    const failed = await service.sendMessage(agent.id, "fail now");
    await expect.poll(() => service.getRun(failed.run.id).status).toBe("failed");

    expect(service.getRun(failed.run.id).threadId).toBeNull();
    expect(service.getAgent(agent.id).codexThreadId).toBe("thread_old");
  });

  it("does not accept a Runner thread after cancellation", async () => {
    let callCount = 0;
    let rejectPending!: (reason: Error) => void;
    const service = await makeService({
      run: async () => {
        callCount += 1;
        if (callCount === 1) {
          return { output: "seed", threadId: "thread_old", usage: null };
        }
        return new Promise<RunnerResult>((_resolve, reject) => {
          rejectPending = reject;
        });
      },
      cancel: async () => {
        rejectPending(new Error("cancelled by test"));
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Cancellation Isolation" });
    const seed = await service.sendMessage(agent.id, "seed thread");
    await expect.poll(() => service.getRun(seed.run.id).status).toBe("completed");
    const cancelled = await service.sendMessage(agent.id, "cancel now");
    await expect.poll(() => callCount).toBe(2);
    await service.stopAgent(agent.id);

    expect(service.getRun(cancelled.run.id)).toMatchObject({
      status: "cancelled",
      threadId: null,
    });
    expect(service.getAgent(agent.id)).toMatchObject({
      status: "stopped",
      codexThreadId: "thread_old",
    });
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});
