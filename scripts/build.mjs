// Bundles the page into dist/public: app.js (with layoutGitGraph from
// @web-git-graph/web, tree-shaken), app.css and index.html. No network, no CDN.
import { build, context } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "public");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [join(root, "web", "main.ts")],
  outfile: join(out, "app.js"),
  bundle: true,
  format: "esm",
  target: ["chrome111", "firefox113", "safari16.4"],
  sourcemap: "linked",
  minify: !watch,
  legalComments: "linked",
  logLevel: "info"
};

async function copyStatic() {
  await copyFile(join(root, "web", "index.html"), join(out, "index.html"));
  await copyFile(join(root, "web", "styles.css"), join(out, "app.css"));
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyStatic();
if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{ name: "static", setup: (b) => b.onEnd(() => copyStatic()) }]
  });
  await ctx.watch();
} else {
  await build(options);
}
