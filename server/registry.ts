import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AppConfig } from "./config.ts";
import type { GitRunner } from "./git.ts";

export interface RepoEntry {
  id: string;
  name: string;
  /** Real path of the working tree (or of the bare repository). */
  path: string;
  /** `path` with the home directory shown as `~`. */
  displayPath: string;
  /** The configured root it was found under; absent for explicit entries and linked worktrees. */
  root?: string;
  bare: boolean;
  /** A linked worktree (`git worktree add`), not the main checkout. */
  linkedWorktree: boolean;
  /** For a linked worktree, the id of the repository's main checkout when listed. */
  mainId?: string;
  gitDir: string;
  commonDir: string;
  /** Branch checked out, read from HEAD; undefined when detached. */
  branch?: string;
}

interface RepoProbe {
  path: string;
  gitDir: string;
  commonDir: string;
  bare: boolean;
}

export function repoId(path: string): string {
  const slug = basename(path).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `${slug}-${createHash("sha1").update(path).digest("hex").slice(0, 8)}`;
}

function displayPath(path: string, home = homedir()): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

async function readBranch(gitDir: string): Promise<string | undefined> {
  try {
    const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The allow-list of repositories the server may read. Only ids produced by a
 * scan of the configured roots (plus explicit repositories and the linked
 * worktrees they register) resolve; a request can never name a path.
 */
export class RepoRegistry {
  readonly #config: AppConfig;
  readonly #git: GitRunner;
  #entries = new Map<string, RepoEntry>();
  #scannedAt = 0;
  #scanning: Promise<RepoEntry[]> | undefined;

  constructor(config: AppConfig, git: GitRunner) {
    this.#config = config;
    this.#git = git;
  }

  get scannedAt(): number {
    return this.#scannedAt;
  }

  async list(options: { maxAgeMs?: number; force?: boolean } = {}): Promise<RepoEntry[]> {
    const maxAge = options.maxAgeMs ?? 60_000;
    if (!options.force && this.#scannedAt && Date.now() - this.#scannedAt < maxAge) {
      return [...this.#entries.values()];
    }
    this.#scanning ??= this.#scan().finally(() => {
      this.#scanning = undefined;
    });
    return this.#scanning;
  }

  async get(id: string): Promise<RepoEntry | undefined> {
    if (!this.#scannedAt) await this.list();
    const entry = this.#entries.get(id);
    if (entry) return entry;
    // An unknown id may belong to a repository created since the last scan.
    if (Date.now() - this.#scannedAt > 5_000) {
      await this.list({ force: true });
      return this.#entries.get(id);
    }
    return undefined;
  }

  /** Resolver handed to LocalGitBackend: id → path, only for listed repositories. */
  async resolvePath(id: string): Promise<string | undefined> {
    return (await this.get(id))?.path;
  }

  async #scan(): Promise<RepoEntry[]> {
    const candidates = new Map<string, string | undefined>();
    let visited = 0;
    for (const root of this.#config.roots) {
      let realRoot: string;
      try {
        realRoot = await realpath(root.path);
      } catch {
        continue;
      }
      const queue: Array<{ dir: string; depth: number }> = [{ dir: realRoot, depth: 0 }];
      while (queue.length && visited < this.#config.maxScanEntries) {
        const { dir, depth } = queue.shift()!;
        visited += 1;
        let entries;
        try {
          entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        } catch {
          continue;
        }
        if (entries.some((entry) => entry.name === ".git")) {
          // A checkout: verified with git below; its subdirectories are not scanned.
          candidates.set(dir, realRoot);
          continue;
        }
        if (depth >= root.depth) continue;
        for (const entry of entries) {
          // Symbolic links are never followed, so a scan cannot leave its root.
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          if (this.#config.skipDirectories.includes(entry.name)) continue;
          queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
        }
      }
    }
    for (const path of this.#config.repositories) {
      try {
        candidates.set(await realpath(path), undefined);
      } catch {
        // A configured repository that no longer exists is simply not listed.
      }
    }

    const byPath = new Map<string, RepoEntry>();
    const probes = await Promise.all(
      [...candidates].map(async ([path, root]) => ({ root, probe: await this.#probe(path) }))
    );
    for (const { root, probe } of probes) {
      if (!probe || byPath.has(probe.path)) continue;
      byPath.set(probe.path, await this.#entry(probe, root));
    }

    if (this.#config.includeLinkedWorktrees) {
      const mains = [...byPath.values()].filter((entry) => !entry.bare && !entry.linkedWorktree);
      const lists = await Promise.all(mains.map((entry) => this.#linkedWorktrees(entry)));
      for (const [index, paths] of lists.entries()) {
        const main = mains[index]!;
        for (const path of paths) {
          const known = byPath.get(path);
          if (known) {
            if (known.linkedWorktree) known.mainId = main.id;
            continue;
          }
          const probe = await this.#probe(path);
          if (!probe || probe.commonDir !== main.commonDir) continue;
          const entry = await this.#entry(probe, undefined);
          entry.mainId = main.id;
          byPath.set(probe.path, entry);
        }
      }
      // Linked worktrees found directly under a root also point at their main checkout.
      const byCommonDir = new Map(mains.map((entry) => [entry.commonDir, entry.id]));
      for (const entry of byPath.values()) {
        if (entry.linkedWorktree && !entry.mainId) {
          const mainId = byCommonDir.get(entry.commonDir);
          if (mainId) entry.mainId = mainId;
        }
      }
    }

    const sorted = [...byPath.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
    this.#entries = new Map(sorted.map((entry) => [entry.id, entry]));
    this.#scannedAt = Date.now();
    return sorted;
  }

  /** Asks git whether `path` is the top of a repository; a stray `.git` is not enough. */
  async #probe(path: string): Promise<RepoProbe | undefined> {
    const result = await this.#git
      .run(
        path,
        ["rev-parse", "--path-format=absolute", "--is-bare-repository", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"],
        { allowFailure: true }
      )
      .catch(() => undefined);
    if (!result) return undefined;
    // In a bare repository --show-toplevel fails after the other answers were printed.
    const [bareText, gitDir, commonDir, topLevel] = result.stdout.split("\n");
    if (!gitDir || !commonDir) return undefined;
    const bare = bareText === "true";
    if (!bare && result.code !== 0) return undefined;
    const own = bare ? gitDir : topLevel;
    if (!own) return undefined;
    try {
      const [real, realGitDir, realCommonDir] = await Promise.all([realpath(own), realpath(gitDir), realpath(commonDir)]);
      if (real !== (await realpath(path))) return undefined;
      return { path: real, gitDir: realGitDir, commonDir: realCommonDir, bare };
    } catch {
      return undefined;
    }
  }

  async #entry(probe: RepoProbe, root: string | undefined): Promise<RepoEntry> {
    const branch = await readBranch(probe.gitDir);
    return {
      id: repoId(probe.path),
      name: basename(probe.path),
      path: probe.path,
      displayPath: displayPath(probe.path),
      ...(root ? { root } : {}),
      bare: probe.bare,
      linkedWorktree: !probe.bare && probe.gitDir !== probe.commonDir,
      gitDir: probe.gitDir,
      commonDir: probe.commonDir,
      ...(branch ? { branch } : {})
    };
  }

  async #linkedWorktrees(entry: RepoEntry): Promise<string[]> {
    const result = await this.#git
      .run(entry.path, ["worktree", "list", "--porcelain", "-z"], { allowFailure: true })
      .catch(() => undefined);
    if (!result || result.code !== 0) return [];
    const paths: string[] = [];
    let current: string | undefined;
    let prunable = false;
    const flush = async () => {
      if (current && !prunable) {
        try {
          const real = await realpath(current);
          if (real !== entry.path && (await stat(real)).isDirectory()) paths.push(real);
        } catch {
          // A worktree whose directory is gone is not listed.
        }
      }
      current = undefined;
      prunable = false;
    };
    for (const field of result.stdout.split("\0")) {
      if (field.startsWith("worktree ")) {
        await flush();
        current = field.slice("worktree ".length);
      } else if (field.startsWith("prunable")) {
        prunable = true;
      } else if (field === "bare") {
        current = undefined;
      }
    }
    await flush();
    return paths;
  }
}
