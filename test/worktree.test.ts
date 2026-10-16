import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeConfig } from "../server/config.ts";
import { applyReadOnlyGitEnvironment } from "../server/git-env.ts";
import { GitRunner } from "../server/git.ts";
import { RepoRegistry, type RepoEntry } from "../server/registry.ts";
import { ViewerBackend } from "../server/backend.ts";
import { searchCommits } from "../server/search.ts";
import { WatchHub, type RepoChange } from "../server/watch.ts";
import { createServer, request as httpRequest } from "node:http";
import { createApp } from "../server/http.ts";
import { parsePorcelainV2, readWorktreeDiff, readWorktreeStatus } from "../server/worktree.ts";
import { Fixture } from "./helpers/fixture.ts";

describe("working tree status and diffs", () => {
  const fixture = new Fixture();
  let git: GitRunner;
  let repo: string;
  let conflicted: string;
  let entries: RepoEntry[];

  before(async () => {
    applyReadOnlyGitEnvironment();
    git = new GitRunner();
    repo = fixture.init("work");
    fixture.commit(repo, "base", { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "old-name.txt": "rename me\n" });
    writeFileSync(join(repo, "a.txt"), "a staged\n");
    fixture.git(repo, ["add", "a.txt"]);
    writeFileSync(join(repo, "a.txt"), "a staged\nand then edited\n");
    writeFileSync(join(repo, "b.txt"), "b unstaged\n");
    fixture.git(repo, ["mv", "old-name.txt", "new name.txt"]);
    fixture.git(repo, ["rm", "-q", "c.txt"]);
    writeFileSync(join(repo, "fresh file.txt"), "brand new\n");

    conflicted = fixture.init("conflict");
    fixture.commit(conflicted, "base", { "x.txt": "base\n" });
    fixture.git(conflicted, ["switch", "-q", "-c", "other"]);
    fixture.commit(conflicted, "other side", { "x.txt": "other\n" });
    fixture.git(conflicted, ["switch", "-q", "main"]);
    fixture.commit(conflicted, "main side", { "x.txt": "main\n" });
    try {
      execFileSync("git", ["-C", conflicted, "merge", "other"], { env: fixture.env(), stdio: "ignore" });
    } catch {
      // The conflict is the point.
    }
    entries = await new RepoRegistry(normalizeConfig({ roots: [{ path: fixture.root, depth: 1 }] }), git).list({ force: true });
  });

  after(() => fixture.dispose());

  const entry = (name: string) => entries.find((item) => item.name === name)!;

  it("splits staged, unstaged and untracked changes; a file can be in both of the first two", async () => {
    const status = await readWorktreeStatus(git, entry("work"));
    assert.equal(status.branch, "main");
    assert.deepEqual(status.staged.map((file) => [file.status, file.path, file.previousPath ?? null]), [
      ["M", "a.txt", null],
      ["D", "c.txt", null],
      ["R", "new name.txt", "old-name.txt"]
    ]);
    assert.deepEqual(status.unstaged.map((file) => [file.status, file.path]), [["M", "a.txt"], ["M", "b.txt"]]);
    assert.deepEqual(status.untracked.map((file) => file.path), ["fresh file.txt"]);
    assert.deepEqual(status.conflicted, []);
  });

  it("shows each side of a file's change separately", async () => {
    const staged = await readWorktreeDiff(git, entry("work"), "staged", "a.txt");
    assert.match(staged.patch!, /\+a staged\n/);
    assert.doesNotMatch(staged.patch!, /and then edited/);
    const unstaged = await readWorktreeDiff(git, entry("work"), "unstaged", "a.txt");
    assert.match(unstaged.patch!, /\+and then edited/);
    const renamed = await readWorktreeDiff(git, entry("work"), "staged", "new name.txt");
    assert.match(renamed.patch!, /rename from old-name\.txt/);
    const untracked = await readWorktreeDiff(git, entry("work"), "untracked", "fresh file.txt");
    assert.match(untracked.patch!, /\+brand new/);
  });

  it("lists merge conflicts on their own", async () => {
    const status = await readWorktreeStatus(git, entry("conflict"));
    assert.deepEqual(status.conflicted.map((file) => file.path), ["x.txt"]);
    const diff = await readWorktreeDiff(git, entry("conflict"), "conflicted", "x.txt");
    assert.match(diff.patch!, /<<<<<<<|main/);
  });

  it("parses porcelain v2 headers and records", () => {
    const parsed = parsePorcelainV2(
      [
        "# branch.oid 1111111111111111111111111111111111111111",
        "# branch.head feature/x",
        "# branch.upstream origin/feature/x",
        "# branch.ab +2 -1",
        "1 .M N... 100644 100644 100644 aaa bbb path with spaces.txt",
        "2 R. N... 100644 100644 100644 aaa bbb R100 new.txt",
        "old.txt",
        "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
        "? untracked.txt",
        ""
      ].join("\0")
    );
    assert.equal(parsed.branch, "feature/x");
    assert.equal(parsed.upstream, "origin/feature/x");
    assert.deepEqual([parsed.ahead, parsed.behind], [2, 1]);
    assert.deepEqual(parsed.unstaged.map((file) => file.path), ["path with spaces.txt"]);
    assert.deepEqual(parsed.staged.map((file) => [file.path, file.previousPath]), [["new.txt", "old.txt"]]);
    assert.deepEqual(parsed.conflicted.map((file) => file.path), ["conflict.txt"]);
    assert.deepEqual(parsed.untracked.map((file) => file.path), ["untracked.txt"]);
  });
});

describe("search", () => {
  const fixture = new Fixture();
  let git: GitRunner;
  let repo: RepoEntry;
  const oids: Record<string, string> = {};

  before(async () => {
    applyReadOnlyGitEnvironment();
    git = new GitRunner();
    const path = fixture.init("searchable");
    oids.one = fixture.commit(path, "feat: add parser\n\nThe body mentions TOKENIZER details.");
    oids.two = fixture.commit(path, "fix: handle empty input", {}, { name: "Grace Hopper", email: "grace@navy.test" });
    fixture.git(path, ["switch", "-q", "-c", "side"]);
    oids.three = fixture.commit(path, "feat: side branch work");
    fixture.git(path, ["switch", "-q", "main"]);
    [repo] = await new RepoRegistry(normalizeConfig({ roots: [{ path: fixture.root, depth: 1 }] }), git).list({ force: true }) as [RepoEntry];
  });

  after(() => fixture.dispose());

  it("finds commits by message body, author, e-mail and hash prefix, on every branch", async () => {
    assert.deepEqual((await searchCommits(git, repo, "tokenizer")).results.map((result) => result.oid), [oids.one]);
    assert.deepEqual((await searchCommits(git, repo, "grace")).results.map((result) => result.oid), [oids.two]);
    assert.deepEqual((await searchCommits(git, repo, "navy.test")).results.map((result) => result.matched), [["author"]]);
    const byHash = await searchCommits(git, repo, oids.three!.slice(0, 8));
    assert.deepEqual(byHash.results.map((result) => [result.oid, result.matched.includes("hash")]), [[oids.three, true]]);
    assert.equal((await searchCommits(git, repo, "side branch")).results[0]?.subject, "feat: side branch work");
  });

  it("stops at the limit and says so", async () => {
    const limited = await searchCommits(git, repo, "e", { limit: 1 });
    assert.equal(limited.results.length, 1);
    assert.equal(limited.limited, true);
    await assert.rejects(searchCommits(git, repo, "   "), /1 to 200/);
  });
});

describe("refresh after terminal operations", () => {
  const fixture = new Fixture();
  let git: GitRunner;
  let path: string;
  let repo: RepoEntry;

  before(async () => {
    applyReadOnlyGitEnvironment();
    git = new GitRunner();
    path = fixture.init("watched");
    fixture.commit(path, "first", { "f.txt": "1" });
    [repo] = await new RepoRegistry(normalizeConfig({ roots: [{ path: fixture.root, depth: 1 }] }), git).list({ force: true }) as [RepoEntry];
  });

  after(() => fixture.dispose());

  const next = (changes: RepoChange[], count: number, timeoutMs = 8_000) =>
    new Promise<RepoChange>((resolveChange, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (changes.length >= count) {
          clearInterval(poll);
          resolveChange(changes[count - 1]!);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`no change #${count} within ${timeoutMs} ms`));
        }
      }, 50);
    });

  it("reports a working tree edit and a new commit separately, and stops watching when nobody listens", async () => {
    const hub = new WatchHub(git, { debounceMs: 100, minIntervalMs: 200, pollMs: 1_000 });
    const changes: RepoChange[] = [];
    const subscription = await hub.subscribe(repo, (change) => changes.push(change));
    assert.equal(hub.size, 1);

    writeFileSync(join(path, "f.txt"), "edited");
    const edit = await next(changes, 1);
    assert.deepEqual([edit.refs, edit.worktree], [false, true]);

    fixture.commit(path, "second", { "f.txt": "edited" });
    const commit = await next(changes, 2);
    assert.equal(commit.refs, true, "a commit moves the branch");

    subscription.unsubscribe();
    assert.equal(hub.size, 0);
    rmSync(join(path, "f.txt"));
    await new Promise((wait) => setTimeout(wait, 1_500));
    assert.equal(changes.length, 2, "no checks run after the last page left");
  });

  it("a page that leaves at once (switching repository) leaves no watcher behind", async () => {
    const config = normalizeConfig({ roots: [{ path: fixture.root, depth: 1 }] });
    const registry = new RepoRegistry(config, git);
    const watchHub = new WatchHub(git);
    const handler = createApp({ config, registry, backend: new ViewerBackend({ registry, git }), git, staticDir: fixture.root, version: "test", watchHub });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as { port: number }).port;
    const open = (abortAfterMs: number) =>
      new Promise<void>((done) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: `/api/repos/${repo.id}/events`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
          res.on("data", () => {});
          setTimeout(() => req.destroy(), abortAfterMs);
        });
        req.on("error", () => {});
        req.on("close", () => done());
        if (abortAfterMs === 0) setImmediate(() => req.destroy());
        req.end();
      });
    try {
      await Promise.all([open(0), open(0), open(50), open(0), open(1), open(5)]);
      await new Promise((wait) => setTimeout(wait, 400));
      assert.equal(watchHub.size, 0, "every watcher stopped once its page left");
    } finally {
      handler.dispose();
      server.closeAllConnections();
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("the backend pages a repository with an unborn branch as empty", async () => {
    const emptyPath = fixture.init("unborn");
    const registry = new RepoRegistry(normalizeConfig({ roots: [{ path: fixture.root, depth: 1 }] }), git);
    const backend = new ViewerBackend({ registry, git });
    const empty = (await registry.list({ force: true })).find((entry) => entry.path.endsWith("unborn"))!;
    assert.ok(emptyPath && empty);
    const info = await backend.info(empty.id);
    assert.equal(info.empty, true);
    const page = await backend.getHistory(empty.id, { limit: 10 });
    assert.deepEqual(page.commits, []);
  });
});
