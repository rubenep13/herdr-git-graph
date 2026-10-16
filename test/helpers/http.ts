import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSecret, makeTicket, sessionFor } from "../../server/auth.ts";
import { normalizeConfig, PROJECT_DIR, type AppConfig } from "../../server/config.ts";
import { startServer, type StartedServer } from "../../server/main.ts";

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = unknown>(): T;
}

/** A plain HTTP request with full control over Host, Origin and the raw path. */
export function raw(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}
): Promise<RawResponse> {
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...(options.headers ?? {}) },
        timeout: options.timeoutMs ?? 30_000
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolveResponse({ status: res.statusCode ?? 0, headers: res.headers, body, json: <T>() => JSON.parse(body) as T });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timeout ${path}`)));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export interface TestServer extends StartedServer {
  port: number;
  config: AppConfig;
  /** The session token of this server's secret. */
  session: string;
  /** `Authorization` header carrying that session. */
  auth: Record<string, string>;
  /** A fresh one-time login ticket, as `hgg` makes. */
  ticket(now?: number): string;
}

/** Starts a server with its own secret in a temporary folder — never the real `.run/token`. */
export async function startTestServer(config: Partial<AppConfig>): Promise<TestServer> {
  const secretDir = mkdtempSync(join(tmpdir(), "hgg-secret-"));
  const tokenFile = join(secretDir, "token");
  const normalized = normalizeConfig({ port: 3999, tokenFile, ...config });
  const started = await startServer(normalized, { port: 0, staticDir: join(PROJECT_DIR, "dist", "public") });
  const address = started.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const secret = () => ensureSecret(normalized.tokenFile);
  const session = normalized.auth ? sessionFor(secret()) : "";
  return {
    ...started,
    port,
    config: normalized,
    session,
    auth: session ? { authorization: `Bearer ${session}` } : {},
    ticket: (now?: number) => makeTicket(secret(), now),
    close: async () => {
      await started.close();
      rmSync(secretDir, { recursive: true, force: true });
    }
  };
}
