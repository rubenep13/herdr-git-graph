import { layoutGitGraph, type GitGraphLayout, type GitGraphSegment } from "@web-git-graph/web";
import type { GitGraphCommit, GitGraphRef } from "@web-git-graph/protocol";

export const WORKTREE_OID = "__WORKTREE__";

export type ChipKind = "branch" | "remote" | "tag" | "stash" | "detached";

/** One label in the RAMA / TAG column. */
export interface RefChip {
  label: string;
  kind: ChipKind;
  /** HEAD is on this branch (or detached here). */
  current: boolean;
  /** Remotes whose branch of the same name points at the same commit, e.g. ["origin"]. */
  remotes: string[];
  /** Full ref names this label stands for. */
  names: string[];
}

const KIND_ORDER: Record<ChipKind, number> = { detached: 0, branch: 1, tag: 2, remote: 3, stash: 4 };

/**
 * Groups refs by the commit they point to. A local branch absorbs the remote
 * branches of the same name at the same commit (shown as a suffix), HEAD marks
 * its branch, and the current branch sorts first.
 */
export function buildRefChips(refs: readonly GitGraphRef[]): Map<string, RefChip[]> {
  const byTarget = new Map<string, GitGraphRef[]>();
  for (const ref of refs) {
    const list = byTarget.get(ref.target) ?? [];
    list.push(ref);
    byTarget.set(ref.target, list);
  }
  const result = new Map<string, RefChip[]>();
  for (const [target, list] of byTarget) {
    const current = list.find((ref) => ref.kind === "current");
    const chips: RefChip[] = [];
    const remotes = list
      .filter((ref) => ref.kind === "remote")
      .map((ref) => {
        const short = ref.name.replace(/^refs\/remotes\//, "");
        const slash = short.indexOf("/");
        return { ref, short, remote: short.slice(0, slash), branch: short.slice(slash + 1), used: false };
      });
    for (const ref of list.filter((item) => item.kind === "head")) {
      const label = ref.name.replace(/^refs\/heads\//, "");
      const tracking = remotes.filter((remote) => !remote.used && remote.branch === label);
      for (const remote of tracking) remote.used = true;
      chips.push({
        label,
        kind: "branch",
        current: current?.name === label,
        remotes: tracking.map((remote) => remote.remote),
        names: [ref.name, ...tracking.map((remote) => remote.ref.name)]
      });
    }
    if (current && (current.name === "HEAD" || !chips.some((chip) => chip.current))) {
      chips.push({ label: current.name === "HEAD" ? "HEAD" : current.name, kind: "detached", current: true, remotes: [], names: ["HEAD"] });
    }
    for (const ref of list.filter((item) => item.kind === "tag")) {
      chips.push({ label: ref.name.replace(/^refs\/tags\//, ""), kind: "tag", current: false, remotes: [], names: [ref.name] });
    }
    for (const remote of remotes.filter((item) => !item.used)) {
      // As GitKraken does, a remote branch shows by its branch name with a remote icon;
      // only remotes other than "origin" keep their name, to tell them apart.
      const label = remote.remote === "origin" ? remote.branch : remote.short;
      chips.push({ label, kind: "remote", current: false, remotes: [remote.remote], names: [remote.ref.name] });
    }
    for (const ref of list.filter((item) => item.kind === "stash")) {
      chips.push({ label: ref.name, kind: "stash", current: false, remotes: [], names: [ref.name] });
    }
    chips.sort((a, b) => Number(b.current) - Number(a.current) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    if (chips.length) result.set(target, chips);
  }
  return result;
}

export interface WorktreeCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export function worktreeCommit(head: string | undefined, counts: WorktreeCounts): GitGraphCommit {
  const total = counts.staged + counts.unstaged + counts.untracked + counts.conflicted;
  return {
    oid: WORKTREE_OID,
    parents: head ? [head] : [],
    message: "Cambios sin commit",
    kind: "working-tree",
    changedFiles: total,
    worktree: { staged: counts.staged, unstaged: counts.unstaged, untracked: counts.untracked }
  };
}

/**
 * The rows on screen: commits in Git's date order (child before parent), the
 * lane layout from @web-git-graph/web, and an index of segments per row so a
 * render only touches what is visible.
 */
export class HistoryModel {
  readonly commits: readonly GitGraphCommit[];
  readonly layout: GitGraphLayout;
  readonly chips: Map<string, RefChip[]>;
  readonly rowOf = new Map<string, number>();
  readonly head: string | undefined;
  readonly #byRow: GitGraphSegment[][] = [];
  readonly #long: GitGraphSegment[] = [];

  constructor(commits: readonly GitGraphCommit[], refs: readonly GitGraphRef[], head?: string) {
    this.commits = commits;
    this.head = head;
    this.layout = layoutGitGraph(commits);
    this.chips = buildRefChips(refs);
    commits.forEach((commit, row) => this.rowOf.set(commit.oid, row));
    for (const segment of this.layout.segments) {
      const from = Math.min(segment.from.row, segment.to.row);
      const to = Math.max(segment.from.row, segment.to.row);
      if (to - from > 64) {
        this.#long.push(segment);
        continue;
      }
      for (let row = from; row <= Math.max(from, to - 1); row += 1) {
        (this.#byRow[row] ??= []).push(segment);
      }
    }
  }

  get rowCount(): number {
    return this.commits.length;
  }

  get laneCount(): number {
    return this.layout.laneCount;
  }

  node(row: number) {
    return this.layout.nodes[row];
  }

  /** Segments that cross rows [start, end). */
  segmentsBetween(start: number, end: number): GitGraphSegment[] {
    const found = new Set<GitGraphSegment>();
    for (let row = Math.max(0, start - 1); row < end; row += 1) {
      for (const segment of this.#byRow[row] ?? []) found.add(segment);
    }
    for (const segment of this.#long) {
      const from = Math.min(segment.from.row, segment.to.row);
      const to = Math.max(segment.from.row, segment.to.row);
      if (to >= start && from < end) found.add(segment);
    }
    return [...found];
  }
}

/** Subject and the rest of a message on one line, joined like GitKraken does ("a | b"). */
export function splitMessage(message: string): { subject: string; description: string } {
  const [subject = "", ...rest] = message.split("\n");
  const description = rest
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
  return { subject: subject.trim(), description };
}
