import { spawn } from "node:child_process";
import { GitGraphProtocolError } from "@web-git-graph/protocol";

export interface GitResult {
  stdout: string;
  code: number;
  truncated: boolean;
}

export interface GitRunOptions {
  signal?: AbortSignal | undefined;
  /** Accept a non-zero exit status instead of throwing. */
  allowFailure?: boolean;
  /** Stop reading after this many bytes and report `truncated`. */
  maxBytes?: number;
}

class Semaphore {
  #available: number;
  readonly #queue: Array<() => void> = [];

  constructor(count: number) {
    this.#available = Math.max(1, count);
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
    } else {
      await new Promise<void>((wake) => this.#queue.push(wake));
    }
    return () => {
      const next = this.#queue.shift();
      if (next) next();
      else this.#available += 1;
    };
  }
}

/**
 * Runs read-only Git commands for the parts @web-git-graph/node does not
 * cover. Commands always go through `git -C <repo>` with shell:false, and
 * inherit the read-only environment set up by git-env.ts.
 */
export class GitRunner {
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #semaphore: Semaphore;

  constructor(options: { binary?: string; timeoutMs?: number; maxBytes?: number; concurrency?: number } = {}) {
    this.#binary = options.binary ?? "git";
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maxBytes = options.maxBytes ?? 8_000_000;
    this.#semaphore = new Semaphore(options.concurrency ?? 4);
  }

  async run(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    const release = await this.#semaphore.acquire();
    try {
      return await this.#spawn(cwd, args, options, undefined);
    } finally {
      release();
    }
  }

  /**
   * Streams stdout records separated by `separator` to `onRecord`; returning
   * false from it stops Git early (used by search).
   */
  async stream(
    cwd: string,
    args: readonly string[],
    separator: string,
    onRecord: (record: string) => boolean | void,
    options: GitRunOptions = {}
  ): Promise<{ stopped: boolean }> {
    const release = await this.#semaphore.acquire();
    try {
      let stopped = false;
      await this.#spawn(cwd, args, { ...options, allowFailure: true }, (text, kill) => {
        const parts = text.split(separator);
        for (const record of parts) {
          if (onRecord(record) === false) {
            stopped = true;
            kill();
            return;
          }
        }
      }, separator);
      return { stopped };
    } finally {
      release();
    }
  }

  #spawn(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions,
    onText: ((text: string, kill: () => void) => void) | undefined,
    separator?: string
  ): Promise<GitResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(this.#binary, ["-C", cwd, ...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      const maxBytes = options.maxBytes ?? this.#maxBytes;
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let killed = false;
      let pending = "";
      const kill = () => {
        if (!killed) {
          killed = true;
          child.kill("SIGTERM");
        }
      };
      const timer = setTimeout(() => {
        kill();
        reject(new GitGraphProtocolError("git_unavailable", "Git command timed out.", { retryable: true }));
      }, this.#timeoutMs);
      const abort = () => kill();
      options.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        if (killed) return;
        if (onText && separator !== undefined) {
          pending += chunk.toString("utf8");
          const last = pending.lastIndexOf(separator);
          if (last >= 0) {
            const complete = pending.slice(0, last);
            pending = pending.slice(last + separator.length);
            onText(complete, kill);
          }
          return;
        }
        if (size + chunk.length > maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - size));
          size = maxBytes;
          truncated = true;
          kill();
          return;
        }
        size += chunk.length;
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (errors.length < 64) errors.push(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          error.code === "ENOENT"
            ? new GitGraphProtocolError("git_unavailable", `Git executable not found: ${this.#binary}`)
            : error
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (onText && !killed && pending) onText(pending, kill);
        if (options.signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        const stdout = Buffer.concat(chunks).toString("utf8");
        const exit = typeof code === "number" ? code : 1;
        if (exit !== 0 && !truncated && !killed && !options.allowFailure) {
          reject(
            new GitGraphProtocolError(
              "git_unavailable",
              Buffer.concat(errors).toString("utf8").trim() || `git ${args[0]} failed.`
            )
          );
          return;
        }
        resolveResult({ stdout, code: truncated || killed ? 0 : exit, truncated });
      });
    });
  }
}
