import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { createGitGraphNodeHandler } from "@web-git-graph/node";
import { GitGraphProtocolError, type GitGraphErrorCode } from "@web-git-graph/protocol";
import { APP_NAME, type AppConfig } from "./config.ts";
import type { ViewerBackend } from "./backend.ts";
import type { GitRunner } from "./git.ts";
import type { RepoEntry, RepoRegistry } from "./registry.ts";
import { searchCommits } from "./search.ts";
import { WatchHub } from "./watch.ts";
import { readWorktreeDiff, readWorktreeStatus } from "./worktree.ts";

export interface AppContext {
  config: AppConfig;
  registry: RepoRegistry;
  backend: ViewerBackend;
  git: GitRunner;
  staticDir: string;
  version: string;
  watchHub?: WatchHub;
  /** Heartbeat of the change stream, in milliseconds. */
  heartbeatMs?: number;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Every route the server answers. All of them only read; the two POST routes
 * of @web-git-graph/node compute a comparison or a patch from a JSON body.
 */
export const ROUTES = [
  "GET /api/health",
  "GET /api/repos",
  "GET /api/repos/:id/info",
  "GET /api/repos/:id/worktree",
  "GET /api/repos/:id/worktree/diff",
  "GET /api/repos/:id/search",
  "GET /api/repos/:id/events",
  "GET /v1/capabilities",
  "GET /v1/repositories",
  "GET /v1/repositories/:id/history",
  "GET /v1/repositories/:id/commits/:oid",
  "POST /v1/repositories/:id/compare",
  "POST /v1/repositories/:id/diff",
  "GET /* (static files of the page)"
] as const;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
};

const ERROR_STATUS: Record<GitGraphErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  repository_not_found: 404,
  revision_not_found: 404,
  snapshot_expired: 409,
  git_unavailable: 503,
  output_limit: 413,
  unsupported: 422,
  rate_limited: 429,
  internal_error: 500
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** `localhost:3020` → `localhost`; `[::1]:3020` → `[::1]`. */
function hostnameOf(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 0 ? host.slice(0, end + 1).toLowerCase() : host.toLowerCase();
  }
  return host.split(":", 1)[0]!.toLowerCase();
}

/**
 * Rejects requests a browser could be tricked into sending:
 * - Host must be a loopback name (DNS rebinding). Any port is accepted
 *   because Herdr may forward the server to another local port.
 * - Origin, when present, must be exactly this page's origin.
 * - Fetch metadata must not say cross-site for API calls.
 * No CORS header is ever sent, so other origins cannot read responses.
 */
export function checkRequest(request: IncomingMessage, pathname: string): void {
  const host = request.headers.host ?? "";
  if (!host || !LOOPBACK_HOSTNAMES.has(hostnameOf(host))) {
    throw new HttpError(403, "forbidden_host", "Host not allowed: use localhost or 127.0.0.1.");
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) {
    throw new HttpError(403, "forbidden_origin", "Cross-origin requests are not allowed.");
  }
  const api = pathname.startsWith("/api/") || pathname.startsWith("/v1/");
  const site = request.headers["sec-fetch-site"];
  if (api && site !== undefined && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "forbidden_site", "Cross-site requests are not allowed.");
  }
}

/** Only reads are routed; anything else is refused before any Git process runs. */
export function checkMethod(method: string, pathname: string): void {
  if (method === "GET" || method === "HEAD") return;
  if (method === "POST" && /^\/v1\/repositories\/[^/]+\/(compare|diff)$/.test(pathname)) return;
  throw new HttpError(405, "method_not_allowed", "This viewer is read-only.");
}

function send(response: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string>): void {
  response.statusCode = status;
  for (const [key, value] of Object.entries({ ...SECURITY_HEADERS, ...headers })) response.setHeader(key, value);
  response.end(body);
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  send(response, status, JSON.stringify(body), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof HttpError) {
    if (error.status === 405) response.setHeader("allow", "GET, HEAD");
    sendJson(response, { error: { code: error.code, message: error.message } }, error.status);
    return;
  }
  if (error instanceof GitGraphProtocolError) {
    sendJson(response, error.toJSON(), ERROR_STATUS[error.code] ?? 500);
    return;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    response.destroy();
    return;
  }
  sendJson(response, { error: { code: "internal_error", message: "Internal server error." } }, 500);
}

function publicEntry(entry: RepoEntry) {
  return {
    id: entry.id,
    name: entry.name,
    displayPath: entry.displayPath,
    bare: entry.bare,
    linkedWorktree: entry.linkedWorktree,
    ...(entry.mainId ? { mainId: entry.mainId } : {}),
    ...(entry.branch ? { branch: entry.branch } : {})
  };
}

/** Aborts when the client goes away, so a cancelled search stops its Git process. */
function requestSignal(request: IncomingMessage, response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  request.on("aborted", () => controller.abort());
  return controller.signal;
}

export type AppHandler = ((request: IncomingMessage, response: ServerResponse) => Promise<void>) & {
  /** Stops every repository watcher (on shutdown). */
  dispose(): void;
};

export function createApp(context: AppContext): AppHandler {
  const { registry, backend, git } = context;
  const watchHub = context.watchHub ?? new WatchHub(git);
  const startedAt = new Date().toISOString();
  const v1 = createGitGraphNodeHandler({ backend, maxRequestBytes: 16_000 });
  const staticRoot = normalize(context.staticDir);

  async function repository(id: string): Promise<RepoEntry> {
    const entry = await registry.get(decodeURIComponent(id));
    if (!entry) throw new GitGraphProtocolError("repository_not_found", "This repository is not available.");
    return entry;
  }

  async function serveStatic(pathname: string, method: string, response: ServerResponse): Promise<void> {
    const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    if (relativePath.includes("\0") || relativePath.split("/").some((part) => part.startsWith("."))) {
      throw new HttpError(404, "not_found", "Not found.");
    }
    const filePath = normalize(join(staticRoot, relativePath));
    if (!filePath.startsWith(staticRoot + sep)) throw new HttpError(404, "not_found", "Not found.");
    let real: string;
    try {
      real = await realpath(filePath);
      if (!real.startsWith((await realpath(staticRoot)) + sep) || !(await stat(real)).isFile()) throw new Error();
    } catch {
      throw new HttpError(404, "not_found", "Not found.");
    }
    const body = await readFile(real);
    const type = CONTENT_TYPES[extname(real)] ?? "application/octet-stream";
    send(response, 200, method === "HEAD" ? Buffer.alloc(0) : body, {
      "content-type": type,
      "cache-control": "no-cache"
    });
  }

  async function events(entry: RepoEntry, request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.statusCode = 200;
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(key, value);
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
    const write = (event: string, data: unknown) => {
      if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // The page may leave (switching repository) before the subscription is ready:
    // listen for that first, so a watcher is never left running for nobody.
    let closed = false;
    let release: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const close = () => {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      release?.();
      release = undefined;
    };
    request.on("close", close);
    response.on("close", close);
    const subscription = await watchHub.subscribe(entry, (change) => write("change", change));
    // The client may also have gone before this function ran at all ("close" already fired).
    if (closed || request.destroyed || response.destroyed || !response.socket || response.socket.destroyed) {
      subscription.unsubscribe();
      return;
    }
    release = subscription.unsubscribe;
    write("ready", { state: subscription.state, retry: 2000 });
    heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": keep-alive\n\n");
    }, context.heartbeatMs ?? 25_000);
  }

  const handle = async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    let pathname = "/";
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
      pathname = url.pathname;
      checkRequest(request, pathname);
      checkMethod(method, pathname);

      if (pathname.startsWith("/v1/")) {
        for (const [key, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(key, value);
        await v1(request, response);
        return;
      }

      if (pathname === "/api/health") {
        sendJson(response, { app: APP_NAME, version: context.version, pid: process.pid, port: context.config.port, startedAt });
        return;
      }
      if (pathname === "/api/repos") {
        const entries = await registry.list({ force: url.searchParams.get("rescan") === "1" });
        sendJson(response, {
          repositories: entries.map(publicEntry),
          roots: context.config.roots.map((root) => ({ path: root.path, depth: root.depth })),
          scannedAt: new Date(registry.scannedAt).toISOString()
        });
        return;
      }
      const match = /^\/api\/repos\/([^/]+)\/(info|worktree|worktree\/diff|search|events)$/.exec(pathname);
      if (match) {
        const entry = await repository(match[1]!);
        const action = match[2];
        const signal = requestSignal(request, response);
        if (action === "info") {
          const info = await backend.info(entry.id, signal);
          sendJson(response, { ...info, repository: publicEntry(info.repository) });
        } else if (action === "worktree") {
          sendJson(response, await readWorktreeStatus(git, entry, signal));
        } else if (action === "worktree/diff") {
          const context = Number(url.searchParams.get("context") ?? 3);
          sendJson(
            response,
            await readWorktreeDiff(
              git,
              entry,
              url.searchParams.get("section") ?? "",
              url.searchParams.get("path") ?? "",
              Number.isFinite(context) ? context : 3,
              signal
            )
          );
        } else if (action === "search") {
          const limit = Number(url.searchParams.get("limit") ?? 200);
          sendJson(
            response,
            await searchCommits(git, entry, url.searchParams.get("q") ?? "", {
              limit: Number.isFinite(limit) ? limit : 200,
              signal
            })
          );
        } else {
          await events(entry, request, response);
        }
        return;
      }
      if (pathname.startsWith("/api/")) throw new HttpError(404, "not_found", "Unknown API route.");
      await serveStatic(pathname, method, response);
    } catch (error) {
      sendError(response, error);
    }
  };
  return Object.assign(handle, { dispose: () => watchHub.closeAll() });
}
