import { request as httpRequest } from "node:http";
import { join } from "node:path";
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
}

export async function startTestServer(config: Partial<AppConfig>): Promise<TestServer> {
  const normalized = normalizeConfig({ port: 3999, ...config });
  const started = await startServer(normalized, { port: 0, staticDir: join(PROJECT_DIR, "dist", "public") });
  const address = started.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { ...started, port, config: normalized };
}
