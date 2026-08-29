import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export type EvidencePackRole = "inventory" | "budget" | "policy";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  /**
   * Writes one immutable, assignment-scoped canonical Evidence Pack. The hard
   * link publishes the fully written temporary file without replacing an
   * existing assignment Pack.
   */
  async writeEvidencePackAtomic(
    agentId: string,
    sessionId: string,
    role: EvidencePackRole,
    assignmentId: string,
    canonicalPack: string | Uint8Array,
  ): Promise<string> {
    this.assertSafeSegment("agentId", agentId);
    this.assertSafeSegment("sessionId", sessionId);
    this.assertSafeSegment("assignmentId", assignmentId);
    if (!(["inventory", "budget", "policy"] as const).includes(role)) {
      throw new Error("role is not a supported Evidence Pack path segment");
    }

    const workspace = await this.canonicalWorkspace(agentId);
    const destinationDirectory = path.join(
      workspace,
      ".epochguard",
      "sessions",
      sessionId,
      role,
    );
    await mkdir(destinationDirectory, { recursive: true });

    // Resolve after mkdir so a pre-existing symlink/junction in any path
    // component cannot redirect the write outside the Agent workspace.
    const canonicalDestinationDirectory = await realpath(destinationDirectory);
    this.assertInside(workspace, canonicalDestinationDirectory);

    const destination = path.join(
      canonicalDestinationDirectory,
      `${assignmentId}.json`,
    );
    const temporary = path.join(
      canonicalDestinationDirectory,
      `.${assignmentId}.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(temporary, canonicalPack, { flag: "wx", mode: 0o600 });
      await link(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }

    return path.posix.join(
      ".epochguard",
      "sessions",
      sessionId,
      role,
      `${assignmentId}.json`,
    );
  }

  /** Reads and hashes the actual on-disk AGENTS.md used by the Runtime. */
  async readAgentsMdDigest(agentId: string): Promise<string> {
    this.assertSafeSegment("agentId", agentId);
    const workspace = await this.canonicalWorkspace(agentId);
    const agentsMdPath = await realpath(path.join(workspace, "AGENTS.md"));
    this.assertInside(workspace, agentsMdPath);
    const bytes = await readFile(agentsMdPath);
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }

  private assertSafeSegment(label: string, value: string): void {
    if (
      value === "." ||
      value === ".." ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    ) {
      throw new Error(`${label} is not a safe workspace path segment`);
    }
  }

  private assertInside(parent: string, candidate: string): void {
    const relative = path.relative(parent, candidate);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Workspace path escapes the Agent workspace");
    }
  }

  private async canonicalWorkspace(agentId: string): Promise<string> {
    const canonicalRoot = await realpath(this.root);
    const canonicalWorkspace = await realpath(this.workspacePath(agentId));
    this.assertInside(canonicalRoot, canonicalWorkspace);
    return canonicalWorkspace;
  }
}
