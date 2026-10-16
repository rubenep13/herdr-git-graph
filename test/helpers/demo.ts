import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "./fixture.ts";

export interface DemoRepos {
  alpha: string;
  beta: string;
  empty: string;
  worktree: string;
  marks: Map<string, string>;
  /** Commits only a Herdr checkpoint reaches. */
  checkpointOnly: string[];
  longBranch: string;
}

const AUTHORS = [
  ["Ada Lovelace", "ada@example.test"],
  ["Grace Hopper", "grace@example.test"],
  ["Linus Torvalds", "linus@example.test"]
] as const;

/**
 * A synthetic history written with `git fast-import`: ~700 commits on main
 * with feature branches merged back, a long-lived develop branch, an octopus
 * merge, an orphan branch, annotated and lightweight tags, remote-tracking
 * refs, several refs on one commit, a very long branch name, checkpoint refs
 * with commits of their own, a linked worktree and staged/unstaged/untracked
 * changes. Synthetic data for tests only.
 */
export function createDemoRepos(fixture: Fixture, options: { mainCommits?: number } = {}): DemoRepos {
  const mainCommits = options.mainCommits ?? 600;
  const alpha = fixture.init("alpha");
  const lines: string[] = [];
  let mark = 0;
  let time = 1_750_000_000;
  const names = new Map<string, number>();
  const commit = (ref: string, message: string, from: number | undefined, merges: number[] = [], file = "src/main.txt", author = 0) => {
    mark += 1;
    time += 600;
    const [name, email] = AUTHORS[author % AUTHORS.length]!;
    lines.push(`commit ${ref}`, `mark :${mark}`, `author ${name} <${email}> ${time} +0000`, `committer ${name} <${email}> ${time} +0000`);
    const data = Buffer.from(message, "utf8");
    lines.push(`data ${data.length}`, message);
    if (from !== undefined) lines.push(`from :${from}`);
    for (const parent of merges) lines.push(`merge :${parent}`);
    const content = `${message}\n${mark}\n`; // ends with \n: the stream's join supplies it
    lines.push(`M 100644 inline ${file}`, `data ${Buffer.byteLength(content)}`, content.slice(0, -1));
    return mark;
  };

  let main = commit("refs/heads/main", "chore: initial commit", undefined, [], "README.md");
  names.set("root", main);
  let develop: number | undefined;
  const at = {
    developStart: Math.max(3, Math.floor(mainCommits * 0.05)),
    developEnd: Math.floor(mainCommits * 0.66),
    octopus: Math.floor(mainCommits / 3) + 1,
    developMerge: Math.floor(mainCommits * 0.7) + 1,
    v01: Math.floor(mainCommits * 0.08) + 1,
    v02: Math.floor(mainCommits * 0.16) + 1
  };
  for (let index = 1; index < mainCommits; index += 1) {
    if (index === at.developStart) {
      develop = commit("refs/heads/develop", "feat(develop): start long-lived branch", main, [], "src/develop.txt", 1);
    }
    if (develop !== undefined && index > at.developStart && index % 7 === 0 && index < at.developEnd) {
      develop = commit("refs/heads/develop", `feat(develop): step ${index}`, develop, [], "src/develop.txt", 1);
    }
    if (index % 40 === 0 && index !== at.octopus && index !== at.developMerge) {
      const base = main;
      let feature = commit(`refs/heads/feature/f${index}`, `feat(f${index}): first change`, base, [], `src/f${index}.txt`, 2);
      main = commit("refs/heads/main", `fix: work on main ${index}`, main, [], `src/file${index % 20}.txt`);
      feature = commit(`refs/heads/feature/f${index}`, `feat(f${index}): second change`, feature, [], `src/f${index}.txt`, 2);
      main = commit("refs/heads/main", `Merge branch 'feature/f${index}'`, main, [feature], `src/merge${index}.txt`);
      names.set(`merge${index}`, main);
      continue;
    }
    if (index === at.octopus) {
      const a = commit("refs/heads/octo/a", "feat(octo): a", main, [], "src/octo-a.txt", 1);
      const b = commit("refs/heads/octo/b", "feat(octo): b", main, [], "src/octo-b.txt", 2);
      main = commit("refs/heads/main", "Merge branches 'octo/a' and 'octo/b' (octopus)", main, [a, b], "src/octo.txt");
      names.set("octopus", main);
      continue;
    }
    if (develop !== undefined && index === at.developMerge) {
      main = commit("refs/heads/main", "Merge branch 'develop'", main, [develop], "src/develop-merge.txt");
      names.set("developMerge", main);
      continue;
    }
    main = commit("refs/heads/main", `${index % 5 === 0 ? "refactor" : "fix"}: change number ${index}`, main, [], `src/file${index % 20}.txt`, index % 3);
    if (index === at.v01 || !names.has("v0.1")) names.set("v0.1", main);
    if (index === at.v02 || (index < at.v02 && !names.has("v0.2"))) names.set("v0.2", main);
  }
  names.set("tip", main);
  const pages = commit("refs/heads/gh-pages", "docs: orphan site root", undefined, [], "index.html", 1);
  const pages2 = commit("refs/heads/gh-pages", "docs: publish site", pages, [], "index.html", 1);
  names.set("orphan", pages2);
  const checkpoint1 = commit("refs/herdr-gpui/checkpoints/demo/0001", "Before claude's turn (checkpoint-only 1)", main, [], "src/wip.txt");
  const checkpoint2 = commit("refs/herdr-gpui/checkpoints/demo/0001", "Before claude's turn (checkpoint-only 2)", checkpoint1, [], "src/wip.txt");
  lines.push(`reset refs/herdr-gpui/checkpoints/demo/0002`, `from :${names.get("v0.1")}`);
  lines.push(`tag v0.1`, `from :${names.get("v0.1")}`, `tagger Ada Lovelace <ada@example.test> ${time} +0000`, "data 12", "release v0.1");
  lines.push(`reset refs/tags/v0.2`, `from :${names.get("v0.2")}`);
  lines.push(`tag v1.0.0`, `from :${main}`, `tagger Ada Lovelace <ada@example.test> ${time} +0000`, "data 14", "release v1.0.0");
  const longBranch = "release/2026-10-a-very-long-branch-name-to-check-ellipsis-and-the-popover";
  lines.push(`reset refs/heads/${longBranch}`, `from :${main}`);
  lines.push(`reset refs/remotes/origin/main`, `from :${main}`);
  lines.push(`reset refs/remotes/origin/develop`, `from :${names.get("developMerge") ?? develop ?? main}`);
  lines.push(`reset refs/remotes/upstream/main`, `from :${names.get("merge40") ?? main}`);
  lines.push("done");

  execFileSync("git", ["-C", alpha, "fast-import", "--quiet", `--export-marks=${join(fixture.root, "alpha.marks")}`], {
    input: `${lines.join("\n")}\n`,
    env: fixture.env(),
    stdio: ["pipe", "ignore", "pipe"]
  });
  const marks = new Map<string, string>();
  const markOids = new Map<number, string>();
  for (const line of execFileSync("cat", [join(fixture.root, "alpha.marks")], { encoding: "utf8" }).split("\n")) {
    const [markText, oid] = line.split(" ");
    if (markText && oid) markOids.set(Number(markText.slice(1)), oid);
  }
  for (const [name, markNumber] of names) marks.set(name, markOids.get(markNumber)!);
  fixture.git(alpha, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  fixture.git(alpha, ["checkout", "-q", "-f", "main"]);

  // Working tree: one staged, one staged-and-modified, one unstaged, one untracked file.
  writeFileSync(join(alpha, "src/file1.txt"), "staged change\n");
  writeFileSync(join(alpha, "src/file2.txt"), "staged first\n");
  fixture.git(alpha, ["add", "src/file1.txt", "src/file2.txt"]);
  writeFileSync(join(alpha, "src/file2.txt"), "staged first\nthen edited again\n");
  writeFileSync(join(alpha, "src/file3.txt"), "unstaged change\n");
  writeFileSync(join(alpha, "notes-untracked.md"), "# untracked\nhello\n");

  const worktree = join(fixture.root, "outside-root", "alpha-hotfix");
  fixture.git(alpha, ["worktree", "add", "-q", "-b", "hotfix/urgent", worktree, marks.get("v0.2")!]);

  const beta = fixture.init("nested/beta");
  fixture.commit(beta, "feat: beta first", { "b.txt": "1" });
  fixture.commit(beta, "feat: beta second", { "b.txt": "2" }, { name: "Grace Hopper", email: "grace@example.test" });
  const empty = fixture.init("empty");

  return {
    alpha,
    beta,
    empty,
    worktree,
    marks,
    checkpointOnly: [markOids.get(checkpoint1)!, markOids.get(checkpoint2)!],
    longBranch
  };
}
