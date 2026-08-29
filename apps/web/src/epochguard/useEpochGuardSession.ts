import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionDashboardSnapshot } from "./contracts";
import {
  decodeEpochGuardSnapshot,
  type SnapshotDecodeFailure,
} from "./decode-snapshot";
import {
  EpochGuardSessionSourceError,
  isAbortError,
  type EpochGuardCommand,
  type EpochGuardSessionSource,
} from "./session-source";

const DEFAULT_POLL_INTERVAL_MS = 900;
const DEFAULT_STALE_AFTER_MS = 3_000;
const FAILURE_STALE_THRESHOLD = 3;

export type EpochGuardViewErrorKind =
  | "SOURCE_ERROR"
  | "SESSION_MISMATCH"
  | SnapshotDecodeFailure["kind"];

export interface EpochGuardViewError {
  kind: EpochGuardViewErrorKind;
  message: string;
  details: string[];
}

export interface UseEpochGuardSessionOptions {
  source: EpochGuardSessionSource;
  sessionId: string | null;
  pollIntervalMs?: number;
  staleAfterMs?: number;
}

export interface EpochGuardSessionController {
  snapshot: SessionDashboardSnapshot | null;
  error: EpochGuardViewError | null;
  isLoading: boolean;
  isStale: boolean;
  commandPending: EpochGuardCommand | null;
  actionsDisabled: boolean;
  refresh: () => Promise<void>;
  commit: () => Promise<void>;
  reload: () => Promise<void>;
}

function sourceError(error: unknown): EpochGuardViewError {
  if (error instanceof EpochGuardSessionSourceError) {
    const reason = error.body?.error;
    return {
      kind: "SOURCE_ERROR",
      message: error.message,
      details: [
        ...(reason === undefined ? [] : [`Reason: ${reason}`]),
        ...(error.status === null ? [] : [`HTTP status: ${error.status}`]),
      ],
    };
  }
  return {
    kind: "SOURCE_ERROR",
    message: error instanceof Error ? error.message : String(error),
    details: [],
  };
}

function decodeError(failure: SnapshotDecodeFailure): EpochGuardViewError {
  return {
    kind: failure.kind,
    message: failure.message,
    details:
      failure.kind === "PROJECTION_MISMATCH"
        ? failure.issues
        : [
            `Received schema: ${failure.receivedSchemaVersion ?? "unknown"}`,
            `Received contract: ${failure.receivedContractVersion ?? "unknown"}`,
          ],
  };
}

export function useEpochGuardSession({
  source,
  sessionId,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}: UseEpochGuardSessionOptions): EpochGuardSessionController {
  const [snapshot, setSnapshot] = useState<SessionDashboardSnapshot | null>(null);
  const [error, setError] = useState<EpochGuardViewError | null>(null);
  const [isLoading, setIsLoading] = useState(sessionId !== null);
  const [isStale, setIsStale] = useState(false);
  const [commandPending, setCommandPending] =
    useState<EpochGuardCommand | null>(null);

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const currentSessionIdRef = useRef<string | null>(sessionId);
  const currentSourceRef = useRef(source);
  const latestRevisionRef = useRef(-1);
  const failureCountRef = useRef(0);
  const staleTimerRef = useRef<number | null>(null);
  const controllersRef = useRef(new Set<AbortController>());
  const snapshotRef = useRef<SessionDashboardSnapshot | null>(snapshot);
  const staleRef = useRef(isStale);
  const commandPendingRef = useRef<EpochGuardCommand | null>(commandPending);
  const hardFailureRef = useRef(false);

  currentSessionIdRef.current = sessionId;
  currentSourceRef.current = source;
  snapshotRef.current = snapshot;
  staleRef.current = isStale;
  commandPendingRef.current = commandPending;

  const clearStaleTimer = useCallback(() => {
    if (staleTimerRef.current !== null) {
      window.clearTimeout(staleTimerRef.current);
      staleTimerRef.current = null;
    }
  }, []);

  const armStaleTimer = useCallback(
    (generation: number) => {
      clearStaleTimer();
      staleTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current && generationRef.current === generation) {
          staleRef.current = true;
          setIsStale(true);
        }
      }, staleAfterMs);
    },
    [clearStaleTimer, staleAfterMs],
  );

  const abortRequests = useCallback(() => {
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
  }, []);

  const readSnapshot = useCallback(
    async (
      expectedSource: EpochGuardSessionSource,
      expectedSessionId: string,
      generation: number,
    ): Promise<boolean> => {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        const payload = await expectedSource.getSession(expectedSessionId, {
          signal: controller.signal,
        });
        if (
          !mountedRef.current ||
          generationRef.current !== generation ||
          currentSourceRef.current !== expectedSource ||
          currentSessionIdRef.current !== expectedSessionId
        ) {
          return false;
        }

        const decoded = decodeEpochGuardSnapshot(payload);
        if (!decoded.ok) {
          hardFailureRef.current = true;
          staleRef.current = true;
          setIsStale(true);
          setError(decodeError(decoded.failure));
          setIsLoading(false);
          clearStaleTimer();
          return false;
        }

        if (decoded.snapshot.sessionId !== expectedSessionId) {
          hardFailureRef.current = true;
          staleRef.current = true;
          setIsStale(true);
          setError({
            kind: "SESSION_MISMATCH",
            message: "Snapshot belongs to a different EpochGuard session.",
            details: [
              `Expected: ${expectedSessionId}`,
              `Received: ${decoded.snapshot.sessionId}`,
            ],
          });
          setIsLoading(false);
          clearStaleTimer();
          return false;
        }

        if (decoded.snapshot.snapshotRevision < latestRevisionRef.current) {
          return false;
        }

        latestRevisionRef.current = decoded.snapshot.snapshotRevision;
        failureCountRef.current = 0;
        hardFailureRef.current = false;
        staleRef.current = false;
        setSnapshot(decoded.snapshot);
        setError(null);
        setIsLoading(false);
        setIsStale(false);
        armStaleTimer(generation);
        return true;
      } catch (reason) {
        if (isAbortError(reason)) return false;
        if (
          !mountedRef.current ||
          generationRef.current !== generation ||
          currentSourceRef.current !== expectedSource ||
          currentSessionIdRef.current !== expectedSessionId
        ) {
          return false;
        }
        failureCountRef.current += 1;
        if (failureCountRef.current >= FAILURE_STALE_THRESHOLD) {
          staleRef.current = true;
          setIsStale(true);
        }
        setError(sourceError(reason));
        setIsLoading(false);
        return false;
      } finally {
        controllersRef.current.delete(controller);
      }
    },
    [armStaleTimer, clearStaleTimer],
  );

  useEffect(() => {
    mountedRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    abortRequests();
    clearStaleTimer();
    latestRevisionRef.current = -1;
    failureCountRef.current = 0;
    hardFailureRef.current = false;
    staleRef.current = false;
    commandPendingRef.current = null;
    setSnapshot(null);
    setError(null);
    setIsStale(false);
    setCommandPending(null);
    setIsLoading(sessionId !== null);

    if (sessionId === null) {
      return () => {
        generationRef.current += 1;
      };
    }

    let stopped = false;
    let pollTimer: number | null = null;
    armStaleTimer(generation);

    const poll = async () => {
      await readSnapshot(source, sessionId, generation);
      if (!stopped && generationRef.current === generation) {
        pollTimer = window.setTimeout(() => void poll(), pollIntervalMs);
      }
    };
    void poll();

    return () => {
      stopped = true;
      generationRef.current += 1;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      abortRequests();
      clearStaleTimer();
    };
  }, [
    abortRequests,
    armStaleTimer,
    clearStaleTimer,
    pollIntervalMs,
    readSnapshot,
    sessionId,
    source,
  ]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      abortRequests();
      clearStaleTimer();
    },
    [abortRequests, clearStaleTimer],
  );

  const reload = useCallback(async () => {
    const activeSessionId = currentSessionIdRef.current;
    if (activeSessionId === null) return;
    await readSnapshot(
      currentSourceRef.current,
      activeSessionId,
      generationRef.current,
    );
  }, [readSnapshot]);

  const runCommand = useCallback(
    async (command: EpochGuardCommand): Promise<void> => {
      const activeSnapshot = snapshotRef.current;
      const activeSessionId = currentSessionIdRef.current;
      const activeSource = currentSourceRef.current;
      const generation = generationRef.current;
      if (
        activeSnapshot === null ||
        activeSessionId === null ||
        staleRef.current ||
        hardFailureRef.current ||
        commandPendingRef.current !== null
      ) {
        return;
      }

      const action = command === "REFRESH" ? "REOBSERVE_INVALID" : "COMMIT";
      if (!activeSnapshot.availableActions.includes(action)) return;
      if (command === "REFRESH" && activeSnapshot.refreshPlan === null) return;

      const controller = new AbortController();
      controllersRef.current.add(controller);
      commandPendingRef.current = command;
      setCommandPending(command);
      setError(null);
      try {
        if (command === "REFRESH") {
          const refreshPlan = activeSnapshot.refreshPlan;
          if (refreshPlan === null) return;
          await activeSource.refreshSession(
            activeSessionId,
            {
              expectedSessionRevision: activeSnapshot.sessionRevision,
              refreshPlanId: refreshPlan.refreshPlanId,
            },
            { signal: controller.signal },
          );
        } else {
          await activeSource.commitSession(
            activeSessionId,
            { expectedSessionRevision: activeSnapshot.sessionRevision },
            { signal: controller.signal },
          );
        }

        // Mutation responses are never projected into the UI. A fresh GET is
        // required before any success state can be shown.
        await readSnapshot(activeSource, activeSessionId, generation);
      } catch (reason) {
        if (!isAbortError(reason) && generationRef.current === generation) {
          setError(sourceError(reason));
          // A 409 refreshes the view exactly once; the command is never replayed.
          if (
            reason instanceof EpochGuardSessionSourceError &&
            reason.status === 409
          ) {
            await readSnapshot(activeSource, activeSessionId, generation);
          }
        }
      } finally {
        controllersRef.current.delete(controller);
        if (mountedRef.current && generationRef.current === generation) {
          commandPendingRef.current = null;
          setCommandPending(null);
        }
      }
    },
    [readSnapshot],
  );

  const actionsDisabled =
    snapshot === null ||
    isStale ||
    hardFailureRef.current ||
    commandPending !== null;

  return useMemo(
    () => ({
      snapshot,
      error,
      isLoading,
      isStale,
      commandPending,
      actionsDisabled,
      refresh: () => runCommand("REFRESH"),
      commit: () => runCommand("COMMIT"),
      reload,
    }),
    [
      actionsDisabled,
      commandPending,
      error,
      isLoading,
      isStale,
      reload,
      runCommand,
      snapshot,
    ],
  );
}
