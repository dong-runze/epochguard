import {
  CommitSessionRequestSchema,
  CreateSessionRequestSchema,
  RefreshSessionRequestSchema,
  STALE_VIEW_MESSAGE,
  type StaleViewErrorBody,
} from "../contracts";
import {
  EpochGuardSessionSourceError,
  type EpochGuardSessionSource,
  type SessionSourceRequestOptions,
} from "../session-source";
import {
  mockScenario,
  type MockScenarioKey,
} from "./mock-snapshots";

const MOCK_LATENCY_MS = 70;
const MOCK_REFRESH_DURATION_MS = 1_450;

function clonePayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function abortError(): DOMException {
  return new DOMException("The Mock request was aborted.", "AbortError");
}

async function mockDelay(
  options: SessionSourceRequestOptions | undefined,
): Promise<void> {
  const signal = options?.signal;
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, MOCK_LATENCY_MS);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export class MockSessionSource implements EpochGuardSessionSource {
  private scenarioKey: MockScenarioKey;
  private reads = 0;
  private transitionTimer: number | null = null;

  constructor(initialScenario: MockScenarioKey) {
    this.scenarioKey = initialScenario;
  }

  get sessionId(): string {
    return mockScenario(this.scenarioKey).sessionId;
  }

  dispose(): void {
    if (this.transitionTimer !== null) {
      window.clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
  }

  async createSession(
    request: unknown,
    options?: SessionSourceRequestOptions,
  ): Promise<unknown> {
    await mockDelay(options);
    const parsed = CreateSessionRequestSchema.parse(request);
    this.dispose();
    this.reads = 0;
    this.scenarioKey =
      parsed.scenarioId === "normal-world-v1"
        ? "normal-ready"
        : "impossible-blocked";
    return clonePayload(mockScenario(this.scenarioKey).payload);
  }

  async getSession(
    sessionId: string,
    options?: SessionSourceRequestOptions,
  ): Promise<unknown> {
    await mockDelay(options);
    this.assertSession(sessionId);
    this.reads += 1;
    if (this.scenarioKey === "stale" && this.reads > 1) {
      throw new EpochGuardSessionSourceError(
        "Mock transport disconnected after the last confirmed Snapshot.",
        { status: 503 },
      );
    }
    return clonePayload(mockScenario(this.scenarioKey).payload);
  }

  async refreshSession(
    sessionId: string,
    request: unknown,
    options?: SessionSourceRequestOptions,
  ): Promise<unknown> {
    await mockDelay(options);
    this.assertSession(sessionId);
    const parsed = RefreshSessionRequestSchema.parse(request);
    const current = mockScenario(this.scenarioKey).payload as {
      sessionRevision?: unknown;
      refreshPlan?: { refreshPlanId?: unknown } | null;
    };
    if (
      this.scenarioKey !== "impossible-blocked" ||
      parsed.expectedSessionRevision !== current.sessionRevision ||
      parsed.refreshPlanId !== current.refreshPlan?.refreshPlanId
    ) {
      throw this.staleView(sessionId, parsed.expectedSessionRevision);
    }

    this.scenarioKey = "refreshing-budget";
    this.reads = 0;
    this.transitionTimer = window.setTimeout(() => {
      this.scenarioKey = "recovered-deny";
      this.reads = 0;
      this.transitionTimer = null;
    }, MOCK_REFRESH_DURATION_MS);
    return { accepted: true };
  }

  async commitSession(
    sessionId: string,
    request: unknown,
    options?: SessionSourceRequestOptions,
  ): Promise<unknown> {
    await mockDelay(options);
    this.assertSession(sessionId);
    const parsed = CommitSessionRequestSchema.parse(request);
    const current = mockScenario(this.scenarioKey).payload as {
      sessionRevision?: unknown;
    };
    if (
      this.scenarioKey !== "normal-ready" ||
      parsed.expectedSessionRevision !== current.sessionRevision
    ) {
      throw this.staleView(sessionId, parsed.expectedSessionRevision);
    }
    this.scenarioKey = "normal-released";
    this.reads = 0;
    return { accepted: true };
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.sessionId) {
      throw new EpochGuardSessionSourceError(
        `Mock session ${sessionId} does not exist.`,
        { status: 404 },
      );
    }
  }

  private staleView(
    sessionId: string,
    expectedSessionRevision: number,
  ): EpochGuardSessionSourceError {
    const current = mockScenario(this.scenarioKey).payload as {
      sessionRevision?: unknown;
    };
    const body: StaleViewErrorBody = {
      error: "STALE_VIEW",
      message: STALE_VIEW_MESSAGE,
      sessionId,
      expectedSessionRevision,
      actualSessionRevision:
        typeof current.sessionRevision === "number" ? current.sessionRevision : 0,
    };
    return new EpochGuardSessionSourceError(body.message, {
      status: 409,
      body,
    });
  }
}
