// Starts the viewer on a synthetic demo history (for manual checks and screenshots).
// Usage: node scripts/demo-server.ts [port]
import { Fixture } from "../test/helpers/fixture.ts";
import { createDemoRepos } from "../test/helpers/demo.ts";
import { normalizeConfig } from "../server/config.ts";
import { startServer } from "../server/main.ts";

const fixture = new Fixture("hgg-demo-");
const demo = createDemoRepos(fixture);
const port = Number(process.argv[2] ?? 3021);
const started = await startServer(normalizeConfig({ port, roots: [{ path: fixture.root, depth: 2 }] }));
console.log(`demo viewer on ${started.url} (fixture ${fixture.root})`);
console.log(JSON.stringify({ alpha: demo.alpha, worktree: demo.worktree }));
const stop = () => void started.close().then(() => { fixture.dispose(); process.exit(0); });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
