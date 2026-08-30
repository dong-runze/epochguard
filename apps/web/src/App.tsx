import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { z } from "zod";
import {
  api,
  ApiError,
  epochGuardSessionSource,
  setAuthToken,
} from "./api";
import EpochGuardDashboard from "./epochguard/EpochGuardDashboard";
import {
  CONTRACT_DIGEST,
  CONTRACT_VERSION,
  OpaqueIdSchema,
  ScenarioIdSchema,
  type CreateSessionRequest,
  type Role,
  type SessionDashboardSnapshot,
} from "./epochguard/contracts";
import { decodeEpochGuardSnapshot } from "./epochguard/decode-snapshot";
import {
  EpochGuardSessionSourceError,
  type EpochGuardSessionSource,
} from "./epochguard/session-source";
import type { Agent, AgentRun, Message, SystemInfo } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

type WorkspaceMode = "chat" | "safety";
type ScenarioId = z.infer<typeof ScenarioIdSchema>;

const TERMINAL_SESSION_STATES = new Set<
  SessionDashboardSnapshot["sessionState"]
>([
  "UNSTABLE_WORLD",
  "CONSISTENT_DENY",
  "COMMIT_RACE",
  "COMMITTED",
  "FAILED",
  "INTERRUPTED",
]);

const ROLE_AGENT_NAMES: Readonly<Record<Role, string>> = {
  inventory: "EpochGuard Inventory Agent",
  budget: "EpochGuard Budget Agent",
  policy: "EpochGuard Policy Agent",
};

const ROLE_AGENT_INSPECTION: Readonly<
  Record<
    Role,
    {
      label: string;
      description: string;
      evidenceScope: string;
      profileVersion: string;
    }
  >
> = {
  inventory: {
    label: "Inventory",
    description: "Dedicated inventory evidence owner for EpochGuard demo sessions.",
    evidenceScope: "Inventory evidence and the requestedUnits projection only.",
    profileVersion: "epochguard-inventory-v1",
  },
  budget: {
    label: "Budget",
    description: "Dedicated budget evidence owner for EpochGuard demo sessions.",
    evidenceScope: "Budget evidence and the estimatedCostCents projection only.",
    profileVersion: "epochguard-budget-v1",
  },
  policy: {
    label: "Policy",
    description: "Dedicated policy evidence owner for EpochGuard demo sessions.",
    evidenceScope: "Policy evidence and the market projection only.",
    profileVersion: "epochguard-policy-v1",
  },
};

const SCENARIO_OPTIONS: ReadonlyArray<{
  id: ScenarioId;
  label: string;
  summary: string;
}> = [
  {
    id: "normal-world-v1",
    label: "Normal World",
    summary: "Three current ALLOW decisions can release one protected effect.",
  },
  {
    id: "impossible-collage-v1",
    label: "Impossible World",
    summary: "Three locally valid ALLOW decisions have no shared world revision.",
  },
];

const storedSessionSchema = z
  .object({
    storageVersion: z.literal(1),
    contractVersion: z.literal(CONTRACT_VERSION),
    contractDigest: z.literal(CONTRACT_DIGEST),
    scenarioId: ScenarioIdSchema,
    sessionId: OpaqueIdSchema,
  })
  .strict();

type RoleAssignments = CreateSessionRequest["assignments"];
type StoredSessionIds = Record<ScenarioId, string | null>;

function sessionStorageKey(scenarioId: ScenarioId): string {
  return `epochguard.session.v1.${scenarioId}`;
}

export function decodeStoredSessionId(
  raw: string | null,
  scenarioId: ScenarioId,
): string | null {
  if (raw === null) return null;
  try {
    const parsed = storedSessionSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.scenarioId === scenarioId
      ? parsed.data.sessionId
      : null;
  } catch {
    return null;
  }
}

function readStoredSession(scenarioId: ScenarioId): string | null {
  try {
    const raw = window.localStorage.getItem(sessionStorageKey(scenarioId));
    return decodeStoredSessionId(raw, scenarioId);
  } catch {
    return null;
  }
}

function persistStoredSession(
  scenarioId: ScenarioId,
  sessionId: string | null,
): void {
  try {
    const key = sessionStorageKey(scenarioId);
    if (sessionId === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(
      key,
      JSON.stringify({
        storageVersion: 1,
        contractVersion: CONTRACT_VERSION,
        contractDigest: CONTRACT_DIGEST,
        scenarioId,
        sessionId,
      }),
    );
  } catch {
    // Browser storage is only a resumability aid. Canonical state stays server-side.
  }
}

function removeStoredSessionIfMatches(
  scenarioId: ScenarioId,
  expectedSessionId: string,
): void {
  try {
    const key = sessionStorageKey(scenarioId);
    const raw = window.localStorage.getItem(key);
    if (decodeStoredSessionId(raw, scenarioId) === expectedSessionId) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage remains a best-effort hint and must never block the UI.
  }
}

function isDedicatedRoleAgent(agent: Agent | null): boolean {
  return (
    agent !== null &&
    Object.values(ROLE_AGENT_NAMES).includes(agent.name)
  );
}

function isProtectedRoleAgentId(agentId: string, agents: Agent[]): boolean {
  return agents.some(
    (agent) => agent.id === agentId && isDedicatedRoleAgent(agent),
  );
}

type AssignmentResolution =
  | {
      ok: true;
      assignments: RoleAssignments;
      agents: Record<Role, Agent>;
      issues: [];
    }
  | { ok: false; assignments: null; agents: null; issues: string[] };

function resolveRoleAssignments(agents: Agent[]): AssignmentResolution {
  const issues: string[] = [];
  const resolved = {} as Record<Role, Agent>;
  for (const role of Object.keys(ROLE_AGENT_NAMES) as Role[]) {
    const expectedName = ROLE_AGENT_NAMES[role];
    const matches = agents.filter((agent) => agent.name === expectedName);
    if (matches.length !== 1) {
      issues.push(
        matches.length === 0
          ? expectedName + " is missing."
          : expectedName + " appears " + matches.length + " times.",
      );
      continue;
    }
    resolved[role] = matches[0]!;
  }
  if (issues.length > 0 || Object.keys(resolved).length !== 3) {
    return { ok: false, assignments: null, agents: null, issues };
  }
  const assignments: RoleAssignments = {
    inventory: resolved.inventory.id,
    budget: resolved.budget.id,
    policy: resolved.policy.id,
  };
  if (new Set(Object.values(assignments)).size !== 3) {
    return {
      ok: false,
      assignments: null,
      agents: null,
      issues: ["Each EpochGuard Role must resolve to a distinct Agent ID."],
    };
  }
  return { ok: true, assignments, agents: resolved, issues: [] };
}

export function buildCreateSessionRequest(
  scenarioId: ScenarioId,
  assignments: RoleAssignments,
): CreateSessionRequest {
  return {
    scenarioId,
    assignments: {
      inventory: assignments.inventory,
      budget: assignments.budget,
      policy: assignments.policy,
    },
  };
}

export function requestEpochGuardSession(
  source: Pick<EpochGuardSessionSource, "createSession">,
  scenarioId: ScenarioId,
  assignments: RoleAssignments,
): Promise<unknown> {
  return source.createSession(
    buildCreateSessionRequest(scenarioId, assignments),
  );
}

export function SafetyRolePicker({
  agents,
  focusedRole,
  onFocus,
  disabled = false,
}: {
  agents: Agent[];
  focusedRole: Role;
  onFocus: (role: Role) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="safety-role-summary"
      role="group"
      aria-label="Protected Role Agents"
    >
      {(Object.keys(ROLE_AGENT_NAMES) as Role[]).map((role) => {
        const agent = agents.find(
          (candidate) => candidate.name === ROLE_AGENT_NAMES[role],
        );
        return (
          <button
            key={role}
            type="button"
            className="safety-role-card"
            aria-pressed={role === focusedRole}
            aria-controls="safety-role-inspection"
            disabled={disabled}
            onClick={() => onFocus(role)}
          >
            <span>{ROLE_AGENT_INSPECTION[role].label} Role</span>
            <strong>{ROLE_AGENT_NAMES[role]}</strong>
            <small>
              Lifecycle: {agent === undefined ? "not available" : agent.status}
            </small>
          </button>
        );
      })}
    </div>
  );
}

type SafetyOperationKind = "create" | "clear";

type SafetyPendingOperation = {
  kind: SafetyOperationKind;
  token: number;
} | null;

export type SubmittedInspectionFocus = {
  sessionId: string;
  agentId: string;
};

export function inspectionFocusForSessionAcquisition(
  acquisition:
    | { kind: "created"; sessionId: string; agentId: string }
    | { kind: "recovered"; sessionId: string },
): SubmittedInspectionFocus | null {
  return acquisition.kind === "created"
    ? { sessionId: acquisition.sessionId, agentId: acquisition.agentId }
    : null;
}

function snapshotAssignments(
  snapshot: SessionDashboardSnapshot,
): RoleAssignments {
  const byRole = Object.fromEntries(
    snapshot.agents.map((agent) => [agent.role, agent.agentId]),
  ) as Record<Role, string>;
  return {
    inventory: byRole.inventory,
    budget: byRole.budget,
    policy: byRole.policy,
  };
}

function sameAssignments(
  left: RoleAssignments,
  right: RoleAssignments,
): boolean {
  return (
    left.inventory === right.inventory &&
    left.budget === right.budget &&
    left.policy === right.policy
  );
}

function snapshotPreservesRoleAgents(
  snapshot: SessionDashboardSnapshot,
  agents: Record<Role, Agent>,
): boolean {
  return (Object.keys(ROLE_AGENT_NAMES) as Role[]).every((role) => {
    const frozen = snapshot.agents.find((agent) => agent.role === role);
    return (
      frozen !== undefined &&
      frozen.agentId === agents[role].id &&
      frozen.agentNameAtAssignment === agents[role].name
    );
  });
}

export type RuntimeReadiness = {
  ready: boolean;
  reason: string | null;
};

export function getRuntimeReadiness(system: SystemInfo | null): RuntimeReadiness {
  if (system === null) {
    return {
      ready: false,
      reason: "Checking the current server runtime configuration.",
    };
  }
  if (!system.arkConfigured) {
    return {
      ready: false,
      reason:
        "Configure ARK_API_KEY and ARK_MODEL in the current server environment, then restart the server.",
    };
  }
  if (!system.codexAvailable) {
    return {
      ready: false,
      reason:
        system.runtimeProvider === "container"
          ? "The configured container engine or Agent Runtime image is unavailable. Restore it, then restart the server."
          : "Codex CLI is unavailable in the local server process. Install @openai/codex, then restart the server.",
    };
  }
  return { ready: true, reason: null };
}

export function getRuntimeDisplayLabel(system: SystemInfo | null): string {
  if (system === null) return "Checking runtime…";
  return system.runtimeProvider === "container"
    ? "Local container · Codex CLI"
    : "Local process · Codex CLI";
}

export function SessionSafetyWorkspace({
  agents,
  runtimeReady,
  runtimeReadinessReason,
  scenarioId,
  onScenarioIdChange,
  sessionIds,
  setSessionIds,
  pendingOperation,
  beginOperation,
  finishOperation,
  initialFocusedRole = "inventory",
}: {
  agents: Agent[];
  runtimeReady: boolean;
  runtimeReadinessReason: string | null;
  scenarioId: ScenarioId;
  onScenarioIdChange: (scenarioId: ScenarioId) => void;
  sessionIds: StoredSessionIds;
  setSessionIds: Dispatch<SetStateAction<StoredSessionIds>>;
  pendingOperation: SafetyPendingOperation;
  beginOperation: (kind: SafetyOperationKind) => number | null;
  finishOperation: (token: number) => void;
  initialFocusedRole?: Role;
}) {
  const [createError, setCreateError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [focusedRole, setFocusedRole] = useState<Role>(initialFocusedRole);
  const [submittedFocus, setSubmittedFocus] =
    useState<SubmittedInspectionFocus | null>(null);
  const assignmentResolution = useMemo(
    () => resolveRoleAssignments(agents),
    [agents],
  );
  const selectedScenario = SCENARIO_OPTIONS.find(
    (scenario) => scenario.id === scenarioId,
  )!;
  const sessionId = sessionIds[scenarioId];
  const creating = pendingOperation?.kind === "create";
  const clearing = pendingOperation?.kind === "clear";
  const operationPending = pendingOperation !== null;
  const nonReadyRoleAgents = assignmentResolution.ok
    ? (Object.keys(ROLE_AGENT_NAMES) as Role[]).filter(
        (role) => assignmentResolution.agents[role].status !== "ready",
      )
    : [];
  const focusedAgent = agents.find(
    (candidate) => candidate.name === ROLE_AGENT_NAMES[focusedRole],
  );
  const focusedProfile = ROLE_AGENT_INSPECTION[focusedRole];
  const focusedDescription =
    focusedAgent !== undefined && focusedAgent.description.trim().length > 0
      ? focusedAgent.description
      : focusedProfile.description;

  const createSession = async () => {
    if (!runtimeReady) {
      setCreateError(
        runtimeReadinessReason ?? "The current server runtime is not ready.",
      );
      return;
    }
    if (!assignmentResolution.ok) return;
    const operationToken = beginOperation("create");
    if (operationToken === null) return;
    const requestedScenarioId = scenarioId;
    const requestedResolution = assignmentResolution;
    const requestedFocusedAgentId = requestedResolution.agents[focusedRole].id;
    setCreateError(null);
    setRecoveryNotice(null);
    try {
      const payload = await requestEpochGuardSession(
        epochGuardSessionSource,
        requestedScenarioId,
        requestedResolution.assignments,
      );
      const decoded = decodeEpochGuardSnapshot(payload);
      if (!decoded.ok) {
        throw new Error(decoded.failure.message);
      }
      if (decoded.snapshot.scenarioId !== requestedScenarioId) {
        throw new Error("The created Session belongs to a different scenario.");
      }
      if (
        !sameAssignments(
          snapshotAssignments(decoded.snapshot),
          requestedResolution.assignments,
        ) ||
        !snapshotPreservesRoleAgents(
          decoded.snapshot,
          requestedResolution.agents,
        )
      ) {
        throw new Error(
          "The created Session Snapshot does not preserve the requested Role assignments.",
        );
      }
      setSessionIds((current) => ({
        ...current,
        [requestedScenarioId]: decoded.snapshot.sessionId,
      }));
      setSubmittedFocus(
        inspectionFocusForSessionAcquisition({
          kind: "created",
          sessionId: decoded.snapshot.sessionId,
          agentId: requestedFocusedAgentId,
        }),
      );
      onScenarioIdChange(requestedScenarioId);
      persistStoredSession(requestedScenarioId, decoded.snapshot.sessionId);
    } catch (reason) {
      if (reason instanceof EpochGuardSessionSourceError) {
        const body = reason.body;
        let recovered = false;
        if (
          body?.error === "AGENTS_BUSY" &&
          sameAssignments(body.assignments, requestedResolution.assignments)
        ) {
          try {
            const activePayload = await epochGuardSessionSource.getSession(
              body.activeSessionId,
            );
            const active = decodeEpochGuardSnapshot(activePayload);
            if (
              active.ok &&
              active.snapshot.sessionId === body.activeSessionId &&
              sameAssignments(
                snapshotAssignments(active.snapshot),
                requestedResolution.assignments,
              ) &&
              snapshotPreservesRoleAgents(
                active.snapshot,
                requestedResolution.agents,
              )
            ) {
              const activeScenarioId = active.snapshot.scenarioId;
              setSessionIds((current) => ({
                ...current,
                [activeScenarioId]: body.activeSessionId,
              }));
              setSubmittedFocus(
                inspectionFocusForSessionAcquisition({
                  kind: "recovered",
                  sessionId: body.activeSessionId,
                }),
              );
              onScenarioIdChange(activeScenarioId);
              persistStoredSession(activeScenarioId, body.activeSessionId);
              setCreateError(null);
              setRecoveryNotice(
                "Recovered the active " +
                  (activeScenarioId === "normal-world-v1"
                    ? "Normal"
                    : "Impossible") +
                  " Session.",
              );
              recovered = true;
            }
          } catch {
            // Keep the canonical AGENTS_BUSY error if recovery cannot be verified.
          }
        }
        if (!recovered) setCreateError(reason.message);
      } else {
        setCreateError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      finishOperation(operationToken);
    }
  };

  const clearSavedSession = async () => {
    if (sessionId === null) return;
    const operationToken = beginOperation("clear");
    if (operationToken === null) return;
    const expectedSessionId = sessionId;
    const expectedScenarioId = scenarioId;
    setCreateError(null);
    setRecoveryNotice(null);
    try {
      const payload = await epochGuardSessionSource.getSession(expectedSessionId);
      const decoded = decodeEpochGuardSnapshot(payload);
      if (
        !decoded.ok ||
        decoded.snapshot.sessionId !== expectedSessionId ||
        decoded.snapshot.scenarioId !== expectedScenarioId
      ) {
        throw new Error("The saved Session could not be verified safely.");
      }
      if (!TERMINAL_SESSION_STATES.has(decoded.snapshot.sessionState)) {
        setCreateError(
          "This Session is still active. Keep observing it until it reaches a terminal state.",
        );
        return;
      }
      setSessionIds((current) =>
        current[expectedScenarioId] === expectedSessionId
          ? { ...current, [expectedScenarioId]: null }
          : current,
      );
      setSubmittedFocus((current) =>
        current?.sessionId === expectedSessionId ? null : current,
      );
      removeStoredSessionIfMatches(expectedScenarioId, expectedSessionId);
    } catch (reason) {
      if (
        reason instanceof EpochGuardSessionSourceError &&
        reason.status === 404 &&
        reason.body?.error === "SESSION_NOT_FOUND" &&
        reason.body.sessionId === expectedSessionId
      ) {
        setSessionIds((current) =>
          current[expectedScenarioId] === expectedSessionId
            ? { ...current, [expectedScenarioId]: null }
            : current,
        );
        setSubmittedFocus((current) =>
          current?.sessionId === expectedSessionId ? null : current,
        );
        removeStoredSessionIfMatches(expectedScenarioId, expectedSessionId);
        return;
      }
      setCreateError(
        reason instanceof EpochGuardSessionSourceError
          ? reason.message
          : reason instanceof Error
            ? reason.message
            : String(reason),
      );
    } finally {
      finishOperation(operationToken);
    }
  };

  return (
    <div className="safety-workspace">
      <div className="safety-scenario-bar">
        <div className="safety-scenario-tabs" aria-label="EpochGuard scenario">
          {SCENARIO_OPTIONS.map((scenario) => (
            <button
              key={scenario.id}
              type="button"
              aria-pressed={scenario.id === scenarioId}
              disabled={operationPending}
              onClick={() => {
                onScenarioIdChange(scenario.id);
                setCreateError(null);
                setRecoveryNotice(null);
              }}
            >
              {scenario.label}
              {sessionIds[scenario.id] !== null ? <span>Saved</span> : null}
            </button>
          ))}
        </div>
        {sessionId !== null ? (
          <button
            type="button"
            className="button button-ghost safety-new-session"
            disabled={operationPending}
            onClick={() => void clearSavedSession()}
          >
            {clearing ? <Spinner /> : "Clear saved session"}
          </button>
        ) : null}
      </div>

      {createError !== null ? (
        <div className="safety-create-error" role="alert">
          {createError}
        </div>
      ) : null}

      {recoveryNotice !== null ? (
        <div className="safety-recovery-notice" role="status" aria-live="polite">
          {recoveryNotice}
        </div>
      ) : null}

      {sessionId === null ? (
        <section className="safety-launcher">
          <div className="safety-launcher-copy">
            <span className="eyebrow">Fixed, server-verified fixture</span>
            <h3>{selectedScenario.label}</h3>
            <p>{selectedScenario.summary}</p>
          </div>
          <SafetyRolePicker
            agents={agents}
            focusedRole={focusedRole}
            onFocus={setFocusedRole}
            disabled={operationPending}
          />
          <section
            id="safety-role-inspection"
            className="safety-role-inspection"
            aria-label={`${focusedProfile.label} Role Agent inspection`}
            aria-live="polite"
          >
            <div className="safety-role-inspection-copy">
              <span className="eyebrow">Read-only Agent inspection</span>
              <h4>{ROLE_AGENT_NAMES[focusedRole]}</h4>
              <p>{focusedDescription}</p>
            </div>
            <dl>
              <div>
                <dt>Role</dt>
                <dd>{focusedProfile.label}</dd>
              </div>
              <div>
                <dt>Lifecycle</dt>
                <dd>{focusedAgent === undefined ? "Not available" : focusedAgent.status}</dd>
              </div>
              <div>
                <dt>Agent ID</dt>
                <dd title={focusedAgent?.id}>
                  {focusedAgent === undefined ? "Not available" : focusedAgent.id}
                </dd>
              </div>
              <div>
                <dt>Expected profile</dt>
                <dd>{focusedProfile.profileVersion}</dd>
              </div>
              <div>
                <dt>Evidence scope</dt>
                <dd>{focusedProfile.evidenceScope}</dd>
              </div>
            </dl>
          </section>
          {!assignmentResolution.ok ? (
            <div className="safety-setup-error" role="status">
              <strong>Role setup is not ready</strong>
              <ul>
                {assignmentResolution.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!runtimeReady ? (
            <div className="safety-setup-error" role="status">
              <strong>Runtime is not ready</strong>
              <span>
                {runtimeReadinessReason ?? "The current server runtime is unavailable."}
              </span>
            </div>
          ) : null}
          {assignmentResolution.ok && nonReadyRoleAgents.length > 0 ? (
            <div className="safety-readiness-note" role="status">
              <strong>Role status is advisory</strong>
              <span>
                {nonReadyRoleAgents.length === 1
                  ? "One Role Agent is not currently ready. "
                  : String(nonReadyRoleAgents.length) +
                    " Role Agents are not currently ready. "}
                Run stays available so the server can restore an active Session or return
                the authoritative result.
              </span>
            </div>
          ) : null}
          <button
            type="button"
            className="button button-primary safety-run-button"
            disabled={!runtimeReady || !assignmentResolution.ok || operationPending}
            onClick={() => void createSession()}
          >
            {creating ? <Spinner /> : `Run ${selectedScenario.label}`}
          </button>
          <p className="safety-trust-note">
            Role focus changes this read-only inspection only. Assignments remain resolved
            by exact Role Agent name; the browser cannot select owners, change assignment
            order, or choose world heads, Receipts, Permits, and effect values. After the
            Run, the authoritative frozen profile appears in Run-bound evidence.
          </p>
        </section>
      ) : (
        <EpochGuardDashboard
          key={sessionId}
          source={epochGuardSessionSource}
          sessionId={sessionId}
          focusedAgentId={
            submittedFocus?.sessionId === sessionId
              ? submittedFocus.agentId
              : null
          }
        />
      )}
    </div>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("chat");
  const [safetyScenarioId, setSafetyScenarioId] =
    useState<ScenarioId>("normal-world-v1");
  const [safetySessionIds, setSafetySessionIds] = useState<StoredSessionIds>(
    () => ({
      "normal-world-v1": readStoredSession("normal-world-v1"),
      "impossible-collage-v1": readStoredSession("impossible-collage-v1"),
    }),
  );
  const [safetyPendingOperation, setSafetyPendingOperation] =
    useState<SafetyPendingOperation>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const runtimeReadiness = getRuntimeReadiness(system);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const safetyPendingOperationRef = useRef<SafetyPendingOperation>(null);
  const safetyOperationTokenRef = useRef(0);
  selectedIdRef.current = selectedId;

  const beginSafetyOperation = useCallback(
    (kind: SafetyOperationKind): number | null => {
      if (safetyPendingOperationRef.current !== null) return null;
      const operation = {
        kind,
        token: safetyOperationTokenRef.current + 1,
      };
      safetyOperationTokenRef.current = operation.token;
      safetyPendingOperationRef.current = operation;
      setSafetyPendingOperation(operation);
      return operation.token;
    },
    [],
  );

  const finishSafetyOperation = useCallback((token: number) => {
    if (safetyPendingOperationRef.current?.token !== token) return;
    safetyPendingOperationRef.current = null;
    setSafetyPendingOperation((current) =>
      current?.token === token ? null : current,
    );
  }, []);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const chatAgents = useMemo(
    () => agents.filter((agent) => !isDedicatedRoleAgent(agent)),
    [agents],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    const selectable = next.filter((agent) => !isDedicatedRoleAgent(agent));
    setSelectedId((current) =>
      current && selectable.some((agent) => agent.id === current)
        ? current
        : (selectable[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    if (isProtectedRoleAgentId(selected.id, agents)) {
      setError("EpochGuard Role Agents are managed by the safety control plane.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    if (isProtectedRoleAgentId(selected.id, agents)) {
      setError("EpochGuard Role Agents cannot be started or stopped from Agent Chat.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (isProtectedRoleAgentId(selected.id, agents)) {
      setError("EpochGuard Role Agents cannot be deleted from Agent Chat.");
      return;
    }
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    if (isProtectedRoleAgentId(selected.id, agents)) {
      setError("EpochGuard Role Agents only accept assignment-scoped safety Runs.");
      return;
    }
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>{getRuntimeDisplayLabel(system)}</span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{chatAgents.length}</span>
        </div>
        <nav className="agent-list">
          {chatAgents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {chatAgents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        <nav className="global-workspace-mode" aria-label="Workspace mode">
          <button
            type="button"
            aria-pressed={workspaceMode === "chat"}
            disabled={safetyPendingOperation !== null}
            onClick={() => {
              if (safetyPendingOperationRef.current !== null) return;
              setWorkspaceMode("chat");
            }}
          >
            Agent Chat
          </button>
          <button
            type="button"
            aria-pressed={workspaceMode === "safety"}
            disabled={safetyPendingOperation !== null}
            onClick={() => {
              if (safetyPendingOperationRef.current !== null) return;
              setShowSettings(false);
              setWorkspaceMode("safety");
            }}
          >
            Session Safety
          </button>
        </nav>

        {system !== null && !runtimeReadiness.ready ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {runtimeReadiness.reason}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {workspaceMode === "safety" || selected !== null ? (
          <>
            <header className="agent-header">
              {workspaceMode === "safety" ? (
                <div>
                  <div className="header-title-row">
                    <h1>EpochGuard</h1>
                    <span className="safety-header-pill">Joint-validity gate</span>
                  </div>
                  <p>Server-authoritative Session Safety for two isolated demo worlds.</p>
                </div>
              ) : selected !== null ? (
                <>
                  <div>
                    <div className="header-title-row">
                      <h1>{selected.name}</h1>
                      <StatusPill status={selected.status} />
                    </div>
                    <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
                  </div>
                  <div className="header-actions">
                    <button
                      className="button button-ghost"
                      onClick={() => setShowSettings((value) => !value)}
                      disabled={busy || selected.status === "busy"}
                    >
                      Settings
                    </button>
                    <button
                      className="button button-ghost"
                      onClick={toggleAgent}
                      disabled={busy}
                    >
                      {selected.status === "stopped" ? "Start" : "Stop"}
                    </button>
                    <button
                      className="button button-danger"
                      onClick={deleteAgent}
                      disabled={busy || selected.status === "busy"}
                    >
                      Delete
                    </button>
                  </div>
                </>
              ) : null}
            </header>

            {workspaceMode === "chat" && selected !== null && showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className={`playground playground-${workspaceMode}`}>
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>
                    {workspaceMode === "chat"
                      ? "Build something with your Agent"
                      : "Inspect and operate one protected Session"}
                  </h2>
                </div>
                {workspaceMode === "chat" && selected !== null ? (
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                ) : null}
              </div>

              {workspaceMode === "safety" ? (
                <SessionSafetyWorkspace
                  agents={agents}
                  runtimeReady={runtimeReadiness.ready}
                  runtimeReadinessReason={runtimeReadiness.reason}
                  scenarioId={safetyScenarioId}
                  onScenarioIdChange={setSafetyScenarioId}
                  sessionIds={safetySessionIds}
                  setSessionIds={setSafetySessionIds}
                  pendingOperation={safetyPendingOperation}
                  beginOperation={beginSafetyOperation}
                  finishOperation={finishSafetyOperation}
                />
              ) : selected !== null ? (
                <>
                  <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
                  </div>

                  <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
                  </form>
                </>
              ) : null}
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
