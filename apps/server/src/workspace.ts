import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
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
    const managedSegments = [".epochguard", "sessions", sessionId, role];
    let canonicalDestinationDirectory = workspace;
    for (const segment of managedSegments) {
      canonicalDestinationDirectory = await this.ensureExactDirectory(
        canonicalDestinationDirectory,
        segment,
        true,
      );
    }

    // Revalidate the entire chain immediately before publishing. Portable Node
    // APIs do not expose openat(2)+O_NOFOLLOW for a whole path, so an
    // administrator or a same-user malicious process can still swap a
    // component between the final check and the write/link. Creating one level
    // at a time and resolving every component before each filesystem effect
    // closes the static junction/symlink boundary and materially narrows that
    // unavoidable local-filesystem TOCTOU window.
    canonicalDestinationDirectory = await this.verifyManagedDirectoryChain(
      agentId,
      managedSegments,
    );

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
      await this.assertExactRegularFile(temporary);
      const revalidatedDestination = await this.verifyManagedDirectoryChain(
        agentId,
        managedSegments,
      );
      if (!this.pathsEqual(canonicalDestinationDirectory, revalidatedDestination)) {
        throw new Error("Evidence Pack directory identity changed during write");
      }
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
    const agentsMdPath = path.join(workspace, "AGENTS.md");
    await this.assertExactRegularFile(agentsMdPath);
    const bytes = await readFile(agentsMdPath);
    await this.assertExactRegularFile(agentsMdPath);
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

  private pathsEqual(left: string, right: string): boolean {
    return path.relative(left, right) === "";
  }

  private async assertExactRegularFile(expectedPath: string): Promise<void> {
    const information = await lstat(expectedPath);
    if (!information.isFile() || information.isSymbolicLink()) {
      throw new Error("Managed file is not an exact regular file");
    }
    const resolved = await realpath(expectedPath);
    if (!this.pathsEqual(expectedPath, resolved)) {
      throw new Error("Managed file resolves outside its exact path");
    }
  }

  private async ensureExactDirectory(
    canonicalParent: string,
    segment: string,
    createIfMissing: boolean,
  ): Promise<string> {
    const expected = path.join(canonicalParent, segment);
    let information;
    try {
      information = await lstat(expected);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!createIfMissing || code !== "ENOENT") {
        throw error;
      }
      try {
        await mkdir(expected, { recursive: false });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
      information = await lstat(expected);
    }

    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("Managed directory is not an exact directory");
    }
    const resolved = await realpath(expected);
    if (!this.pathsEqual(expected, resolved)) {
      throw new Error("Managed directory resolves outside its exact path");
    }
    return resolved;
  }

  private async verifyManagedDirectoryChain(
    agentId: string,
    segments: readonly string[],
  ): Promise<string> {
    let current = await this.canonicalWorkspace(agentId);
    for (const segment of segments) {
      current = await this.ensureExactDirectory(current, segment, false);
    }
    return current;
  }

  private async canonicalWorkspace(agentId: string): Promise<string> {
    const canonicalRoot = await realpath(this.root);
    const expectedWorkspace = path.join(canonicalRoot, agentId);
    const information = await lstat(expectedWorkspace);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("Agent workspace is not an exact directory");
    }
    const canonicalWorkspace = await realpath(expectedWorkspace);
    if (!this.pathsEqual(expectedWorkspace, canonicalWorkspace)) {
      throw new Error("Agent workspace does not match its canonical Agent identity");
    }
    return canonicalWorkspace;
  }
}
