import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyReadOnlyGitEnvironment } from "./git-env.ts";
import { APP_NAME, PROJECT_DIR, loadConfig, type AppConfig } from "./config.ts";
import { GitRunner } from "./git.ts";
import { RepoRegistry } from "./registry.ts";
import { ViewerBackend } from "./backend.ts";
import { createApp } from "./http.ts";

export interface StartedServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startServer(config: AppConfig, options: { staticDir?: string; port?: number } = {}): Promise<StartedServer> {
  applyReadOnlyGitEnvironment();
  const version = (JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf8")) as { version: string }).version;
  const git = new GitRunner();
  const registry = new RepoRegistry(config, git);
  const backend = new ViewerBackend({ registry, git });
  const handler = createApp({
    config,
    registry,
    backend,
    git,
    version,
    staticDir: options.staticDir ?? join(PROJECT_DIR, "dist", "public")
  });
  const server = createServer((request, response) => void handler(request, response));
  server.keepAliveTimeout = 30_000;
  const port = options.port ?? config.port;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, config.host, () => resolveListen());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  void registry.list();
  return {
    server,
    url: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${actualPort}/`,
    close: () =>
      new Promise<void>((resolveClose) => {
        handler.dispose();
        server.closeAllConnections();
        server.close(() => resolveClose());
      })
  };
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(78);
  }
  try {
    const started = await startServer(config);
    console.log(`${APP_NAME} listening on ${started.url} (pid ${process.pid})`);
    console.log(`roots: ${config.roots.map((root) => `${root.path} (depth ${root.depth})`).join(", ")}`);
    const stop = (signal: string) => {
      console.log(`${signal}: stopping`);
      void started.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 2_000).unref();
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      console.error(`Port ${config.port} on ${config.host} is already in use.`);
      process.exit(2);
    }
    throw error;
  }
}

if (import.meta.main) await main();
