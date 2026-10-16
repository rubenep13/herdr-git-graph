import type {
  GitGraphCommitDetails,
  GitGraphComparison,
  GitGraphFileDiff,
  GitGraphPage,
  GitGraphRevision
} from "@web-git-graph/protocol";

export interface RepoSummary {
  id: string;
  name: string;
  displayPath: string;
  bare: boolean;
  linkedWorktree: boolean;
  mainId?: string;
  branch?: string;
}

export interface ReposResponse {
  repositories: RepoSummary[];
  roots: Array<{ path: string; depth: number }>;
  scannedAt: string;
}

export interface InfoResponse {
  repository: RepoSummary;
  head?: string;
  branch?: string;
  hiddenRefs: number;
  empty: boolean;
}

export interface WorktreeFile {
  path: string;
  previousPath?: string;
  status: string;
  submodule?: boolean;
}

export type WorktreeSection = "staged" | "unstaged" | "untracked" | "conflicted";

export interface WorktreeStatus {
  head?: string;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: WorktreeFile[];
  unstaged: WorktreeFile[];
  untracked: WorktreeFile[];
  conflicted: WorktreeFile[];
  fingerprint: string;
}

export interface WorktreeDiff {
  section: WorktreeSection;
  path: string;
  previousPath?: string;
  patch?: string;
  truncated?: boolean;
  binary?: boolean;
  unavailableReason?: string;
}

export interface SearchResult {
  oid: string;
  subject: string;
  author: string;
  email: string;
  authoredAt: string;
  matched: Array<"hash" | "message" | "author">;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  limited: boolean;
}

export interface RepoState {
  refs: string;
  worktree: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The server could not be reached at all (stopped, or the tunnel is down). */
  readonly network: boolean;

  constructor(message: string, status: number, code: string, network = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.network = network;
  }
}

const SESSION_KEY = "hgg.session.v1";

/**
 * The session token, kept in localStorage: it is per origin (port included),
 * so no other local server can read it, unlike a cookie for localhost.
 */
export const session = {
  get(): string {
    try {
      return localStorage.getItem(SESSION_KEY) ?? "";
    } catch {
      return memorySession;
    }
  },
  set(value: string): void {
    memorySession = value;
    try {
      localStorage.setItem(SESSION_KEY, value);
    } catch {
      // Private mode: the session lasts as long as this page.
    }
  },
  clear(): void {
    memorySession = "";
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing stored.
    }
  }
};
let memorySession = "";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  const token = session.get();
  try {
    response = await fetch(path, {
      ...init,
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError("No se puede contactar con el servidor del visor.", 0, "network", true);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(error?.message ?? `HTTP ${response.status}`, response.status, error?.code ?? "http_error");
  }
  return body as T;
}

const repoPath = (id: string) => `/v1/repositories/${encodeURIComponent(id)}`;
const apiRepoPath = (id: string) => `/api/repos/${encodeURIComponent(id)}`;

/** Trades the one-time ticket `hgg` put in the URL fragment for a session token. */
export async function redeemTicket(ticket: string): Promise<void> {
  const result = await request<{ session: string }>("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket })
  });
  session.set(result.session);
}

export const api = {
  repos: (rescan = false, signal?: AbortSignal) =>
    request<ReposResponse>(`/api/repos${rescan ? "?rescan=1" : ""}`, signal ? { signal } : {}),
  info: (id: string, signal?: AbortSignal) => request<InfoResponse>(`${apiRepoPath(id)}/info`, signal ? { signal } : {}),
  history: (id: string, options: { limit: number; cursor?: string }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: String(options.limit), includeWorkingTree: "false" });
    if (options.cursor) query.set("cursor", options.cursor);
    return request<GitGraphPage>(`${repoPath(id)}/history?${query}`, signal ? { signal } : {});
  },
  commit: (id: string, oid: string, signal?: AbortSignal) =>
    request<GitGraphCommitDetails>(`${repoPath(id)}/commits/${encodeURIComponent(oid)}`, signal ? { signal } : {}),
  compare: (id: string, base: GitGraphRevision, head: GitGraphRevision, signal?: AbortSignal) =>
    request<GitGraphComparison>(`${repoPath(id)}/compare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base, head }),
      ...(signal ? { signal } : {})
    }),
  fileDiff: (id: string, base: GitGraphRevision, head: GitGraphRevision, path: string, signal?: AbortSignal) =>
    request<GitGraphFileDiff>(`${repoPath(id)}/diff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base, head, path, context: 3 }),
      ...(signal ? { signal } : {})
    }),
  worktree: (id: string, signal?: AbortSignal) => request<WorktreeStatus>(`${apiRepoPath(id)}/worktree`, signal ? { signal } : {}),
  worktreeDiff: (id: string, section: WorktreeSection, path: string, signal?: AbortSignal) =>
    request<WorktreeDiff>(
      `${apiRepoPath(id)}/worktree/diff?${new URLSearchParams({ section, path })}`,
      signal ? { signal } : {}
    ),
  search: (id: string, q: string, signal?: AbortSignal) =>
    request<SearchResponse>(`${apiRepoPath(id)}/search?${new URLSearchParams({ q, limit: "200" })}`, signal ? { signal } : {}),
  // EventSource cannot send headers, so the change stream alone takes the session as a parameter.
  eventsUrl: (id: string) => `${apiRepoPath(id)}/events?${new URLSearchParams({ s: session.get() })}`
};
