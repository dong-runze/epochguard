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

export interface EpochGuardDashboardProps {
  source: EpochGuardSessionSource;
  sessionId: string;
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

function AgentCard({
  agent,
  witnessReceiptIds,
}: {
  agent: SessionDashboardSnapshot["agents"][number];
  witnessReceiptIds: ReadonlySet<string>;
}) {
  const decision = agent.activeDecision;
  const attempt = agent.inFlightAttempt;
  const isWitness =
    decision !== null && witnessReceiptIds.has(decision.receipt.receiptId);

  return (
    <article
      className={`eg-agent-card${isWitness ? " eg-agent-card-witness" : ""}`}
      aria-label={`${ROLE_LABELS[agent.role]} Agent evidence`}
    >
      <header className="eg-agent-card-header">
        <div className={`eg-role-mark eg-role-${agent.role}`} aria-hidden="true">
          {ROLE_LABELS[agent.role].slice(0, 1)}
        </div>
        <div className="eg-agent-identity">
          <span className="eg-kicker">{ROLE_LABELS[agent.role]} Agent</span>
          <h3>{agent.agentNameAtAssignment}</h3>
        </div>
        <span className="eg-run-count">{agent.runCount} run{agent.runCount === 1 ? "" : "s"}</span>
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
          <details className="eg-details">
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
              />
            ))}
          </section>

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
