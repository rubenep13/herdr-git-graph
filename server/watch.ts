import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";
import type { GitRunner } from "./git.ts";
import type { RepoEntry } from "./registry.ts";
import { readWorktreeStatus } from "./worktree.ts";

export interface RepoState {
  refs: string;
  worktree: string;
}

export interface RepoChange {
  refs: boolean;
  worktree: boolean;
  state: RepoState;
}

type Listener = (change: RepoChange) => void;

const IGNORED_WORKTREE_SEGMENTS = new Set([".git", "node_modules"]);

/**
 * Notices what terminal operations changed in a repository so the page can
 * refresh only that: refs/HEAD (history) or the working tree (status).
 *
 * File-system events (FSEvents on macOS) wake it quickly; a slow poll covers
 * anything they miss. It only runs while a page is subscribed, and each check
 * costs two read-only Git commands — never one per row.
 */
export class RepoWatcher {
  readonly #git: GitRunner;
  readonly #repository: RepoEntry;
  readonly #listeners = new Set<Listener>();
  readonly #watchers: FSWatcher[] = [];
  #state: RepoState | undefined;
  #timer: NodeJS.Timeout | undefined;
  #poll: NodeJS.Timeout | undefined;
  #checking = false;
  #again = false;
  #lastCheck = 0;
  readonly #debounceMs: number;
  readonly #pollMs: number;
  readonly #minIntervalMs: number;

  constructor(git: GitRunner, repository: RepoEntry, options: { debounceMs?: number; pollMs?: number; minIntervalMs?: number } = {}) {
    this.#git = git;
    this.#repository = repository;
    this.#debounceMs = options.debounceMs ?? 400;
    this.#pollMs = options.pollMs ?? 15_000;
    this.#minIntervalMs = options.minIntervalMs ?? 1_500;
  }

  get state(): RepoState | undefined {
    return this.#state;
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  async subscribe(listener: Listener): Promise<RepoState> {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#start();
    if (!this.#state) this.#state = await this.#read();
    return this.#state;
  }

  unsubscribe(listener: Listener): void {
    this.#listeners.delete(listener);
    if (this.#listeners.size === 0) this.#stop();
  }

  close(): void {
    this.#listeners.clear();
    this.#stop();
  }

  #start(): void {
    const onGitEvent = (_event: string, filename: string | Buffer | null) => {
      const name = filename ? filename.toString() : "";
      const relativeName = name.split(sep).join("/");
      if (
        !relativeName ||
        relativeName === "HEAD" ||
        relativeName === "index" ||
        relativeName === "packed-refs" ||
        relativeName.startsWith("refs/") ||
        /^worktrees\/[^/]+\/(HEAD|index)$/.test(relativeName)
      ) {
        this.#schedule();
      }
    };
    const directories = new Set([this.#repository.commonDir, this.#repository.gitDir]);
    for (const directory of directories) {
      this.#add(directory, true, onGitEvent);
    }
    if (!this.#repository.bare) {
      this.#add(this.#repository.path, true, (_event, filename) => {
        const name = filename ? filename.toString() : "";
        const first = name.split(sep, 1)[0] ?? "";
        if (IGNORED_WORKTREE_SEGMENTS.has(first)) return;
        if (name.split(sep).some((segment) => segment === "node_modules")) return;
        this.#schedule();
      });
    }
    this.#poll = setInterval(() => this.#schedule(), this.#pollMs);
    this.#poll.unref();
  }

  #add(path: string, recursive: boolean, handler: (event: string, filename: string | Buffer | null) => void): void {
    try {
      const watcher = watch(path, { recursive, persistent: false }, handler);
      watcher.on("error", () => watcher.close());
      this.#watchers.push(watcher);
    } catch {
      // Watching is an optimisation; the poll still notices changes.
    }
  }

  #stop(): void {
    for (const watcher of this.#watchers.splice(0)) watcher.close();
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#poll) clearInterval(this.#poll);
    this.#timer = undefined;
    this.#poll = undefined;
    this.#state = undefined;
  }

  #schedule(): void {
    if (this.#timer) return;
    const wait = Math.max(this.#debounceMs, this.#minIntervalMs - (Date.now() - this.#lastCheck));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#check();
    }, wait);
    this.#timer.unref();
  }

  async #check(): Promise<void> {
    if (this.#checking) {
      this.#again = true;
      return;
    }
    this.#checking = true;
    this.#lastCheck = Date.now();
    try {
      const next = await this.#read();
      const previous = this.#state;
      this.#state = next;
      if (previous && this.#listeners.size) {
        const change = { refs: previous.refs !== next.refs, worktree: previous.worktree !== next.worktree, state: next };
        if (change.refs || change.worktree) {
          for (const listener of this.#listeners) listener(change);
        }
      }
    } catch {
      // A failed check (repository moved, Git busy) is retried by the next event or poll.
    } finally {
      this.#checking = false;
      if (this.#again) {
        this.#again = false;
        this.#schedule();
      }
    }
  }

  async #read(): Promise<RepoState> {
    const path = this.#repository.path;
    const [refs, head, worktree] = await Promise.all([
      this.#git.run(path, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes", "refs/tags", "refs/stash"]),
      this.#git.run(path, ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", "HEAD", "HEAD"], { allowFailure: true }),
      this.#repository.bare ? Promise.resolve(undefined) : readWorktreeStatus(this.#git, this.#repository)
    ]);
    return {
      refs: createHash("sha1").update(refs.stdout).update("\0").update(head.stdout).digest("hex"),
      worktree: worktree?.fingerprint ?? ""
    };
  }
}

/** One watcher per repository, shared by all pages showing it. */
export class WatchHub {
  readonly #git: GitRunner;
  readonly #watchers = new Map<string, RepoWatcher>();
  readonly #options: ConstructorParameters<typeof RepoWatcher>[2];

  constructor(git: GitRunner, options: ConstructorParameters<typeof RepoWatcher>[2] = {}) {
    this.#git = git;
    this.#options = options;
  }

  async subscribe(repository: RepoEntry, listener: Listener): Promise<{ state: RepoState; unsubscribe: () => void }> {
    let watcher = this.#watchers.get(repository.id);
    if (!watcher) {
      watcher = new RepoWatcher(this.#git, repository, this.#options);
      this.#watchers.set(repository.id, watcher);
    }
    const state = await watcher.subscribe(listener);
    const current = watcher;
    return {
      state,
      unsubscribe: () => {
        current.unsubscribe(listener);
        if (current.listenerCount === 0) this.#watchers.delete(repository.id);
      }
    };
  }

  get size(): number {
    return this.#watchers.size;
  }

  closeAll(): void {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }
}
