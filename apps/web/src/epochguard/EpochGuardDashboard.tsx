import { useEffect, useState } from "react";
import type { SessionDashboardSnapshot } from "./contracts";
import type { EpochGuardSessionSource } from "./session-source";
import { useEpochGuardSession } from "./useEpochGuardSession";
import "./EpochGuardDashboard.css";

const ROLE_LABELS = {
  inventory: "Inventory",
  budget: "Budget",
  policy: "Policy",
} as const;

const GATE_ICONS = {
  WAITING: "◌",
  CHECKING: "◐",
  LOCKED: "⛔",
  READY: "◇",
  RELEASED: "✓",
  FAILED: "!",
} as const;

const GATE_COPY = {
  WAITING: "Waiting for evidence",
  CHECKING: "Checking current evidence",
  LOCKED: "Protected effect locked",
  READY: "Ready for protected commit",
  RELEASED: "Protected effect released",
  FAILED: "Gate failed closed",
} as const;

const JOINT_VALIDITY_COPY = {
  PENDING: "Pending validation",
  VALID_CURRENT: "Valid at current head",
  NO_CUT: "No valid observed-world cut",
  HISTORICAL_STALE: "Historical cut is stale now",
} as const;

const EVIDENCE_COPY = {
  CURRENT: "Current",
  RETAINED: "Retained · still current",
  INVALID_AT_HEAD: "Invalid at current head",
} as const;

const REQUIRED_RUNTIME_RUNS = 3;

type ActiveDecision = NonNullable<
  SessionDashboardSnapshot["agents"][number]["activeDecision"]
>;
type DemoTone = "success" | "blocked" | "active" | "waiting";
type UsageField =
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens";

function summarizeUsage(
  decisions: readonly ActiveDecision[],
  field: UsageField,
): { total: number; reported: number } {
  const reportedValues = decisions.flatMap((decision) => {
    const value = decision.runtimeProof.usage?.[field];
    return value === undefined ? [] : [value];
  });
  return {
    total: reportedValues.reduce((total, value) => total + value, 0),
    reported: reportedValues.length,
  };
}

function formatUsageTotal(summary: { total: number; reported: number }): string {
  return summary.reported === 0
    ? "—"
    : new Intl.NumberFormat("en-US").format(summary.total);
}

function formatOverlapDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 3,
  }).format(milliseconds / 1_000)} s`;
}

function activeOverlapLabel(
  snapshot: SessionDashboardSnapshot,
  decisions: readonly ActiveDecision[],
): string {
  if (decisions.length !== REQUIRED_RUNTIME_RUNS) return "pending";

  const intervals = decisions.flatMap((decision) => {
    const { runStartedAt, runCompletedAt } = decision.runtimeProof;
    if (runStartedAt === null || runCompletedAt === null) return [];
    const start = Date.parse(runStartedAt);
    const end = Date.parse(runCompletedAt);
    return Number.isFinite(start) && Number.isFinite(end)
      ? [{ start, end }]
      : [];
  });
  if (intervals.length !== REQUIRED_RUNTIME_RUNS) return "unavailable";

  const latestStart = Math.max(...intervals.map(({ start }) => start));
  const earliestEnd = Math.min(...intervals.map(({ end }) => end));
  const overlapMilliseconds = earliestEnd - latestStart;
  if (overlapMilliseconds > 0) {
    return `shared active overlap ${formatOverlapDuration(overlapMilliseconds)}`;
  }

  const selectiveRefreshHasStarted =
    snapshot.refreshPlan !== null && snapshot.refreshPlan.status !== "AVAILABLE";
  return selectiveRefreshHasStarted
    ? "active overlap unavailable after refresh"
    : "active overlap unavailable";
}

export interface EpochGuardDashboardProps {
  source: EpochGuardSessionSource;
  sessionId: string;
  focusedAgentId?: string | null;
  pollIntervalMs?: number;
  staleAfterMs?: number;
}

function humanize(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortId(value: string | null, length = 16): string {
  if (value === null) return "—";
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-SG", {
    style: "currency",
    currency: "SGD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function intervalLabel(receipt: {
  validFromSeq: number;
  validUntilSeq: number | null;
}): string {
  return `[v${receipt.validFromSeq}, ${
    receipt.validUntilSeq === null ? "∞" : `v${receipt.validUntilSeq}`
  })`;
}

function decisionIcon(verdict: "ALLOW" | "DENY"): string {
  return verdict === "ALLOW" ? "✓" : "—";
}

function freshnessMessage(
  snapshot: SessionDashboardSnapshot,
  isStale: boolean,
): string {
  if (isStale) return "View stale. All actions are disabled.";
  if (snapshot.sessionState === "CONSISTENT_DENY") {
    return "Resolved safely. The protected effect was not released.";
  }
  return `${GATE_COPY[snapshot.gate.state]}. Effects in this session: ${snapshot.gate.effectsInSession}.`;
}

function agentDemoStage(
  agent: SessionDashboardSnapshot["agents"][number],
): { state: string; detail: string; tone: DemoTone } {
  const decision = agent.activeDecision;
  if (decision !== null) {
    if (agent.inFlightAttempt !== null) {
      const status = agent.inFlightAttempt.status;
      const terminalFailure =
        status === "FAILED" ||
        status === "INTERRUPTED" ||
        status === "OUTPUT_REJECTED";
      return {
        state: decision.verdict,
        detail: terminalFailure
          ? `Refresh ${humanize(status)} · retained ${intervalLabel(decision.receipt)}`
          : `Re-observing · retained ${intervalLabel(decision.receipt)}`,
        tone:
          terminalFailure || decision.verdict === "DENY" ? "blocked" : "active",
      };
    }
    return {
      state: decision.verdict,
      detail: `Receipt ${intervalLabel(decision.receipt)}`,
      tone: decision.verdict === "ALLOW" ? "success" : "blocked",
    };
  }
  if (agent.inFlightAttempt !== null) {
    const status = agent.inFlightAttempt.status;
    if (
      status === "FAILED" ||
      status === "INTERRUPTED" ||
      status === "OUTPUT_REJECTED"
    ) {
      return {
        state:
          status === "OUTPUT_REJECTED"
            ? "OUTPUT REJECTED"
            : status === "INTERRUPTED"
              ? "RUN INTERRUPTED"
              : "RUN FAILED",
        detail: "No Decision accepted · gate stays closed",
        tone: "blocked",
      };
    }
    return {
      state: "RUNNING",
      detail: humanize(status),
      tone: "active",
    };
  }
  return { state: "WAITING", detail: "No accepted Decision", tone: "waiting" };
}

function gateDemoStage(
  snapshot: SessionDashboardSnapshot,
): { state: string; detail: string; tone: DemoTone } {
  if (snapshot.jointValidity.state === "VALID_CURRENT") {
    return {
      state: "ONE SHARED WORLD",
      detail: `${snapshot.jointValidity.lowerBound} ≤ v${snapshot.worldHead} < ${snapshot.jointValidity.upperBound}`,
      tone: "success",
    };
  }
  if (snapshot.jointValidity.state === "NO_CUT") {
    return {
      state: "NO SHARED WORLD",
      detail: `L ${snapshot.jointValidity.lowerBound} ≥ U ${snapshot.jointValidity.upperBound}`,
      tone: "blocked",
    };
  }
  if (snapshot.jointValidity.state === "HISTORICAL_STALE") {
    return {
      state: "STALE WORLD",
      detail: `Evidence no longer covers head v${snapshot.worldHead}`,
      tone: "blocked",
    };
  }
  return {
    state: snapshot.gate.state === "CHECKING" ? "CHECKING" : "WAITING",
    detail: `${snapshot.metrics.activeDecisions}/3 Decisions collected`,
    tone: snapshot.gate.state === "CHECKING" ? "active" : "waiting",
  };
}

function effectDemoStage(
  snapshot: SessionDashboardSnapshot,
): { state: string; detail: string; tone: DemoTone } {
  if (snapshot.gate.state === "RELEASED") {
    return {
      state: "RELEASED",
      detail: `${snapshot.gate.effectsInSession} effect · exactly once`,
      tone: "success",
    };
  }
  if (snapshot.gate.state === "READY") {
    return {
      state: "READY",
      detail: "Permit issued · awaiting commit",
      tone: "active",
    };
  }
  if (snapshot.gate.state === "FAILED") {
    return {
      state: "FAIL-CLOSED",
      detail: `${snapshot.gate.effectsInSession} effects released`,
      tone: "blocked",
    };
  }
  if (snapshot.gate.state === "LOCKED") {
    return {
      state: "LOCKED",
      detail: `${snapshot.gate.effectsInSession} effects released`,
      tone: "blocked",
    };
  }
  return {
    state: snapshot.gate.state,
    detail: `${snapshot.gate.effectsInSession} effects released`,
    tone: snapshot.gate.state === "CHECKING" ? "active" : "waiting",
  };
}

function demoStory(snapshot: SessionDashboardSnapshot): {
  headline: string;
  tone: DemoTone;
} {
  if (snapshot.gate.state === "RELEASED") {
    return {
      headline: "3 Agents agree in the same world → RELEASE exactly once",
      tone: "success",
    };
  }
  if (snapshot.jointValidity.state === "NO_CUT") {
    return {
      headline:
        snapshot.metrics.allowDecisions === 3
          ? "3 Agents say ALLOW, but not in the same world → BLOCK"
          : "3 Decisions, but no shared world → BLOCK",
      tone: "blocked",
    };
  }
  if (snapshot.gate.state === "FAILED") {
    return {
      headline: "Runtime failure → FAIL CLOSED · protected effect stays at zero",
      tone: "blocked",
    };
  }
  if (snapshot.metrics.denyDecisions > 0) {
    return {
      headline: "A Role Agent says DENY → protected effect stays locked",
      tone: "blocked",
    };
  }
  if (snapshot.coordinationMode === "SEQUENTIAL_FALLBACK") {
    return {
      headline: "3 Role Agents run sequentially → EpochGuard checks one shared world",
      tone: snapshot.metrics.activeDecisions > 0 ? "active" : "waiting",
    };
  }
  if (snapshot.coordinationMode === "PENDING") {
    return {
      headline: "3 Role Agents are starting → EpochGuard waits for one shared world",
      tone: "waiting",
    };
  }
  return {
    headline: "3 Role Agents run in parallel → EpochGuard checks one shared world",
    tone: snapshot.metrics.activeDecisions > 0 ? "active" : "waiting",
  };
}

export function AgentDecisionFlow({
  snapshot,
}: {
  snapshot: SessionDashboardSnapshot;
}) {
  const [replayStep, setReplayStep] = useState<number | null>(null);
  const story = demoStory(snapshot);
  const gate = gateDemoStage(snapshot);
  const effect = effectDemoStage(snapshot);
  const stages = [
    ...snapshot.agents.map((agent, index) => ({
      number: index + 1,
      kind: "ROLE AGENT",
      label: `${ROLE_LABELS[agent.role]} Agent`,
      ...agentDemoStage(agent),
    })),
    {
      number: 4,
      kind: "MIDDLEWARE",
      label: "EpochGuard Gate",
      ...gate,
    },
    {
      number: 5,
      kind: "PROTECTED OUTPUT",
      label: "Campaign Effect",
      ...effect,
    },
  ];
  const replaying = replayStep !== null;
  const displayedStages = stages.map((stage, index) =>
    !replaying || index < replayStep
      ? stage
      : {
          ...stage,
          state: "WAITING",
          detail: "Saved evidence queued",
          tone: "waiting" as const,
        },
  );

  useEffect(() => {
    if (replayStep === null || replayStep >= stages.length) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setReplayStep((step) => (step === null ? null : step + 1));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [replayStep, stages.length]);

  useEffect(() => {
    setReplayStep(null);
  }, [snapshot.sessionId]);

  return (
    <section
      className={`eg-demo-flow eg-demo-flow-${story.tone}`}
      aria-label="Five-step Agent decision flow"
    >
      <header className="eg-demo-flow-header">
        <div>
          <span className="eg-kicker">Decision path · 3 Agents + Gate + Effect</span>
          <h2>{story.headline}</h2>
        </div>
        <div className="eg-demo-flow-actions">
          <span className="eg-demo-replay-status" aria-live="polite">
            {replayStep === null
              ? "SAVED REAL RUN"
              : replayStep < stages.length
                ? `REPLAY ${replayStep}/${stages.length}`
                : "REPLAY COMPLETE"}
          </span>
          <button
            type="button"
            className="eg-demo-replay-button"
            onClick={() => setReplayStep(0)}
          >
            <span aria-hidden="true">▶</span> Replay 1→5
          </button>
          <span className="eg-demo-scenario">
            {snapshot.scenarioId === "normal-world-v1" ? "NORMAL WORLD" : "IMPOSSIBLE COLLAGE"}
          </span>
        </div>
      </header>
      <ol className="eg-demo-steps">
        {displayedStages.map((stage, index) => (
          <li
            key={stage.number}
            className={`eg-demo-step eg-demo-step-${stage.tone}${
              replaying && index === replayStep ? " eg-demo-step-replay-current" : ""
            }${replaying && index >= replayStep ? " eg-demo-step-replay-pending" : ""}`}
          >
            <span className="eg-demo-number" aria-hidden="true">{stage.number}</span>
            <div className="eg-demo-step-copy">
              <span className="eg-demo-kind">{stage.kind}</span>
              <strong>{stage.label}</strong>
              <b className="eg-demo-state">{stage.state}</b>
              <small>{stage.detail}</small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function RuntimeEvidence({
  snapshot,
}: {
  snapshot: SessionDashboardSnapshot;
}) {
  const activeDecisions = snapshot.agents.flatMap((agent) =>
    agent.activeDecision === null ? [] : [agent.activeDecision],
  );
  const uniqueActiveRunCount = new Set(
    activeDecisions.map((decision) => decision.runId),
  ).size;
  const recordedThreadCount = activeDecisions.filter(
    (decision) => decision.runtimeProof.threadId !== null,
  ).length;
  const usage = [
    {
      field: "inputTokens" as const,
      label: "Input",
      note: null,
    },
    {
      field: "cachedInputTokens" as const,
      label: "Cached input",
      note: "input subset",
    },
    {
      field: "outputTokens" as const,
      label: "Output",
      note: null,
    },
  ].map((item) => ({
    ...item,
    summary: summarizeUsage(activeDecisions, item.field),
  }));

  return (
    <section
      className="eg-runtime-evidence"
      aria-label="Authoritative runtime evidence"
    >
      <header className="eg-runtime-evidence-header">
        <div>
          <h2>Authoritative runtime evidence</h2>
          <p>Current Snapshot projection · opaque identifiers withheld</p>
        </div>
        <span className="eg-read-only-badge">Read only</span>
      </header>
      <dl
        className="eg-runtime-evidence-list"
        aria-label="Projected runtime evidence facts"
      >
        <div className="eg-runtime-fanout">
          <dt>Initial fan-out</dt>
          <dd>{snapshot.coordinationMode}</dd>
        </div>
        <div>
          <dt>Unique active runs</dt>
          <dd>{uniqueActiveRunCount}/{REQUIRED_RUNTIME_RUNS}</dd>
        </div>
        <div>
          <dt>Threads recorded</dt>
          <dd>{recordedThreadCount}/{REQUIRED_RUNTIME_RUNS}</dd>
        </div>
        <div className="eg-runtime-timing">
          <dt>Current active timing</dt>
          <dd>{activeOverlapLabel(snapshot, activeDecisions)}</dd>
        </div>
        <div className="eg-runtime-usage-item">
          <dt>Token usage</dt>
          <dd className="eg-runtime-usage">
            {usage.map(({ field, label, note, summary }) => (
              <span key={field}>
                <b>{label}</b>
                <strong>{formatUsageTotal(summary)}</strong>
                <small>
                  {note === null ? "" : `${note} · `}reported {summary.reported}/
                  {REQUIRED_RUNTIME_RUNS}
                </small>
              </span>
            ))}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function AgentCard({
  agent,
  witnessReceiptIds,
  isInspectionFocus = false,
}: {
  agent: SessionDashboardSnapshot["agents"][number];
  witnessReceiptIds: ReadonlySet<string>;
  isInspectionFocus?: boolean;
}) {
  const decision = agent.activeDecision;
  const attempt = agent.inFlightAttempt;
  const isWitness =
    decision !== null && witnessReceiptIds.has(decision.receipt.receiptId);

  return (
    <article
      className={`eg-agent-card${isWitness ? " eg-agent-card-witness" : ""}${isInspectionFocus ? " eg-agent-card-focus" : ""}`}
      aria-label={`${ROLE_LABELS[agent.role]} Agent evidence${isInspectionFocus ? " selected before Run" : ""}`}
    >
      <header className="eg-agent-card-header">
        <div className={`eg-role-mark eg-role-${agent.role}`} aria-hidden="true">
          {ROLE_LABELS[agent.role].slice(0, 1)}
        </div>
        <div className="eg-agent-identity">
          <span className="eg-kicker">{ROLE_LABELS[agent.role]} Agent</span>
          <h3>{agent.agentNameAtAssignment}</h3>
          <span className="eg-agent-id" title={agent.agentId}>
            Agent ID <code>{agent.agentId}</code>
          </span>
        </div>
        <div className="eg-agent-card-badges">
          {isInspectionFocus ? (
            <span className="eg-inspection-focus-badge">Selected before Run</span>
          ) : null}
          <span className="eg-run-count">{agent.runCount} run{agent.runCount === 1 ? "" : "s"}</span>
        </div>
      </header>

      {decision === null ? (
        <div className="eg-decision-empty">
          <span aria-hidden="true">◌</span>
          <div>
            <strong>No accepted Decision yet</strong>
            <p>The Gate is waiting for a bound, validated result.</p>
          </div>
        </div>
      ) : (
        <section className="eg-active-decision">
          <div className="eg-section-label">
            <span>Active Decision</span>
            {isWitness ? <strong>Conflict witness</strong> : null}
          </div>
          <div className="eg-decision-row">
            <span className={`eg-verdict eg-verdict-${decision.verdict.toLowerCase()}`}>
              <span aria-hidden="true">{decisionIcon(decision.verdict)}</span>
              {decision.verdict}
            </span>
            <span
              className={`eg-evidence-state eg-evidence-${decision.evidenceState.toLowerCase()}`}
            >
              {EVIDENCE_COPY[decision.evidenceState]}
            </span>
          </div>
          <p className="eg-fact">{decision.factSummary}</p>
          <div className="eg-receipt-strip">
            <span>
              Receipt <code>{shortId(decision.receipt.receiptId, 20)}</code>
            </span>
            <strong>{intervalLabel(decision.receipt)}</strong>
          </div>
          <details
            className="eg-details"
            open={isInspectionFocus ? true : undefined}
          >
            <summary>Run-bound evidence</summary>
            <dl className="eg-evidence-grid">
              <div>
                <dt>Run</dt>
                <dd title={decision.runId}>{shortId(decision.runId)}</dd>
              </div>
              <div>
                <dt>Assignment</dt>
                <dd title={decision.runtimeProof.assignmentId}>
                  {shortId(decision.runtimeProof.assignmentId)}
                </dd>
              </div>
              <div>
                <dt>Source revision</dt>
                <dd>v{decision.receipt.sourceRevision}</dd>
              </div>
              <div>
                <dt>Observed</dt>
                <dd>v{decision.receipt.observedAtSeq}</dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>{decision.runtimeProof.runtimeLabel}</dd>
              </div>
              <div>
                <dt>Role profile</dt>
                <dd>{decision.runtimeProof.roleProfileVersion}</dd>
              </div>
              <div>
                <dt>Prompt template</dt>
                <dd>{decision.runtimeProof.promptTemplateVersion}</dd>
              </div>
              <div>
                <dt>Thread</dt>
                <dd title={decision.runtimeProof.threadId ?? undefined}>
                  {shortId(decision.runtimeProof.threadId)}
                </dd>
              </div>
              <div className="eg-evidence-wide">
                <dt>Evidence pack</dt>
                <dd>{decision.runtimeProof.evidencePackRelativePath}</dd>
              </div>
              <div className="eg-evidence-wide">
                <dt>Pack hash</dt>
                <dd>{shortId(decision.runtimeProof.evidencePackHash, 28)}</dd>
              </div>
            </dl>
          </details>
        </section>
      )}

      {attempt !== null ? (
        <section className="eg-new-attempt" aria-label="New in-flight Attempt">
          <div className="eg-attempt-pulse" aria-hidden="true" />
          <div>
            <span className="eg-section-label">New Attempt · {humanize(attempt.status)}</span>
            <strong>{shortId(attempt.runId ?? attempt.attemptId, 22)}</strong>
            <p>
              This Attempt is separate from the active Decision shown above.
            </p>
          </div>
        </section>
      ) : null}
    </article>
  );
}

function EmptyDashboard({
  loading,
  error,
}: {
  loading: boolean;
  error: { message: string; details: string[] } | null;
}) {
  return (
    <section className="eg-empty-state">
      <div className="eg-empty-symbol" aria-hidden="true">
        {loading ? "◌" : "!"}
      </div>
      <span className="eg-kicker">Session Safety</span>
      <h2>{loading ? "Loading authoritative Snapshot" : "Actions disabled"}</h2>
      <p>
        {loading
          ? "Waiting for the single Session projection."
          : (error?.message ?? "No supported Session Snapshot is available.")}
      </p>
      {error?.details.length ? (
        <details className="eg-details eg-empty-details">
          <summary>Decoder details</summary>
          <ul>
            {error.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export function EpochGuardDashboard({
  source,
  sessionId,
  focusedAgentId = null,
  pollIntervalMs,
  staleAfterMs,
}: EpochGuardDashboardProps) {
  const controller = useEpochGuardSession({
    source,
    sessionId,
    pollIntervalMs,
    staleAfterMs,
  });
  const snapshot = controller.snapshot;
  const witnessReceiptIds = new Set(
    snapshot?.jointValidity.noCutProof?.witness.map((item) => item.receiptId) ?? [],
  );
  const refreshOwners =
    snapshot?.refreshPlan?.agentIds.flatMap((agentId) => {
      const agent = snapshot.agents.find((candidate) => candidate.agentId === agentId);
      return agent === undefined ? [] : [agent];
    }) ?? [];
  const refreshOwnerRoles = refreshOwners
    .map((agent) => ROLE_LABELS[agent.role])
    .join(" + ");
  const refreshActionLabel =
    refreshOwners.length === 1
      ? `Re-observe ${refreshOwnerRoles} only`
      : `Re-observe ${refreshOwnerRoles}`;

  const liveMessage =
    snapshot === null
      ? controller.error?.message ?? "Loading Session Safety Snapshot."
      : freshnessMessage(snapshot, controller.isStale);

  return (
    <section className="eg-dashboard" aria-label="EpochGuard Session Safety Dashboard">
      <p className="eg-live-region" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </p>

      {snapshot === null ? (
        <EmptyDashboard loading={controller.isLoading} error={controller.error} />
      ) : (
        <>
          <header className="eg-dashboard-header">
            <div className="eg-title-block">
              <span className="eg-kicker">Joint-validity effect gate</span>
              <h1>Session Safety</h1>
              <p>
                Protecting <strong>{snapshot.action.campaignId}</strong> · {snapshot.action.requestedUnits} unit · {formatMoney(snapshot.action.estimatedCostCents)} · {snapshot.action.market}
              </p>
            </div>
            <div className="eg-revision-cluster" aria-label="Snapshot identity">
              <span>World head <strong>v{snapshot.worldHead}</strong></span>
              <span>Snapshot <strong>r{snapshot.snapshotRevision}</strong></span>
              <span>Session <strong>r{snapshot.sessionRevision}</strong></span>
              <time dateTime={snapshot.generatedAt}>{formatTime(snapshot.generatedAt)}</time>
            </div>
          </header>

          {controller.isStale || controller.error !== null ? (
            <div
              className={`eg-view-notice ${controller.isStale ? "eg-view-notice-stale" : ""}`}
            >
              <span aria-hidden="true">{controller.isStale ? "⛔" : "!"}</span>
              <div>
                <strong>
                  {controller.isStale ? "VIEW STALE — ACTIONS DISABLED" : "Transport notice"}
                </strong>
                <p>{controller.error?.message ?? "No recent confirmed Snapshot."}</p>
              </div>
              <button type="button" onClick={() => void controller.reload()}>
                Retry GET
              </button>
            </div>
          ) : null}

          <AgentDecisionFlow snapshot={snapshot} />

          <div className="eg-summary-grid">
            <article className="eg-summary-card">
              <span className="eg-kicker">Team Decisions</span>
              <strong className="eg-summary-value">
                {snapshot.metrics.activeDecisions}/{snapshot.metrics.requiredDecisions}
              </strong>
              <p>
                <span aria-hidden="true">✓</span> {snapshot.metrics.allowDecisions} ALLOW · {snapshot.metrics.denyDecisions} DENY
              </p>
            </article>
            <article className="eg-summary-card">
              <span className="eg-kicker">Observed-World Cut</span>
              <strong className="eg-summary-state">
                {JOINT_VALIDITY_COPY[snapshot.jointValidity.state]}
              </strong>
              <p>
                L {snapshot.jointValidity.lowerBound ?? "—"} · U {snapshot.jointValidity.upperBound ?? "—"}
              </p>
            </article>
            <article className={`eg-summary-card eg-gate-${snapshot.gate.state.toLowerCase()}`}>
              <span className="eg-kicker">Protected Effect</span>
              <strong className="eg-summary-state">
                <span aria-hidden="true">{GATE_ICONS[snapshot.gate.state]}</span> {snapshot.gate.state}
              </strong>
              <p>Effects in this session: <b>{snapshot.gate.effectsInSession}</b></p>
            </article>
            <article className="eg-summary-card">
              <span className="eg-kicker">Re-observation</span>
              <strong className="eg-summary-state">
                {snapshot.refreshPlan === null
                  ? "None required"
                  : `${snapshot.refreshPlan.status} · ${snapshot.refreshPlan.agentIds.length}/3`}
              </strong>
              <p>{snapshot.metrics.rerunsAvoided} unnecessary reruns avoided</p>
            </article>
          </div>

          <section className="eg-agent-grid" aria-label="Role Agent Decisions">
            {snapshot.agents.map((agent) => (
              <AgentCard
                key={agent.role}
                agent={agent}
                witnessReceiptIds={witnessReceiptIds}
                isInspectionFocus={agent.agentId === focusedAgentId}
              />
            ))}
          </section>

          <RuntimeEvidence snapshot={snapshot} />

          <div className="eg-inspector-grid">
            <section className="eg-panel eg-world-panel">
              <header className="eg-panel-header">
                <div>
                  <span className="eg-kicker">Observed-world inspector</span>
                  <h2>{JOINT_VALIDITY_COPY[snapshot.jointValidity.state]}</h2>
                </div>
                <span className="eg-head-badge">HEAD · v{snapshot.worldHead}</span>
              </header>

              <div className="eg-interval-table-wrap">
                <table className="eg-interval-table">
                  <thead>
                    <tr>
                      <th>Owner</th>
                      <th>Half-open interval</th>
                      <th>Observed</th>
                      <th>Evidence state</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.agents.map((agent) => {
                      const active = agent.activeDecision;
                      const witness =
                        active !== null && witnessReceiptIds.has(active.receipt.receiptId);
                      return (
                        <tr key={agent.role} className={witness ? "eg-witness-row" : ""}>
                          <th>{ROLE_LABELS[agent.role]}</th>
                          <td>
                            {active === null ? "—" : intervalLabel(active.receipt)}
                          </td>
                          <td>{active === null ? "—" : `v${active.receipt.observedAtSeq}`}</td>
                          <td>
                            {active === null ? "Awaiting Decision" : EVIDENCE_COPY[active.evidenceState]}
                            {witness ? <strong className="eg-witness-tag">Witness</strong> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {snapshot.jointValidity.noCutProof !== null ? (
                <div className="eg-proof-callout">
                  <span className="eg-proof-symbol" aria-hidden="true">∅</span>
                  <div>
                    <strong>No shared revision</strong>
                    <p>
                      The server-issued proof reports L={snapshot.jointValidity.noCutProof.lowerBound} and U={snapshot.jointValidity.noCutProof.upperBound}. The protected action remains blocked.
                    </p>
                    <div className="eg-witness-list">
                      {snapshot.jointValidity.noCutProof.witness.map((item) => (
                        <span key={item.receiptId}>
                          {ROLE_LABELS[item.role]} {`[v${item.from}, ${item.until === null ? "∞" : `v${item.until}`})`}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {snapshot.jointValidity.noCutProof !== null ? (
                <details className="eg-details eg-proof-details">
                  <summary>Raw server proof</summary>
                  <pre>{JSON.stringify(snapshot.jointValidity.noCutProof, null, 2)}</pre>
                </details>
              ) : null}
            </section>

            <aside className="eg-side-stack">
              <section className={`eg-panel eg-gate-panel eg-gate-${snapshot.gate.state.toLowerCase()}`}>
                <span className="eg-gate-icon" aria-hidden="true">
                  {GATE_ICONS[snapshot.gate.state]}
                </span>
                <span className="eg-kicker">Effect Gate</span>
                <h2>{GATE_COPY[snapshot.gate.state]}</h2>
                <p>
                  {snapshot.sessionState === "CONSISTENT_DENY"
                    ? "RESOLVED SAFELY · NOT RELEASED"
                    : snapshot.gate.reasonCode === null
                      ? humanize(snapshot.sessionState)
                      : humanize(snapshot.gate.reasonCode)}
                </p>
                <dl className="eg-gate-facts">
                  <div><dt>Effects</dt><dd>{snapshot.gate.effectsInSession}</dd></div>
                  <div><dt>Permit</dt><dd>{shortId(snapshot.gate.permitId)}</dd></div>
                  <div><dt>Effect ID</dt><dd>{shortId(snapshot.gate.effectId)}</dd></div>
                </dl>
              </section>

              <section className="eg-panel eg-action-panel">
                <span className="eg-kicker">Authorized next step</span>
                <h2>
                  {snapshot.availableActions.length === 0
                    ? "No mutation available"
                    : snapshot.availableActions[0] === "REOBSERVE_INVALID"
                      ? `Re-observe ${refreshOwnerRoles}`
                      : "Commit protected effect"}
                </h2>
                {snapshot.refreshPlan !== null ? (
                  <>
                    <p>
                      Plan <code>{shortId(snapshot.refreshPlan.refreshPlanId)}</code> · {refreshOwners.length} {refreshOwners.length === 1 ? "owner" : "owners"} · {snapshot.metrics.rerunsAvoided} reruns avoided
                    </p>
                    <ul
                      className="eg-refresh-owner-list"
                      aria-label="Server-selected re-observation owners"
                    >
                      {refreshOwners.map((agent) => (
                        <li key={agent.agentId}>
                          <strong>{ROLE_LABELS[agent.role]}</strong>
                          <span>{agent.agentNameAtAssignment}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>Actions are supplied by the authoritative Snapshot only.</p>
                )}
                {snapshot.availableActions.includes("REOBSERVE_INVALID") ? (
                  <button
                    className="eg-action-button eg-action-button-primary"
                    type="button"
                    disabled={controller.actionsDisabled}
                    onClick={() => void controller.refresh()}
                  >
                    {controller.commandPending === "REFRESH" ? "Request pending…" : refreshActionLabel}
                  </button>
                ) : null}
                {snapshot.availableActions.includes("COMMIT") ? (
                  <button
                    className="eg-action-button eg-action-button-primary"
                    type="button"
                    disabled={controller.actionsDisabled}
                    onClick={() => void controller.commit()}
                  >
                    {controller.commandPending === "COMMIT" ? "Request pending…" : "Commit protected effect"}
                  </button>
                ) : null}
              </section>
            </aside>
          </div>

          <section className="eg-panel eg-ledger-panel">
            <header className="eg-panel-header">
              <div>
                <span className="eg-kicker">Event ledger</span>
                <h2>Same Snapshot · same revision</h2>
              </div>
              <span className="eg-revision-label">r{snapshot.snapshotRevision} / s{snapshot.sessionRevision}</span>
            </header>
            {snapshot.events.length === 0 ? (
              <p className="eg-muted">No redacted events are available yet.</p>
            ) : (
              <ol className="eg-event-list">
                {snapshot.events.map((event) => (
                  <li key={event.eventId}>
                    <span className="eg-event-sequence">{event.sequence}</span>
                    <div>
                      <strong>{humanize(event.type)}</strong>
                      <p>{event.summary}</p>
                    </div>
                    <span className="eg-event-status">
                      {event.role === null ? "Team" : ROLE_LABELS[event.role]} · {humanize(event.status)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {snapshot.latestDiagnostics.length > 0 ? (
              <details className="eg-details eg-diagnostics">
                <summary>Latest safety diagnostics</summary>
                <ul>
                  {snapshot.latestDiagnostics.map((diagnostic) => (
                    <li key={diagnostic.diagnosticId}>
                      <strong>{diagnostic.kind} · {diagnostic.stage}</strong>
                      <span>{diagnostic.reasonCode}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        </>
      )}
    </section>
  );
}

export default EpochGuardDashboard;
