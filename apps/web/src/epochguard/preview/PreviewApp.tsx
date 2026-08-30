import { useEffect, useMemo, useState } from "react";
import { CONTRACT_DIGEST, CONTRACT_VERSION } from "../contracts";
import EpochGuardDashboard from "../EpochGuardDashboard";
import { MockSessionSource } from "./MockSessionSource";
import {
  MOCK_PREVIEW_NOTICE,
  MOCK_SCENARIOS,
  MOCK_SCENARIO_KEYS,
  type MockScenarioKey,
} from "./mock-snapshots";

interface PreviewSelection {
  key: MockScenarioKey;
  generation: number;
}

export default function PreviewApp() {
  const [selection, setSelection] = useState<PreviewSelection>({
    key: "impossible-blocked",
    generation: 0,
  });
  const source = useMemo(
    () => new MockSessionSource(selection.key),
    [selection.generation, selection.key],
  );
  const scenario = MOCK_SCENARIOS[selection.key];

  useEffect(() => () => source.dispose(), [source]);

  const selectScenario = (key: MockScenarioKey) => {
    setSelection((current) => ({ key, generation: current.generation + 1 }));
  };

  return (
    <div className="eg-preview-shell">
      <header className="eg-preview-warning">
        <span className="eg-preview-warning-icon" aria-hidden="true">!</span>
        <div>
          <strong>{MOCK_PREVIEW_NOTICE}</strong>
          <span>Static contract fixtures only · no middleware claim · no HTTP fallback</span>
        </div>
        <span className="eg-preview-offline"><span aria-hidden="true">○</span> Network-free Source</span>
      </header>

      <section className="eg-preview-controls" aria-label="Mock lifecycle states">
        <div className="eg-preview-intro">
          <div>
            <span className="eg-kicker">EpochGuard · visual QA harness</span>
            <h1>Session Safety lifecycle preview</h1>
          </div>
          <p>{scenario.description}</p>
        </div>
        <div className="eg-preview-scenario-list">
          {MOCK_SCENARIO_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={selection.key === key}
              onClick={() => selectScenario(key)}
            >
              {MOCK_SCENARIOS[key].label}
            </button>
          ))}
        </div>
        <div className="eg-preview-contract">
          <span>{CONTRACT_VERSION}</span>
          <code title={CONTRACT_DIGEST}>{CONTRACT_DIGEST.slice(0, 22)}…</code>
          <button
            type="button"
            onClick={() => selectScenario(selection.key)}
            title="Reset the selected Mock lifecycle state"
          >
            Reset state
          </button>
        </div>
      </section>

      <main className="eg-preview-main">
        <EpochGuardDashboard
          source={source}
          sessionId={scenario.sessionId}
          pollIntervalMs={900}
          staleAfterMs={3_000}
        />
      </main>
    </div>
  );
}
