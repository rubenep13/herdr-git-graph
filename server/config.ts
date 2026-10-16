import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const APP_NAME = "herdr-git-graph";

export interface RootConfig {
  /** Directory scanned for repositories. `~` expands to the home directory. */
  path: string;
  /** How many directory levels below `path` are scanned. */
  depth: number;
}

export interface AppConfig {
  host: string;
  port: number;
  roots: RootConfig[];
  /** Extra repositories (or bare repositories) listed explicitly. */
  repositories: string[];
  /** Also list linked worktrees registered by an allowed repository. */
  includeLinkedWorktrees: boolean;
  /** Directory names never descended into while scanning roots. */
  skipDirectories: string[];
  /** Upper bound of directories visited per scan, across all roots. */
  maxScanEntries: number;
  pageSize: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const DEFAULT_CONFIG: AppConfig = {
  host: "127.0.0.1",
  port: 3020,
  roots: [{ path: "~/Devs", depth: 3 }],
  repositories: [],
  includeLinkedWorktrees: true,
  skipDirectories: [
    "node_modules",
    "vendor",
    "dist",
    "build",
    "target",
    "venv",
    "Library",
    "Applications"
  ],
  maxScanEntries: 4000,
  pageSize: 300
};

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function defaultConfigPath(): string {
  return process.env.HGG_CONFIG ?? join(PROJECT_DIR, "config.json");
}

function fail(message: string): never {
  throw new Error(`Invalid configuration: ${message}`);
}

export function normalizeConfig(input: Partial<AppConfig>, baseDir = PROJECT_DIR): AppConfig {
  const config: AppConfig = { ...DEFAULT_CONFIG, ...input };
  if (!LOOPBACK_HOSTS.has(config.host)) {
    fail(`host must be a loopback address (127.0.0.1, ::1 or localhost), got ${JSON.stringify(config.host)}.`);
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    fail(`port must be an integer between 1024 and 65535, got ${JSON.stringify(config.port)}.`);
  }
  if (!Array.isArray(config.roots)) fail("roots must be a list.");
  const absolute = (path: string) => {
    const expanded = expandHome(path);
    return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
  };
  config.roots = config.roots.map((root) => {
    if (!root || typeof root.path !== "string" || !root.path) fail("every root needs a path.");
    const depth = root.depth ?? 3;
    if (!Number.isInteger(depth) || depth < 0 || depth > 8) fail(`root depth must be 0-8, got ${depth}.`);
    if (absolute(root.path) === "/") fail("the file system root cannot be a repository root.");
    return { path: absolute(root.path), depth };
  });
  if (!Array.isArray(config.repositories)) fail("repositories must be a list.");
  config.repositories = config.repositories.map((path) => absolute(path));
  config.pageSize = Math.min(500, Math.max(50, Math.trunc(config.pageSize)));
  config.maxScanEntries = Math.max(1, Math.trunc(config.maxScanEntries));
  return config;
}

export function loadConfig(path = defaultConfigPath()): AppConfig {
  let fromFile: Partial<AppConfig> = {};
  if (existsSync(path)) {
    try {
      fromFile = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
    } catch (error) {
      fail(`${path} is not valid JSON (${(error as Error).message}).`);
    }
  }
  const envPort = process.env.HGG_PORT ? Number(process.env.HGG_PORT) : undefined;
  return normalizeConfig({ ...fromFile, ...(envPort ? { port: envPort } : {}) }, dirname(path));
}
