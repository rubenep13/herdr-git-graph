import { createHash } from "node:crypto";
import { GitGraphProtocolError } from "@web-git-graph/protocol";
import type { GitRunner } from "./git.ts";
import type { RepoEntry } from "./registry.ts";

export type WorktreeSection = "staged" | "unstaged" | "untracked" | "conflicted";
export const WORKTREE_SECTIONS: readonly WorktreeSection[] = ["staged", "unstaged", "untracked", "conflicted"];

export interface WorktreeFile {
  path: string;
  previousPath?: string;
  /** Git's one-letter status for this side: M A D R C T U ?. */
  status: string;
  submodule?: boolean;
}

export interface WorktreeStatus {
  head?: string;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: WorktreeFile[];
  unstaged: WorktreeFile[];
  untracked: WorktreeFile[];
  conflicted: WorktreeFile[];
  /** Changes whenever the status output changes; used to skip needless refreshes. */
  fingerprint: string;
}

export interface WorktreeDiff {
  section: WorktreeSection;
  path: string;
  previousPath?: string;
  patch?: string;
  truncated?: boolean;
  binary?: boolean;
  unavailableReason?: string;
}

const MAX_DIFF_BYTES = 1_500_000;

export function parsePorcelainV2(output: string): Omit<WorktreeStatus, "fingerprint"> {
  const status: Omit<WorktreeStatus, "fingerprint"> = {
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: []
  };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    if (record.startsWith("# ")) {
      const [, key, ...rest] = record.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid" && value !== "(initial)") status.head = value;
      else if (key === "branch.head") {
        if (value === "(detached)") status.detached = true;
        else status.branch = value;
      } else if (key === "branch.upstream") status.upstream = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          status.ahead = Number(match[1]);
          status.behind = Number(match[2]);
        }
      }
      continue;
    }
    if (record.startsWith("? ")) {
      status.untracked.push({ path: record.slice(2), status: "?" });
      continue;
    }
    const type = record[0];
    if (type !== "1" && type !== "2" && type !== "u") continue;
    const fields = record.split(" ");
    const xy = fields[1] ?? "..";
    const submodule = (fields[2] ?? "N...").startsWith("S");
    const pathIndex = type === "1" ? 8 : type === "2" ? 9 : 10;
    const path = fields.slice(pathIndex).join(" ");
    const previousPath = type === "2" ? records[++index] : undefined;
    const base = { path, ...(submodule ? { submodule } : {}) };
    if (type === "u") {
      status.conflicted.push({ ...base, status: "U" });
      continue;
    }
    if (xy[0] !== ".") status.staged.push({ ...base, status: xy[0]!, ...(previousPath ? { previousPath } : {}) });
    if (xy[1] !== ".") status.unstaged.push({ ...base, status: xy[1]! });
  }
  return status;
}

export async function readWorktreeStatus(git: GitRunner, repository: RepoEntry, signal?: AbortSignal): Promise<WorktreeStatus> {
  if (repository.bare) {
    throw new GitGraphProtocolError("unsupported", "A bare repository has no working tree.");
  }
  const result = await git.run(
    repository.path,
    ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=dirty"],
    { signal }
  );
  return {
    ...parsePorcelainV2(result.stdout),
    fingerprint: createHash("sha1").update(result.stdout).digest("hex")
  };
}

/**
 * The patch of one file of the working tree. The file must be listed in that
 * section of the current status, so a request can only name paths Git itself
 * reported for this repository.
 */
export async function readWorktreeDiff(
  git: GitRunner,
  repository: RepoEntry,
  section: string,
  path: string,
  context = 3,
  signal?: AbortSignal
): Promise<WorktreeDiff> {
  if (!WORKTREE_SECTIONS.includes(section as WorktreeSection)) {
    throw new GitGraphProtocolError("bad_request", "section must be staged, unstaged, untracked or conflicted.");
  }
  const status = await readWorktreeStatus(git, repository, signal);
  const file = status[section as WorktreeSection].find((item) => item.path === path);
  if (!file) {
    throw new GitGraphProtocolError("bad_request", `${path} has no ${section} change in this working tree.`);
  }
  const unified = `--unified=${Math.min(20, Math.max(0, Math.trunc(context)))}`;
  const common = ["--no-ext-diff", "--no-textconv", "--no-color", unified];
  let args: string[];
  if (section === "staged") {
    args = ["diff", "--cached", "-M", ...common, "--", ...(file.previousPath ? [file.previousPath] : []), file.path];
  } else if (section === "unstaged" || section === "conflicted") {
    args = ["diff", ...common, "--", file.path];
  } else {
    // An untracked file, shown as added; --no-index only reads the two files.
    args = ["diff", "--no-index", ...common, "--", "/dev/null", file.path];
  }
  const result = await git.run(repository.path, args, { signal, allowFailure: true, maxBytes: MAX_DIFF_BYTES });
  // `git diff --no-index` exits 1 when the files differ, which is the expected case.
  if (result.code > 1) {
    throw new GitGraphProtocolError("git_unavailable", `git diff failed for ${path}.`);
  }
  const binary = /^Binary files .* differ$/m.test(result.stdout);
  return {
    section: section as WorktreeSection,
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    ...(result.stdout
      ? { patch: result.stdout, ...(result.truncated ? { truncated: true } : {}), ...(binary ? { binary } : {}) }
      : { unavailableReason: "No textual patch is available for this file." })
  };
}
