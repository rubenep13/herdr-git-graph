import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitGraphChange, GitGraphCommitDetails, GitGraphPage } from "@web-git-graph/protocol";
import { Fixture } from "./helpers/fixture.ts";
import { createDemoRepos, type DemoRepos } from "./helpers/demo.ts";
import { raw, startTestServer, type TestServer } from "./helpers/http.ts";

/** Every file under `dir` (including .git) with its content hash, size and mtime. */
function snapshot(dir: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (path: string) => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        result.set(`${full}/`, `dir ${stat.mtimeMs}`);
        walk(full);
      } else if (stat.isSymbolicLink()) {
        result.set(full, `link ${readlinkSync(full)}`);
      } else {
        result.set(full, `${createHash("sha256").update(readFileSync(full)).digest("hex")} ${stat.size} ${stat.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return result;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [path, value] of before) if (after.get(path) !== value) changes.push(`changed or removed: ${path}`);
  for (const path of after.keys()) if (!before.has(path)) changes.push(`added: ${path}`);
  return changes;
}

/**
 * Plants traps a writing Git command would trip: a tracked file whose stat
 * information no longer matches the index (a plain `git status` refreshes and
 * rewrites .git/index), an fsmonitor hook and hooks that leave marker files.
 */
function armTraps(fixture: Fixture, repo: string, markers: string): void {
  mkdirSync(markers, { recursive: true });
  const hooks = join(fixture.root, "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const hook of ["post-index-change", "pre-commit", "post-checkout", "reference-transaction"]) {
    const path = join(hooks, hook);
    writeFileSync(path, `#!/bin/sh\ntouch "${markers}/${hook}"\n`);
    chmodSync(path, 0o755);
  }
  const fsmonitor = join(fixture.root, "fsmonitor-hook");
  writeFileSync(fsmonitor, `#!/bin/sh\ntouch "${markers}/fsmonitor"\nexit 1\n`);
  chmodSync(fsmonitor, 0o755);
  fixture.git(repo, ["config", "core.hooksPath", hooks]);
  fixture.git(repo, ["config", "core.fsmonitor", fsmonitor]);
  const future = new Date(Date.now() + 3_600_000);
  utimesSync(join(repo, "README.md"), future, future);
}

describe("the server never writes to the repositories it shows", () => {
  const fixture = new Fixture();
  let demo: DemoRepos;
  let server: TestServer;
  let markers: string;

  before(async () => {
    demo = createDemoRepos(fixture, { mainCommits: 120 });
    markers = join(fixture.root, "markers");
    armTraps(fixture, demo.alpha, markers);
    server = await startTestServer({ roots: [{ path: fixture.root, depth: 3 }] });
  });

  after(async () => {
    await server?.close();
    fixture.dispose();
  });

  it("control: a plain git status in a copy does trip the traps", () => {
    const copy = join(fixture.root, "control-copy");
    cpSync(demo.alpha, copy, { recursive: true, verbatimSymlinks: true });
    const index = join(copy, ".git", "index");
    const before = readFileSync(index);
    execFileSync("git", ["-C", copy, "status", "--porcelain"], { env: { ...fixture.env() }, stdio: "ignore" });
    const tripped = !readFileSync(index).equals(before) || existsSync(join(markers, "fsmonitor")) || existsSync(join(markers, "post-index-change"));
    assert.ok(tripped, "a plain git status rewrites the index or runs a hook here, so the real check below is meaningful");
    execFileSync("rm", ["-rf", copy, markers]);
    mkdirSync(markers);
  });

  it("serves every read route without changing a byte of the repository, its worktree or refs", async () => {
    const repoBefore = snapshot(demo.alpha);
    const worktreeBefore = snapshot(demo.worktree);
    const refsBefore = fixture.git(demo.alpha, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const headBefore = fixture.git(demo.alpha, ["rev-parse", "HEAD"]);
    const get = async <T>(path: string): Promise<T> => {
      const response = await raw(server.port, path, { headers: server.auth });
      assert.equal(response.status, 200, `${path}: ${response.body.slice(0, 200)}`);
      return response.json<T>();
    };
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const response = await raw(server.port, path, { method: "POST", headers: { "content-type": "application/json", ...server.auth }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, `${path}: ${response.body.slice(0, 200)}`);
      return response.json<T>();
    };

    const repos = await get<{ repositories: Array<{ id: string; name: string }> }>("/api/repos?rescan=1");
    for (const repo of repos.repositories) {
      await get(`/api/repos/${repo.id}/info`);
      if (repo.name !== "empty") await get(`/v1/repositories/${repo.id}/history?limit=50`);
    }
    const alpha = repos.repositories.find((repo) => repo.name === "alpha")!;
    const id = alpha.id;
    let cursor: string | undefined;
    const commits: GitGraphPage["commits"][number][] = [];
    do {
      const page: GitGraphPage = await get(`/v1/repositories/${id}/history?limit=40${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      commits.push(...page.commits);
      cursor = page.cursor;
    } while (cursor);
    const merge = commits.find((commit) => commit.parents.length > 1)!;
    const root = commits.find((commit) => commit.parents.length === 0)!;
    for (const commit of [commits[0]!, merge, root]) {
      const details = await get<GitGraphCommitDetails>(`/v1/repositories/${id}/commits/${commit.oid}`);
      const base = commit.parents[0] ? { kind: "commit", oid: commit.parents[0] } : { kind: "commit", oid: "__EMPTY_TREE__" };
      for (const change of details.changes.slice(0, 3) as GitGraphChange[]) {
        await post(`/v1/repositories/${id}/diff`, { base, head: { kind: "commit", oid: commit.oid }, path: change.path });
      }
    }
    await post(`/v1/repositories/${id}/compare`, { base: { kind: "commit", oid: merge.parents[1] }, head: { kind: "commit", oid: merge.oid } });
    const status = await get<Record<"staged" | "unstaged" | "untracked" | "conflicted", Array<{ path: string }>>>(`/api/repos/${id}/worktree`);
    for (const section of ["staged", "unstaged", "untracked"] as const) {
      assert.ok(status[section].length, `the fixture has ${section} changes`);
      for (const file of status[section]) {
        await get(`/api/repos/${id}/worktree/diff?section=${section}&path=${encodeURIComponent(file.path)}`);
      }
    }
    await get(`/api/repos/${id}/search?q=change`);
    await get(`/api/repos/${id}/search?q=grace`);
    // The change stream runs the watcher's status checks while open.
    const events = await raw(server.port, `/api/repos/${id}/events?s=${server.session}`, { timeoutMs: 2_500 }).catch(() => undefined);
    void events;

    assert.deepEqual(diffSnapshots(repoBefore, snapshot(demo.alpha)), []);
    assert.deepEqual(diffSnapshots(worktreeBefore, snapshot(demo.worktree)), []);
    assert.equal(fixture.git(demo.alpha, ["for-each-ref", "--format=%(refname) %(objectname)"]), refsBefore);
    assert.equal(fixture.git(demo.alpha, ["rev-parse", "HEAD"]), headBefore);
    assert.deepEqual(existsSync(markers) ? readdirSync(markers) : [], [], "no hook or fsmonitor ran");
  });
});
