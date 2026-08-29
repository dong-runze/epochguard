import type {
  ApiErrorBody,
  CommitSessionRequest,
  CreateSessionRequest,
  RefreshSessionRequest,
} from "./contracts";

export interface SessionSourceRequestOptions {
  signal?: AbortSignal;
}

/**
 * The transport boundary for Session Safety. Implementations return unknown so
 * both HTTP and Mock payloads must pass through the same frozen decoder before
 * they can reach React state.
 */
export interface EpochGuardSessionSource {
  createSession(
    request: CreateSessionRequest,
    options?: SessionSourceRequestOptions,
  ): Promise<unknown>;
  getSession(
    sessionId: string,
    options?: SessionSourceRequestOptions,
  ): Promise<unknown>;
  refreshSession(
    sessionId: string,
    request: RefreshSessionRequest,
    options?: SessionSourceRequestOptions,
  ): Promise<unknown>;
  commitSession(
    sessionId: string,
    request: CommitSessionRequest,
    options?: SessionSourceRequestOptions,
  ): Promise<unknown>;
}

export type EpochGuardCommand = "REFRESH" | "COMMIT";

export class EpochGuardSessionSourceError extends Error {
  readonly status: number | null;
  readonly body: ApiErrorBody | null;

  constructor(
    message: string,
    options: { status?: number; body?: ApiErrorBody; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EpochGuardSessionSourceError";
    this.status = options.status ?? null;
    this.body = options.body ?? null;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (error instanceof Error && error.name === "AbortError");
}
