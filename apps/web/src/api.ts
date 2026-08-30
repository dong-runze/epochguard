import type { Agent, AgentRun, Message, SystemInfo } from "./types";
import {
  API_ERROR_STATUS,
  ApiErrorBodySchema,
  type CommitSessionRequest,
  type CreateSessionRequest,
  type RefreshSessionRequest,
} from "./epochguard/contracts";
import {
  EpochGuardSessionSourceError,
  isAbortError,
  type EpochGuardSessionSource,
  type SessionSourceRequestOptions,
} from "./epochguard/session-source";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

const EPOCHGUARD_GENERIC_ERROR =
  "EpochGuard request failed without a valid canonical error response.";

async function epochGuardRequest(
  url: string,
  expectedStatus: 200 | 201 | 202,
  options: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new EpochGuardSessionSourceError(
      "Unable to reach the EpochGuard service.",
      { cause: error },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    payload = undefined;
  }
  if (!response.ok) {
    const decoded = ApiErrorBodySchema.safeParse(payload);
    if (
      decoded.success &&
      API_ERROR_STATUS[decoded.data.error] === response.status
    ) {
      throw new EpochGuardSessionSourceError(decoded.data.message, {
        status: response.status,
        body: decoded.data,
      });
    }
    throw new EpochGuardSessionSourceError(EPOCHGUARD_GENERIC_ERROR, {
      status: response.status,
    });
  }
  if (response.status !== expectedStatus || payload === undefined) {
    throw new EpochGuardSessionSourceError(EPOCHGUARD_GENERIC_ERROR, {
      status: response.status,
    });
  }
  return payload;
}

export const epochGuardSessionSource: EpochGuardSessionSource = {
  createSession: (
    body: CreateSessionRequest,
    options?: SessionSourceRequestOptions,
  ) =>
    epochGuardRequest("/api/epochguard/sessions", 201, {
      method: "POST",
      body: JSON.stringify(body),
      signal: options?.signal,
    }),
  getSession: (
    sessionId: string,
    options?: SessionSourceRequestOptions,
  ) =>
    epochGuardRequest(
      "/api/epochguard/sessions/" + encodeURIComponent(sessionId),
      200,
      { signal: options?.signal, cache: "no-store" },
    ),
  refreshSession: (
    sessionId: string,
    body: RefreshSessionRequest,
    options?: SessionSourceRequestOptions,
  ) =>
    epochGuardRequest(
      "/api/epochguard/sessions/" +
        encodeURIComponent(sessionId) +
        "/refresh",
      202,
      {
        method: "POST",
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    ),
  commitSession: (
    sessionId: string,
    body: CommitSessionRequest,
    options?: SessionSourceRequestOptions,
  ) =>
    epochGuardRequest(
      "/api/epochguard/sessions/" +
        encodeURIComponent(sessionId) +
        "/commit",
      200,
      {
        method: "POST",
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    ),
};

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
};
