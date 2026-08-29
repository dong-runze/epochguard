import { describe, expect, it } from "vitest";
import type { Agent, AgentRun, CreateAgentInput } from "../types.js";
import {
  ROLE_PROFILES,
  RoleProfileMismatchError,
  initializeRoleAgents,
  verifyRoleAgentProfile,
  type AgentPort,
  type RoleProfilePorts,
  type RunAdapterStoreState,
  type StorePort,
  type WorkspacePort,
} from "./role-profiles.js";
import {
  ROLES,
  RoleAgentRegistrationSchema,
  sha256Digest,
  type Role,
} from "./types.js";

class MemoryStore implements StorePort {
  state: RunAdapterStoreState = {
    roleAgentRegistrations: [],
    runAssignments: [],
    attempts: [],
  };

  snapshot(): RunAdapterStoreState {
    return structuredClone(this.state);
  }

  async mutate<T>(
    mutation: (database: RunAdapterStoreState) => T | Promise<T>,
  ): Promise<T> {
    const next = structuredClone(this.state);
    const result = await mutation(next);
    this.state = next;
    return result;
  }
}

class RoleAgentHarness implements AgentPort, WorkspacePort {
  readonly agents = new Map<string, Agent>();
  readonly digests = new Map<string, string>();
  readonly createInputs: CreateAgentInput[] = [];
  createFailureAt: number | null = null;
  fixedCreatedId: string | null = null;

  getAgent(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error("Agent not found");
    return structuredClone(agent);
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    this.createInputs.push(structuredClone(input));
    if (this.createFailureAt === this.createInputs.length) {
      throw new Error("controlled create failure");
    }
    const id = this.fixedCreatedId ?? `agent_role_${this.createInputs.length}`;
    const timestamp = "2026-08-29T12:00:00.000Z";
    const agent: Agent = {
      id,
      name: input.name,
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      status: "ready",
      workspacePath: `C:/controlled/${id}`,
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.agents.set(id, agent);
    this.digests.set(id, sha256Digest(`${id}\n${agent.instructions}`));
    return structuredClone(agent);
  }

  async sendMessage(): Promise<{ run: AgentRun }> {
    throw new Error("not used by Role Profile tests");
  }

  getRun(): AgentRun {
    throw new Error("not used by Role Profile tests");
  }

  async readAgentsMdDigest(agentId: string): Promise<string> {
    const digest = this.digests.get(agentId);
    if (!digest) throw new Error("AGENTS.md not found");
    return digest;
  }
}

function makePorts(): {
  ports: RoleProfilePorts;
  store: MemoryStore;
  harness: RoleAgentHarness;
} {
  const store = new MemoryStore();
  const harness = new RoleAgentHarness();
  return {
    ports: { agents: harness, store, workspaces: harness },
    store,
    harness,
  };
}

function expectationFor(
  role: Role,
  registration: ReturnType<typeof RoleAgentRegistrationSchema.parse>,
) {
  return {
    role,
    agentId: registration.agentId,
    agentName: registration.agentNameAtRegistration,
    roleProfileVersion: registration.roleProfileVersion,
    agentsMdDigest: registration.agentsMdDigest,
  } as const;
}

describe("EpochGuard Role Profiles", () => {
  it("initializes exactly three distinct dedicated Agents and is idempotent", async () => {
    const { ports, store, harness } = makePorts();
    const now = () => "2026-08-29T12:00:00.000Z";

    const [first, coalesced] = await Promise.all([
      initializeRoleAgents(ports, now),
      initializeRoleAgents(ports, now),
    ]);
    const repeated = await initializeRoleAgents(ports, now);

    expect(coalesced).toEqual(first);
    expect(repeated).toEqual(first);
    expect(harness.createInputs).toHaveLength(3);
    expect(store.state.roleAgentRegistrations).toHaveLength(3);
    expect(new Set(Object.values(first).map((item) => item.agentId)).size).toBe(3);
    expect(Object.keys(first)).toEqual(ROLES);

    for (const role of ROLES) {
      const registration = RoleAgentRegistrationSchema.parse(first[role]);
      expect(registration.roleProfileVersion).toBe(
        ROLE_PROFILES[role].roleProfileVersion,
      );
      expect(registration.agentsMdDigest).toBe(
        await harness.readAgentsMdDigest(registration.agentId),
      );
      expect(harness.getAgent(registration.agentId).name).toBe(
        ROLE_PROFILES[role].agentName,
      );
    }
  });

  it("resumes partial initialization without recreating registered Roles", async () => {
    const { ports, store, harness } = makePorts();
    harness.createFailureAt = 2;

    await expect(initializeRoleAgents(ports)).rejects.toThrow(
      "controlled create failure",
    );
    expect(store.state.roleAgentRegistrations.map((item) => item.role)).toEqual([
      "inventory",
    ]);

    harness.createFailureAt = null;
    const registrations = await initializeRoleAgents(ports);
    expect(harness.createInputs).toHaveLength(4);
    expect(registrations.inventory.agentId).toBe("agent_role_1");
    expect(new Set(Object.values(registrations).map((item) => item.agentId)).size).toBe(3);
  });

  it("does not take over a user Agent even when its name matches a Role", async () => {
    const { ports, harness } = makePorts();
    const userAgent: Agent = {
      id: "agent_user_inventory",
      name: ROLE_PROFILES.inventory.agentName,
      description: "user-owned",
      instructions: "unrelated chat instructions",
      status: "ready",
      workspacePath: "C:/controlled/agent_user_inventory",
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-29T11:00:00.000Z",
      updatedAt: "2026-08-29T11:00:00.000Z",
    };
    harness.agents.set(userAgent.id, userAgent);
    harness.digests.set(userAgent.id, sha256Digest(userAgent.instructions));

    const registrations = await initializeRoleAgents(ports);
    expect(registrations.inventory.agentId).not.toBe(userAgent.id);
    expect(harness.getAgent(userAgent.id)).toEqual(userAgent);
  });

  it("fails closed when the actual Profile changes after registration", async () => {
    const { ports, harness } = makePorts();
    const registrations = await initializeRoleAgents(ports);
    const registration = registrations.budget;

    harness.digests.set(
      registration.agentId,
      sha256Digest("mutated AGENTS.md"),
    );

    await expect(
      verifyRoleAgentProfile(expectationFor("budget", registration), ports),
    ).rejects.toMatchObject({
      name: "RoleProfileMismatchError",
      code: "ROLE_PROFILE_MISMATCH",
    });
    await expect(initializeRoleAgents(ports)).rejects.toBeInstanceOf(
      RoleProfileMismatchError,
    );
    expect(harness.createInputs).toHaveLength(3);
  });

  it("rejects one Agent identity reused by multiple Roles", async () => {
    const { ports, store, harness } = makePorts();
    harness.fixedCreatedId = "agent_reused";

    await expect(initializeRoleAgents(ports)).rejects.toBeInstanceOf(
      RoleProfileMismatchError,
    );
    expect(store.state.roleAgentRegistrations).toHaveLength(1);
    expect(store.state.roleAgentRegistrations[0]?.role).toBe("inventory");
  });
});
