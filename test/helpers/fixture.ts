import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Isolated Git repositories for tests, built under the system temp directory
 * — never inside a working repository. Git runs with a fixed identity and
 * clock so object ids and order are deterministic, and without the user's
 * global configuration.
 */
export class Fixture {
  readonly root: string;
  #clock = 1_700_000_000;

  constructor(prefix = "hgg-fixture-") {
    this.root = mkdtempSync(join(tmpdir(), prefix));
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
    const date = `@${this.#clock} +0000`;
    return {
      ...env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Ada Lovelace",
      GIT_AUTHOR_EMAIL: "ada@example.test",
      GIT_COMMITTER_NAME: "Ada Lovelace",
      GIT_COMMITTER_EMAIL: "ada@example.test",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date
    };
  }

  git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      env: { ...this.env(), ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  }

  init(name: string, options: { branch?: string } = {}): string {
    const path = join(this.root, name);
    mkdirSync(path, { recursive: true });
    this.git(path, ["init", "-q", "-b", options.branch ?? "main"]);
    return path;
  }

  write(repo: string, file: string, content: string): void {
    const path = join(repo, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  /** Commits the given files (or an empty change) one clock tick after the previous commit. */
  commit(repo: string, message: string, files: Record<string, string> = {}, author?: { name: string; email: string }): string {
    this.#clock += 60;
    for (const [file, content] of Object.entries(files)) this.write(repo, file, content);
    if (Object.keys(files).length) this.git(repo, ["add", "--", ...Object.keys(files)]);
    this.git(
      repo,
      ["commit", "-q", "--allow-empty", "-m", message],
      author ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email } : {}
    );
    return this.git(repo, ["rev-parse", "HEAD"]);
  }

  merge(repo: string, branches: string[], message: string): string {
    this.#clock += 60;
    this.git(repo, ["merge", "-q", "--no-ff", "--no-edit", "-m", message, ...branches]);
    return this.git(repo, ["rev-parse", "HEAD"]);
  }

  /** A commit object that no branch points to, as Herdr checkpoints are written. */
  commitTree(repo: string, parent: string, message: string): string {
    this.#clock += 60;
    const tree = this.git(repo, ["rev-parse", `${parent}^{tree}`]);
    return this.git(repo, ["commit-tree", tree, "-p", parent, "-m", message]);
  }
}
