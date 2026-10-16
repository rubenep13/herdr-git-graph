import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GitGraphCommit, GitGraphRef } from "@web-git-graph/protocol";
import { HistoryModel, WORKTREE_OID, buildRefChips, worktreeCommit } from "../web/model.ts";
import { fitChips, laneX, rowY, segmentPath } from "../web/geometry.ts";
import { filterRepositories } from "../web/filter.ts";
import { parsePatch } from "../web/diff.ts";
import { initials, relativeTime } from "../web/dom.ts";
import { splitMessage } from "../web/model.ts";

const c = (oid: string, ...parents: string[]): GitGraphCommit => ({ oid, parents, message: oid, kind: "commit" });

/** Endpoints of a segment as "lane@row" strings, to compare topology. */
const edges = (model: HistoryModel) =>
  model.layout.segments.map((segment) => `${segment.from.lane}@${segment.from.row}->${segment.to.lane}@${segment.to.row}`);

describe("reference labels", () => {
  const refs: GitGraphRef[] = [
    { name: "main", target: "m", kind: "current" },
    { name: "refs/heads/main", target: "m", kind: "head" },
    { name: "refs/remotes/origin/main", target: "m", kind: "remote" },
    { name: "refs/remotes/upstream/main", target: "m", kind: "remote" },
    { name: "refs/tags/v1.0.0", target: "m", kind: "tag" },
    { name: "refs/heads/zz-release", target: "m", kind: "head" },
    { name: "refs/remotes/origin/feature", target: "f", kind: "remote" },
    { name: "refs/heads/feature", target: "g", kind: "head" },
    { name: "stash@{0}", target: "s", kind: "stash" }
  ];

  it("groups every ref on a commit, current branch first, remotes of the same name folded in", () => {
    const chips = buildRefChips(refs);
    const main = chips.get("m")!;
    assert.deepEqual(main.map((chip) => chip.label), ["main", "zz-release", "v1.0.0"]);
    assert.equal(main[0]!.current, true);
    assert.deepEqual(main[0]!.remotes, ["origin", "upstream"]);
    assert.deepEqual(main[0]!.names, ["refs/heads/main", "refs/remotes/origin/main", "refs/remotes/upstream/main"]);
    assert.equal(main[2]!.kind, "tag");
  });

  it("keeps a remote branch that is not at its local branch's commit as its own label", () => {
    const chips = buildRefChips(refs);
    assert.deepEqual(chips.get("f")!.map((chip) => [chip.label, chip.kind, chip.remotes]), [["feature", "remote", ["origin"]]]);
    const other = buildRefChips([{ name: "refs/remotes/upstream/dev", target: "u", kind: "remote" }]);
    assert.deepEqual(other.get("u")!.map((chip) => chip.label), ["upstream/dev"], "a remote other than origin keeps its name");
    assert.deepEqual(chips.get("g")!.map((chip) => [chip.label, chip.current]), [["feature", false]]);
    assert.deepEqual(chips.get("s")!.map((chip) => chip.kind), ["stash"]);
  });

  it("marks a detached HEAD", () => {
    const chips = buildRefChips([{ name: "HEAD", target: "x", kind: "current" }, { name: "refs/tags/t", target: "x", kind: "tag" }]);
    assert.deepEqual(chips.get("x")!.map((chip) => [chip.label, chip.kind, chip.current]), [
      ["HEAD", "detached", true],
      ["t", "tag", false]
    ]);
  });

  it("fits labels in the column, skipping a long one and counting the rest in +N", () => {
    const badge = (n: number) => 10 + String(n).length * 7;
    assert.deepEqual(fitChips([60, 40], 200, badge), { shown: [0, 1], hidden: 0 });
    // The 400px name cannot fit; the tag after it still shows.
    assert.deepEqual(fitChips([60, 400, 40], 200, badge), { shown: [0, 2], hidden: 1 });
    // Not even the first fits: it shows alone, ellipsised, next to the badge.
    const tight = fitChips([300, 50], 120, badge);
    assert.deepEqual(tight.shown, [0]);
    assert.equal(tight.hidden, 1);
    assert.ok(tight.firstMaxWidth! < 120 && tight.firstMaxWidth! >= 24);
  });
});

describe("graph layout and drawing", () => {
  // Two branches, a merge, an octopus merge and a disconnected root.
  //   M (merge of A2 and B1)
  //   O (octopus of A1, C1, D1) ... see parents below
  const commits = [
    c("m", "a2", "b1"),
    c("b1", "a1"),
    c("a2", "o"),
    c("o", "a1", "c1", "d1"),
    c("d1", "a1"),
    c("c1", "a1"),
    c("a1", "root"),
    c("root"),
    c("orphan2", "orphan1"),
    c("orphan1")
  ];

  it("places one node per row and connects every parent edge to the parent's node", () => {
    const model = new HistoryModel(commits, []);
    assert.equal(model.layout.nodes.length, commits.length);
    model.layout.nodes.forEach((node, row) => assert.equal(node.row, row));
    for (const [row, commit] of commits.entries()) {
      for (const parent of commit.parents) {
        const parentRow = model.rowOf.get(parent)!;
        const parentNode = model.layout.nodes[parentRow]!;
        // Some segment ends at the parent's node (lane and row).
        const arrives = model.layout.segments.some((segment) => segment.to.row === parentRow && segment.to.lane === parentNode.lane);
        assert.ok(arrives, `edge ${commit.oid} -> ${parent} reaches the parent node (row ${row} -> ${parentRow})`);
      }
    }
    const octopus = model.layout.segments.filter((segment) => segment.from.row === model.rowOf.get("o") && segment.anchor === "from");
    assert.equal(octopus.length, 2, "the octopus merge opens a lane for each extra parent");
  });

  it("never draws two nodes at the same place", () => {
    const model = new HistoryModel(commits, []);
    const places = new Set(model.layout.nodes.map((node) => `${node.lane}@${node.row}`));
    assert.equal(places.size, commits.length);
  });

  it("is identical whether history arrives in one page or several (stable lanes while paging)", () => {
    const full = new HistoryModel(commits, []);
    for (const size of [1, 2, 3, 4]) {
      // Each page appended re-lays out the rows loaded so far, as the page does.
      for (let loaded = size; loaded < commits.length; loaded += size) {
        const partial = new HistoryModel(commits.slice(0, loaded), []);
        partial.layout.nodes.forEach((node, row) => {
          assert.deepEqual([node.lane, node.colour], [full.layout.nodes[row]!.lane, full.layout.nodes[row]!.colour], `row ${row} keeps its lane and colour with ${loaded} rows loaded`);
        });
        // Lanes still open at the end of the loaded window are drawn as dangling.
        const open = partial.layout.segments.filter((segment) => segment.dangling);
        for (const segment of open) assert.equal(segment.to.row, loaded);
      }
    }
  });

  it("puts the working tree row on top, attached to HEAD", () => {
    const rows = [worktreeCommit("a2", { staged: 1, unstaged: 2, untracked: 0, conflicted: 0 }), ...commits];
    const model = new HistoryModel(rows, [], "a2");
    assert.equal(model.rowOf.get(WORKTREE_OID), 0);
    assert.ok(edges(model).some((edge) => edge.endsWith(`@${model.rowOf.get("a2")}`)));
  });

  it("finds the segments crossing a window of rows", () => {
    const many = Array.from({ length: 300 }, (_, index) => c(`n${index}`, ...(index < 299 ? [`n${index + 1}`] : [])));
    many.unshift(c("top", "n299"));
    const model = new HistoryModel(many, []);
    const visible = model.segmentsBetween(150, 160);
    // The lane from "top" down to n299 passes the window; every row of it is drawn.
    const topLane = model.layout.nodes[0]!.lane;
    for (let row = 150; row < 160; row += 1) {
      assert.ok(
        visible.some((segment) => segment.from.lane === topLane && segment.from.row <= row && segment.to.row >= row + 1),
        `row ${row} of the long lane is included`
      );
    }
    assert.ok(visible.every((segment) => Math.max(segment.from.row, segment.to.row) >= 149 && Math.min(segment.from.row, segment.to.row) < 160));
    assert.ok(visible.length < 40, "only the window's segments are returned");
  });

  it("draws lanes as GitKraken does: straight down, right-angle turns with rounded corners on the node's row", () => {
    assert.equal(segmentPath({ from: { lane: 1, row: 2 }, to: { lane: 1, row: 3 }, colour: 0 }), `M ${laneX(1)} ${rowY(2)} L ${laneX(1)} ${rowY(3)}`);
    // Leaving a merge node: sideways on the merge's row, a rounded corner, then down the new lane.
    const out = segmentPath({ from: { lane: 0, row: 4 }, to: { lane: 2, row: 5 }, colour: 0, anchor: "from" });
    assert.match(out, new RegExp(`^M ${laneX(0)} ${rowY(4)} H [\\d.]+ A [\\d.]+ [\\d.]+ 0 0 1 ${laneX(2)} [\\d.]+ V ${rowY(5)}$`));
    // Arriving at the commit that absorbs a lane: down, a rounded corner, then sideways into the node.
    const late = segmentPath({ from: { lane: 2, row: 1 }, to: { lane: 0, row: 6 }, colour: 0, anchor: "to" });
    assert.match(late, new RegExp(`^M ${laneX(2)} ${rowY(1)} V [\\d.]+ A [\\d.]+ [\\d.]+ 0 0 1 [\\d.]+ ${rowY(6)} H ${laneX(0)}$`));
    // The horizontal run of a turn always lies on the row of the node it belongs to.
    assert.match(out, new RegExp(`^M [\\d.]+ ${rowY(4)} H`));
    assert.match(late, new RegExp(`H ${laneX(0)}$`));
  });
});

describe("repository picker filter", () => {
  const repos = [
    { id: "1", name: "icarus-api", displayPath: "~/Devs/icarus/icarus-api", branch: "dev" },
    { id: "2", name: "icarus_v3", displayPath: "~/Devs/icarus/icarus_v3", branch: "feat/shell" },
    { id: "3", name: "ssp-api", displayPath: "~/Devs/ssp/ssp-api", branch: "main" },
    { id: "4", name: "api-gateway", displayPath: "~/Devs/other/api-gateway", branch: "main" }
  ];

  it("matches every word against name, path and branch, name prefixes first", () => {
    assert.deepEqual(filterRepositories(repos, "api").map((repo) => repo.id), ["4", "1", "3"]);
    assert.deepEqual(filterRepositories(repos, "icarus shell").map((repo) => repo.id), ["2"]);
    assert.deepEqual(filterRepositories(repos, "ssp main").map((repo) => repo.id), ["3"]);
    assert.equal(filterRepositories(repos, "").length, 4);
    assert.equal(filterRepositories(repos, "nothing-like-this").length, 0);
  });
});

describe("patch parsing", () => {
  it("numbers old and new lines across hunks", () => {
    const lines = parsePatch(
      ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", "@@ -10 +10,2 @@", " ten", "+eleven", "\\ No newline at end of file", ""].join("\n")
    );
    const body = lines.filter((line) => line.kind !== "meta");
    assert.deepEqual(
      body.map((line) => [line.kind, line.oldNo ?? null, line.newNo ?? null, line.text]),
      [
        ["hunk", null, null, "@@ -1,2 +1,2 @@"],
        ["ctx", 1, 1, "keep"],
        ["del", 2, null, "old"],
        ["add", null, 2, "new"],
        ["hunk", null, null, "@@ -10 +10,2 @@"],
        ["ctx", 10, 10, "ten"],
        ["add", null, 11, "eleven"],
        ["note", null, null, "\\ No newline at end of file"]
      ]
    );
  });
});

describe("GitKraken-style row text", () => {
  it("shows the summary, then the rest of the message on one line joined by |", () => {
    assert.deepEqual(splitMessage("feat: x\n\nfirst line\n  second line  \n"), { subject: "feat: x", description: "first line | second line" });
    assert.deepEqual(splitMessage("only a subject"), { subject: "only a subject", description: "" });
  });

  it("buckets dates like GitKraken's time markers, in Spanish", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    assert.equal(relativeTime(ago(20_000), now), "hace un momento");
    assert.equal(relativeTime(ago(5 * 60_000), now), "hace 5 minutos");
    assert.equal(relativeTime(ago(60 * 60_000), now), "hace 1 hora");
    assert.equal(relativeTime(ago(18 * 3_600_000), now), "hace 18 horas");
    assert.equal(relativeTime(ago(2 * 86_400_000), now), "hace 2 días");
    assert.equal(relativeTime(ago(15 * 86_400_000), now), "hace 2 semanas");
    assert.equal(relativeTime(ago(400 * 86_400_000), now), "hace 1 año");
    assert.equal(relativeTime(undefined, now), "");
  });

  it("uses two initials for the author bubble", () => {
    assert.equal(initials("Ruben Esteban"), "RE");
    assert.equal(initials("Rubén"), "RU");
    assert.equal(initials("ada.lovelace"), "AL");
    assert.equal(initials(""), "?");
  });
});
