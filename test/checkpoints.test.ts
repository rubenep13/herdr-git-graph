import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GitGraphCommit, GitGraphPage } from "@web-git-graph/protocol";
import { normalizeConfig } from "../server/config.ts";
import { applyReadOnlyGitEnvironment } from "../server/git-env.ts";
import { GitRunner } from "../server/git.ts";
import { RepoRegistry } from "../server/registry.ts";
import { ViewerBackend } from "../server/backend.ts";
import { searchCommits } from "../server/search.ts";
import { Fixture } from "./helpers/fixture.ts";

/**
 * main:     A ── B ── C ── M (main)
 *                 \       /
 *                  D ── E (feature)
 * checkpoints (refs/herdr-gpui/checkpoints/...):
 *   cp1 → X1 ── X2  (X1's parent is C; both exclusive to checkpoints)
 *   cp2 → D         (also reachable from feature and main)
 *   cp3 → A         (a shared ancestor)
 */
describe("Herdr checkpoints stay out of the history, untouched", () => {
  const fixture = new Fixture();
  let repo: string;
  const oids: Record<string, string> = {};
  let backend: ViewerBackend;
  let git: GitRunner;
  let registry: RepoRegistry;
  let refsBefore: string;

  before(async () => {
    repo = fixture.init("project");
    oids.A = fixture.commit(repo, "A: initial", { "a.txt": "a" });
    oids.B = fixture.commit(repo, "B: base", { "b.txt": "b" });
    fixture.git(repo, ["switch", "-q", "-c", "feature"]);
    oids.D = fixture.commit(repo, "D: feature start", { "d.txt": "d" });
    oids.E = fixture.commit(repo, "E: feature end", { "e.txt": "e" });
    fixture.git(repo, ["switch", "-q", "main"]);
    oids.C = fixture.commit(repo, "C: main work", { "c.txt": "c" });
    oids.M = fixture.merge(repo, ["feature"], "M: merge feature");
    oids.X1 = fixture.commitTree(repo, oids.C!, "Before claude's turn X1");
    oids.X2 = fixture.commitTree(repo, oids.X1!, "Before claude's turn X2");
    fixture.git(repo, ["update-ref", "refs/herdr-gpui/checkpoints/aaaa/0001", oids.X2!]);
    fixture.git(repo, ["update-ref", "refs/herdr-gpui/checkpoints/aaaa/0002", oids.D!]);
    fixture.git(repo, ["update-ref", "refs/herdr-gpui/checkpoints/bbbb/0001", oids.A!]);
    refsBefore = fixture.git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);

    applyReadOnlyGitEnvironment();
    git = new GitRunner();
    registry = new RepoRegistry(normalizeConfig({ roots: [{ path: fixture.root, depth: 2 }] }), git);
    backend = new ViewerBackend({ registry, git });
  });

  after(() => fixture.dispose());

  async function allPages(id: string, limit: number): Promise<{ commits: GitGraphCommit[]; pages: GitGraphPage[] }> {
    const pages: GitGraphPage[] = [];
    let cursor: string | undefined;
    do {
      const page = await backend.getHistory(id, { limit, ...(cursor ? { cursor } : {}) });
      pages.push(page);
      cursor = page.cursor;
    } while (cursor);
    return { commits: pages.flatMap((page) => [...page.commits]), pages };
  }

  it("fixture control: plain --all reaches the checkpoint-only commits, the documented exclusion does not", () => {
    const all = fixture.git(repo, ["rev-list", "--all"]).split("\n");
    assert.ok(all.includes(oids.X1!) && all.includes(oids.X2!));
    const excluded = fixture.git(repo, ["rev-list", "--exclude=refs/herdr-gpui/*", "--all"]).split("\n");
    assert.ok(!excluded.includes(oids.X1!) && !excluded.includes(oids.X2!));
    assert.ok(excluded.includes(oids.D!) && excluded.includes(oids.A!));
  });

  it("walks only branch, remote and tag tips, across every page", async () => {
    const [entry] = await registry.list();
    assert.ok(entry);
    for (const limit of [1, 2, 3, 500]) {
      const { commits, pages } = await allPages(entry.id, limit);
      const seen = new Set(commits.map((commit) => commit.oid));
      for (const name of ["A", "B", "C", "D", "E", "M"]) {
        assert.ok(seen.has(oids[name]!), `commit ${name} is shown (page size ${limit})`);
      }
      assert.ok(!seen.has(oids.X1!), `checkpoint-only X1 is hidden (page size ${limit})`);
      assert.ok(!seen.has(oids.X2!), `checkpoint-only X2 is hidden (page size ${limit})`);
      assert.equal(commits.length, 6, "each commit appears exactly once");
      for (const page of pages) {
        assert.ok(page.refs.every((ref) => !ref.name.startsWith("refs/herdr-gpui/")), "no checkpoint ref is listed");
      }
    }
  });

  it("keeps the commit a checkpoint shares with a branch, with its parents", async () => {
    const [entry] = await registry.list();
    const { commits } = await allPages(entry!.id, 500);
    const d = commits.find((commit) => commit.oid === oids.D);
    assert.ok(d, "D (reachable from feature and from a checkpoint) is shown");
    assert.deepEqual(d.parents, [oids.B]);
    const m = commits.find((commit) => commit.oid === oids.M);
    assert.deepEqual(m?.parents, [oids.C, oids.E], "the merge keeps both parents");
  });

  it("search ignores checkpoint-only commits", async () => {
    const [entry] = await registry.list();
    const result = await searchCommits(git, entry!, "Before claude");
    assert.equal(result.results.length, 0);
    const shared = await searchCommits(git, entry!, "feature start");
    assert.deepEqual(shared.results.map((item) => item.oid), [oids.D]);
  });

  it("counts the hidden refs and never changes them", async () => {
    const [entry] = await registry.list();
    const info = await backend.info(entry!.id);
    assert.equal(info.hiddenRefs, 3);
    await backend.getCommitDetails(entry!.id, { kind: "commit", oid: oids.D! });
    assert.equal(fixture.git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), refsBefore);
    assert.equal(fixture.git(repo, ["cat-file", "-t", oids.X2!]), "commit", "checkpoint objects still exist");
  });
});
