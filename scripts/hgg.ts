// hgg — runs and opens this viewer. Only ever touches its own server process.
//   hgg [open] [--no-focus] | start | stop | restart | status | url | rotate-token | logs [-f] | launchd-plist
//   With no command it opens the viewer (the everyday use from a Herdr tab).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME, PROJECT_DIR, loadConfig } from "../server/config.ts";
import { ensureSecret, makeTicket, newSecret } from "../server/auth.ts";

const RUN_DIR = join(PROJECT_DIR, ".run");
const PID_FILE = join(RUN_DIR, "server.pid");
const LOG_FILE = join(RUN_DIR, "server.log");
const LOCK_DIR = join(RUN_DIR, "start.lock");
const LAUNCHD_LABEL = "local.herdr-git-graph";
const SHIM = join(homedir(), ".local", "state", "herdr", "gpui", "bin", "herdr-gpui");

const config = loadConfig();
const url = `http://localhost:${config.port}/`;

/** The page URL with a one-time login ticket in the fragment (never sent to the server or a Referer). */
function loginUrl(): string {
  return config.auth ? `${url}#t=${makeTicket(ensureSecret(config.tokenFile))}` : url;
}

interface Health {
  app: string;
  pid: number;
  version: string;
  port: number;
  startedAt: string;
}

async function health(): Promise<Health | "other" | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
      signal: AbortSignal.timeout(1500),
      headers: { host: `127.0.0.1:${config.port}` }
    });
    const body = (await response.json().catch(() => undefined)) as Health | undefined;
    return body?.app === APP_NAME ? body : "other";
  } catch (error) {
    // Something answers on the port but is not this viewer.
    return (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED" ? undefined : "other";
  }
}

function launchdLoaded(): boolean {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("launchctl", ["print", `gui/${process.getuid?.()}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
  return result.status === 0;
}

function readPid(): number | undefined {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** True only for a live process running this project's server. */
function isOurServer(pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return command.includes(join(PROJECT_DIR, "server", "main.ts"));
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((wake) => setTimeout(wake, ms));

async function status(): Promise<number> {
  const state = await health();
  if (state && state !== "other") {
    console.log(`running: ${url} (pid ${state.pid}, since ${state.startedAt}${launchdLoaded() ? ", managed by launchd" : ""})`);
    return 0;
  }
  if (state === "other") {
    console.log(`port ${config.port} is used by another program; change "port" in config.json or HGG_PORT.`);
    return 2;
  }
  console.log(`stopped (port ${config.port})`);
  return 3;
}

async function start(): Promise<number> {
  const state = await health();
  if (state && state !== "other") {
    console.log(`already running: ${url} (pid ${state.pid})`);
    return 0;
  }
  if (state === "other") {
    console.error(`port ${config.port} is used by another program; not starting a second server there.`);
    return 2;
  }
  if (launchdLoaded()) {
    spawnSync("launchctl", ["kickstart", `gui/${process.getuid?.()}/${LAUNCHD_LABEL}`], { stdio: "inherit" });
    return waitUp();
  }
  if (!existsSync(join(PROJECT_DIR, "dist", "public", "index.html"))) {
    console.error("the page is not built yet: run `npm run build` first.");
    return 1;
  }
  mkdirSync(RUN_DIR, { recursive: true });
  try {
    if (existsSync(LOCK_DIR) && Date.now() - statSync(LOCK_DIR).mtimeMs > 30_000) rmSync(LOCK_DIR, { recursive: true, force: true });
    mkdirSync(LOCK_DIR);
  } catch {
    console.log("another `hgg start` is in progress; waiting for it.");
    return waitUp();
  }
  try {
    const log = openSync(LOG_FILE, "a");
    // Detached in its own session: it outlives the terminal or Herdr pane that started it.
    const child = spawn(process.execPath, [join(PROJECT_DIR, "server", "main.ts")], {
      cwd: PROJECT_DIR,
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env
    });
    closeSync(log);
    child.unref();
    writeFileSync(PID_FILE, `${child.pid}\n`);
    return await waitUp();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

async function waitUp(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await health();
    if (state && state !== "other") {
      console.log(`running: ${url} (pid ${state.pid})`);
      return 0;
    }
    await sleep(250);
  }
  console.error(`the server did not answer; see ${LOG_FILE}`);
  return 1;
}

async function stop(): Promise<number> {
  if (launchdLoaded()) {
    console.error(`managed by launchd (${LAUNCHD_LABEL}); it would restart. Unload it with:\n  launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`);
    return 1;
  }
  const state = await health();
  const pid = state && state !== "other" ? state.pid : readPid();
  if (!pid || !isOurServer(pid)) {
    rmSync(PID_FILE, { force: true });
    console.log("not running");
    return 0;
  }
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 40 && isOurServer(pid); attempt += 1) await sleep(100);
  rmSync(PID_FILE, { force: true });
  console.log(`stopped (pid ${pid})`);
  return 0;
}

/**
 * Asks Herdr UI to open the page. Run from a pane of a workspace on this Mac,
 * Herdr's own `herdr-gpui` shim forwards localhost:PORT to the machine Herdr
 * UI runs on and opens it there; no ssh -L is involved.
 */
async function open(args: string[]): Promise<number> {
  const started = await start();
  if (started !== 0) return started;
  const herdrGpui = existsSync(SHIM) ? SHIM : "herdr-gpui";
  if (!process.env.HERDR_WORKSPACE_ID) {
    console.log(`not inside a Herdr pane, so Herdr cannot open it. Open this one-time link yourself (valid 2 minutes):\n${loginUrl()}`);
    return 0;
  }
  const result = spawnSync(herdrGpui, ["browser", "open", ...args.filter((arg) => arg === "--no-focus"), loginUrl()], { stdio: "inherit" });
  if (result.error) {
    console.error(`could not run ${herdrGpui}: ${result.error.message}. Open ${url} through Herdr's "Forward port…" instead.`);
    return 1;
  }
  if (result.status === 0) {
    console.log("If no page appears within a minute: the Herdr UI window must be connected to this host; run `hgg open` again, or use the host menu > Forward port… " + config.port);
  }
  return result.status ?? 1;
}

/** The `node` found on PATH (e.g. Homebrew's stable symlink), so upgrades do not break the agent. */
function stableNode(): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (directory && existsSync(join(directory, "node"))) return join(directory, "node");
  }
  return process.execPath;
}

function launchdPlist(): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(stableNode())}</string>
    <string>${escape(join(PROJECT_DIR, "server", "main.ts"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${escape(PROJECT_DIR)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escape(join(RUN_DIR, "launchd.log"))}</string>
  <key>StandardErrorPath</key><string>${escape(join(RUN_DIR, "launchd.log"))}</string>
</dict>
</plist>
`;
}

const given = process.argv.slice(2);
const [command = "open", ...args] = given[0]?.startsWith("-") ? ["open", ...given] : given;
let code = 0;
switch (command) {
  case "start":
    code = await start();
    break;
  case "stop":
    code = await stop();
    break;
  case "restart":
    code = await stop();
    if (code === 0) code = await start();
    break;
  case "status":
    code = await status();
    break;
  case "open":
    code = await open(args);
    break;
  case "url":
    // A one-time link, valid for two minutes: for opening the viewer in another browser.
    console.log(loginUrl());
    break;
  case "rotate-token": {
    // A new secret ends every browser session; the running server picks it up by itself.
    ensureSecret(config.tokenFile);
    writeFileSync(config.tokenFile, `${newSecret()}\n`, { mode: 0o600 });
    console.log(`new secret written to ${config.tokenFile}; every browser needs \`hgg\` again.`);
    break;
  }
  case "logs":
    spawnSync("tail", [args.includes("-f") ? "-f" : "-n", ...(args.includes("-f") ? [] : ["100"]), LOG_FILE], { stdio: "inherit" });
    break;
  case "launchd-plist":
    process.stdout.write(launchdPlist());
    break;
  default:
    console.error("usage: hgg [open] [--no-focus] | start | stop | restart | status | url | rotate-token | logs [-f] | launchd-plist");
    code = 2;
}
process.exit(code);
