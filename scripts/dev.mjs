// Development: rebuilds the page on change and restarts the server on change.
// Uses HGG_PORT (default 3022) so it never collides with the normal instance.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, HGG_PORT: process.env.HGG_PORT ?? "3022" };
const children = [
  spawn(process.execPath, [join(root, "scripts", "build.mjs"), "--watch"], { stdio: "inherit", env }),
  spawn(process.execPath, ["--watch-path=server", join(root, "server", "main.ts")], { cwd: root, stdio: "inherit", env })
];
const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
