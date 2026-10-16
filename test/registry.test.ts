import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeConfig } from "../server/config.ts";
import { applyReadOnlyGitEnvironment } from "../server/git-env.ts";
import { GitRunner } from "../server/git.ts";
import { RepoRegistry } from "../server/registry.ts";
import { Fixture } from "./helpers/fixture.ts";

describe("repository discovery", () => {
  const fixture = new Fixture();
  let root: string;

  before(() => {
    applyReadOnlyGitEnvironment();
    root = join(fixture.root, "root");
    mkdirSync(root);
    for (const path of ["root/a", "root/group/b", "root/group/deeper/c", "root/one/two/three/d"]) {
      const repo = fixture.init(path);
      fixture.commit(repo, `first in ${path}`);
    }
    // Places a scan must not descend into or must not trust.
    fixture.commit(fixture.init("root/node_modules/pkg"), "dependency checkout");
    fixture.commit(fixture.init("root/.hidden/e"), "hidden");
    mkdirSync(join(root, "fake"), { recursive: true });
    writeFileSync(join(root, "fake", ".git"), "gitdir: /nonexistent/place\n");
    // A repository nested inside another checkout.
    fixture.commit(fixture.init("root/a/vendor-clone"), "nested");
    // A linked worktree outside the root, and a bare repository listed explicitly.
    const a = join(root, "a");
    fixture.git(a, ["worktree", "add", "-q", "-b", "side", join(fixture.root, "elsewhere", "a-side")]);
    fixture.git(fixture.root, ["init", "-q", "--bare", join(fixture.root, "store.git")]);
  });

  after(() => fixture.dispose());

  const scan = (config: Parameters<typeof normalizeConfig>[0]) =>
    new RepoRegistry(normalizeConfig(config), new GitRunner()).list({ force: true });

  it("finds checkouts down to the configured depth only", async () => {
    const shallow = await scan({ roots: [{ path: root, depth: 2 }] });
    assert.deepEqual(shallow.filter((entry) => !entry.linkedWorktree).map((entry) => entry.name), ["a", "b"]);
    const deep = await scan({ roots: [{ path: root, depth: 4 }] });
    assert.deepEqual(deep.filter((entry) => !entry.linkedWorktree).map((entry) => entry.name).sort(), ["a", "b", "c", "d"]);
  });

  it("skips node_modules, hidden folders, nested checkouts and a stray .git that is not a repository", async () => {
    const names = (await scan({ roots: [{ path: root, depth: 4 }] })).map((entry) => entry.name);
    for (const name of ["pkg", "e", "fake", "vendor-clone"]) assert.ok(!names.includes(name), name);
  });

  it("recognises linked worktrees through git, even outside the roots, and links them to their checkout", async () => {
    const entries = await scan({ roots: [{ path: root, depth: 2 }] });
    const main = entries.find((entry) => entry.name === "a")!;
    const side = entries.find((entry) => entry.name === "a-side")!;
    assert.ok(side, "the linked worktree is listed");
    assert.equal(side.linkedWorktree, true);
    assert.equal(side.mainId, main.id);
    assert.equal(side.branch, "side");
    assert.equal(side.commonDir, main.commonDir);
    const without = await scan({ roots: [{ path: root, depth: 2 }], includeLinkedWorktrees: false });
    assert.ok(!without.some((entry) => entry.name === "a-side"));
  });

  it("lists explicit repositories, including bare ones, and ignores missing ones", async () => {
    const entries = await scan({ roots: [], repositories: [join(fixture.root, "store.git"), join(fixture.root, "missing")] });
    assert.deepEqual(entries.map((entry) => [entry.name, entry.bare]), [["store.git", true]]);
  });

  it("stops after the configured number of directories", async () => {
    const entries = await scan({ roots: [{ path: root, depth: 4 }], maxScanEntries: 2 });
    assert.ok(entries.filter((entry) => !entry.linkedWorktree).length <= 1);
  });

  it("gives every repository a stable id", async () => {
    const first = await scan({ roots: [{ path: root, depth: 2 }] });
    const second = await scan({ roots: [{ path: root, depth: 2 }] });
    assert.deepEqual(first.map((entry) => entry.id), second.map((entry) => entry.id));
    assert.match(first[0]!.id, /^[a-z0-9._-]+-[0-9a-f]{8}$/);
  });
});
