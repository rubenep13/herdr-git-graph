import { LocalGitBackend, type GitGraphBackend } from "@web-git-graph/node";
import {
  GitGraphProtocolError,
  type GitGraphCapabilities,
  type GitGraphCommitDetails,
  type GitGraphComparison,
  type GitGraphFileDiff,
  type GitGraphHistoryQuery,
  type GitGraphPage,
  type GitGraphRef,
  type GitGraphRepository,
  type GitGraphRevision
} from "@web-git-graph/protocol";
import type { GitRunner } from "./git.ts";
import type { RepoEntry, RepoRegistry } from "./registry.ts";

/** Base revision meaning "the empty tree", for diffs of a root commit. */
export const EMPTY_TREE_REVISION = "__EMPTY_TREE__";

/**
 * Ref namespaces whose tips are walked and shown. Everything else is left
 * out of the history — in particular Herdr's checkpoints under
 * refs/herdr-gpui/, which are never read as tips and never modified.
 * Commits a checkpoint shares with a branch stay visible because they are
 * reached from the branch.
 */
export const VISIBLE_REF_NAMESPACES = ["refs/heads", "refs/remotes", "refs/tags"] as const;
export const HIDDEN_REF_NAMESPACE = "refs/herdr-gpui";

export interface RepositoryInfo {
  repository: RepoEntry;
  head?: string;
  branch?: string;
  hiddenRefs: number;
  empty: boolean;
}

/**
 * GitGraphBackend over @web-git-graph/node's LocalGitBackend that
 * - resolves repositories only through the registry allow-list,
 * - never asks it for the working tree on history pages (the client gets the
 *   staged/unstaged/untracked split from /api/.../worktree instead),
 * - reports annotated tags at the commit they point to (upstream reports the
 *   tag object, so their labels never meet a row),
 * - drops refs/remotes/<remote>/HEAD aliases, and
 * - diffs a root commit against the empty tree.
 */
export class ViewerBackend implements GitGraphBackend {
  readonly #inner: LocalGitBackend;
  readonly #registry: RepoRegistry;
  readonly #git: GitRunner;

  constructor(options: { registry: RepoRegistry; git: GitRunner; maxPageSize?: number }) {
    this.#registry = options.registry;
    this.#git = options.git;
    this.#inner = new LocalGitBackend({
      resolveRepository: (id) => options.registry.resolvePath(id),
      maxPageSize: options.maxPageSize ?? 500,
      maxDiffBytes: 1_500_000,
      timeoutMs: 20_000,
      maxConcurrency: 4
    });
  }

  getCapabilities(): Promise<GitGraphCapabilities> {
    return this.#inner.getCapabilities();
  }

  async listRepositories(): Promise<readonly GitGraphRepository[]> {
    const entries = await this.#registry.list();
    return entries.map((entry) => ({ id: entry.id, name: entry.name, bare: entry.bare }));
  }

  async getHistory(id: string, query: GitGraphHistoryQuery = {}, signal?: AbortSignal): Promise<GitGraphPage> {
    const page = await this.#inner.getHistory(id, { ...query, includeWorkingTree: false }, signal);
    const repository = await this.#require(id);
    const refs = await this.readRefs(repository, signal);
    return {
      ...page,
      refs: [...refs, ...page.refs.filter((ref) => ref.kind === "stash")]
    };
  }

  async getCommitDetails(id: string, revision: GitGraphRevision, signal?: AbortSignal): Promise<GitGraphCommitDetails> {
    const details = await this.#inner.getCommitDetails(id, revision, signal);
    if (revision.kind === "working-tree") return details;
    const repository = await this.#require(id);
    const refs = await this.readRefs(repository, signal);
    return { ...details, refs: refs.filter((ref) => ref.target === details.commit.oid) };
  }

  async compare(id: string, base: GitGraphRevision, head: GitGraphRevision, signal?: AbortSignal): Promise<GitGraphComparison> {
    if (base.kind !== "working-tree" && base.oid === EMPTY_TREE_REVISION) {
      throw new GitGraphProtocolError("bad_request", "Use the commit details of a root commit for its changes.");
    }
    return this.#inner.compare(id, base, head, signal);
  }

  async getFileDiff(
    id: string,
    base: GitGraphRevision,
    head: GitGraphRevision,
    path: string,
    context = 3,
    signal?: AbortSignal
  ): Promise<GitGraphFileDiff> {
    if (base.kind === "working-tree" || base.oid !== EMPTY_TREE_REVISION) {
      return this.#inner.getFileDiff(id, base, head, path, context, signal);
    }
    // A root commit: its patch against the empty tree.
    if (head.kind === "working-tree" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head.oid)) {
      throw new GitGraphProtocolError("bad_request", "A root commit diff needs the commit's full object id.");
    }
    if (!path || path.includes("\0")) {
      throw new GitGraphProtocolError("bad_request", "A valid repository-relative file path is required.");
    }
    const repository = await this.#require(id);
    const parents = await this.#git.run(repository.path, ["rev-list", "--parents", "-n", "1", head.oid], {
      signal,
      allowFailure: true
    });
    const fields = parents.stdout.trim().split(" ");
    if (parents.code !== 0 || fields.length !== 1) {
      throw new GitGraphProtocolError("bad_request", "Only a root commit is compared with the empty tree.");
    }
    const result = await this.#git.run(
      repository.path,
      [
        "diff-tree",
        "-p",
        "--root",
        "--no-commit-id",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        `--unified=${Math.min(20, Math.max(0, Math.trunc(context)))}`,
        head.oid,
        "--",
        path
      ],
      { signal, maxBytes: 1_500_000 }
    );
    return {
      base,
      head,
      path,
      ...(result.stdout
        ? { patch: result.stdout, ...(result.truncated ? { truncated: true } : {}) }
        : { unavailableReason: "No textual patch is available for this file." })
    };
  }

  async info(id: string, signal?: AbortSignal): Promise<RepositoryInfo> {
    const repository = await this.#require(id);
    const [head, branch, hidden] = await Promise.all([
      this.#git.run(repository.path, ["rev-parse", "--verify", "--quiet", "HEAD"], { signal, allowFailure: true }),
      this.#git.run(repository.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], { signal, allowFailure: true }),
      this.#git.run(repository.path, ["for-each-ref", "--format=%(refname)", HIDDEN_REF_NAMESPACE], { signal })
    ]);
    const headOid = head.code === 0 ? head.stdout.trim() : "";
    const branchName = branch.code === 0 ? branch.stdout.trim() : "";
    return {
      repository,
      ...(headOid ? { head: headOid } : {}),
      ...(branchName ? { branch: branchName } : {}),
      hiddenRefs: hidden.stdout.split("\n").filter(Boolean).length,
      empty: !headOid && !(await this.readRefs(repository, signal)).length
    };
  }

  /** Visible refs with annotated tags peeled to their commit, HEAD first. */
  async readRefs(repository: RepoEntry, signal?: AbortSignal): Promise<GitGraphRef[]> {
    const [listing, head, branch] = await Promise.all([
      this.#git.run(
        repository.path,
        ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(symref)", ...VISIBLE_REF_NAMESPACES],
        { signal }
      ),
      this.#git.run(repository.path, ["rev-parse", "--verify", "--quiet", "HEAD"], { signal, allowFailure: true }),
      this.#git.run(repository.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], { signal, allowFailure: true })
    ]);
    const refs: GitGraphRef[] = [];
    for (const line of listing.stdout.split("\n")) {
      if (!line) continue;
      const [name, objectName, peeled, symref] = line.split("\0");
      if (!name || !objectName) continue;
      if (!VISIBLE_REF_NAMESPACES.some((namespace) => name.startsWith(`${namespace}/`))) continue;
      // refs/remotes/origin/HEAD only aliases the remote's default branch.
      if (symref && name.startsWith("refs/remotes/")) continue;
      refs.push({
        name,
        target: peeled || objectName,
        kind: name.startsWith("refs/heads/") ? "head" : name.startsWith("refs/remotes/") ? "remote" : "tag"
      });
    }
    const headOid = head.code === 0 ? head.stdout.trim() : "";
    if (headOid) {
      refs.unshift({ name: branch.code === 0 ? branch.stdout.trim() || "HEAD" : "HEAD", target: headOid, kind: "current" });
    }
    return refs;
  }

  async #require(id: string): Promise<RepoEntry> {
    const repository = await this.#registry.get(id);
    if (!repository) {
      throw new GitGraphProtocolError("repository_not_found", `Repository ${id} is not registered.`);
    }
    return repository;
  }
}
