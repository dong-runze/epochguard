import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeWorkspace(): Promise<{
  root: string;
  manager: WorkspaceManager;
  agent: Agent;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-workspace-test-"));
  temporaryDirectories.push(root);
  const workspaceRoot = path.join(root, "workspaces");
  const manager = new WorkspaceManager(workspaceRoot);
  await manager.initialize();
  const timestamp = new Date().toISOString();
  const agent: Agent = {
    id: "agent_inventory",
    name: "Inventory Agent",
    description: "Reads inventory evidence",
    instructions: "Return only the inventory decision.",
    status: "ready",
    workspacePath: manager.workspacePath("agent_inventory"),
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await manager.create(agent);
  return { root, manager, agent };
}

describe("WorkspaceManager EpochGuard seams", () => {
  it("atomically writes one immutable assignment-scoped canonical Pack", async () => {
    const { manager, agent } = await makeWorkspace();
    const canonicalPack =
      '{"assignment":{"runAssignmentId":"assignment_1"},"schemaVersion":1}';
    const relativePath = await manager.writeEvidencePackAtomic(
      agent.id,
      "session_1",
      "inventory",
      "assignment_1",
      canonicalPack,
    );

    expect(relativePath).toBe(
      ".epochguard/sessions/session_1/inventory/assignment_1.json",
    );
    const absolutePath = path.join(
      agent.workspacePath,
      ...relativePath.split("/"),
    );
    expect(await readFile(absolutePath, "utf8")).toBe(canonicalPack);

    await expect(
      manager.writeEvidencePackAtomic(
        agent.id,
        "session_1",
        "inventory",
        "assignment_1",
        '{"tampered":true}',
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(absolutePath, "utf8")).toBe(canonicalPack);

    await manager.writeEvidencePackAtomic(
      agent.id,
      "session_1",
      "inventory",
      "assignment_2",
      '{"assignment":{"runAssignmentId":"assignment_2"},"schemaVersion":1}',
    );
    const entries = await readdir(path.dirname(absolutePath));
    expect(entries.sort()).toEqual(["assignment_1.json", "assignment_2.json"]);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);

    const concurrent = await Promise.allSettled([
      manager.writeEvidencePackAtomic(
        agent.id,
        "session_1",
        "inventory",
        "assignment_3",
        '{"winner":"a"}',
      ),
      manager.writeEvidencePackAtomic(
        agent.id,
        "session_1",
        "inventory",
        "assignment_3",
        '{"winner":"b"}',
      ),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      [
        '{"winner":"a"}',
        '{"winner":"b"}',
      ],
    ).toContain(
      await readFile(
        path.join(path.dirname(absolutePath), "assignment_3.json"),
        "utf8",
      ),
    );
  });

  it("rejects path escape attempts before touching the filesystem", async () => {
    const { root, manager, agent } = await makeWorkspace();
    const attempts: Array<[string, string, string]> = [
      [agent.id, "../outside", "assignment_1"],
      [agent.id, "session_1", "../../outside"],
      ["../outside", "session_1", "assignment_1"],
      [agent.id, "C:escape", "assignment_1"],
      [agent.id, "session/escape", "assignment_1"],
      [agent.id, "session_1", "assignment\\escape"],
    ];

    for (const [agentId, sessionId, assignmentId] of attempts) {
      await expect(
        manager.writeEvidencePackAtomic(
          agentId,
          sessionId,
          "inventory",
          assignmentId,
          "{}",
        ),
      ).rejects.toThrow(/safe workspace path segment/);
    }
    await expect(
      manager.writeEvidencePackAtomic(
        agent.id,
        "session_1",
        "../outside" as never,
        "assignment_1",
        "{}",
      ),
    ).rejects.toThrow(/supported Evidence Pack path segment/);
    await expect(readFile(path.join(root, "outside.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("hashes the actual on-disk AGENTS.md and observes later edits", async () => {
    const { manager, agent } = await makeWorkspace();
    const agentsMdPath = path.join(agent.workspacePath, "AGENTS.md");
    const original = await readFile(agentsMdPath);
    const expectedOriginal = `sha256:${createHash("sha256")
      .update(original)
      .digest("hex")}`;
    expect(await manager.readAgentsMdDigest(agent.id)).toBe(expectedOriginal);

    const edited = "# Changed on disk\n\nThis must change the Role Profile digest.\n";
    await writeFile(agentsMdPath, edited, "utf8");
    const expectedEdited = `sha256:${createHash("sha256")
      .update(edited)
      .digest("hex")}`;
    expect(await manager.readAgentsMdDigest(agent.id)).toBe(expectedEdited);
    expect(expectedEdited).not.toBe(expectedOriginal);
  });

  it("rejects unsafe agent identifiers when reading AGENTS.md", async () => {
    const { manager } = await makeWorkspace();
    await expect(manager.readAgentsMdDigest("../agent_inventory")).rejects.toThrow(
      /safe workspace path segment/,
    );
  });
});
