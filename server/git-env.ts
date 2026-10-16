/**
 * Every Git process this server starts — ours and the ones
 * @web-git-graph/node spawns, which inherit process.env — runs with this
 * environment, so viewing a repository never writes to it:
 *
 * - GIT_OPTIONAL_LOCKS=0: `git status` / `git diff` refresh the index in
 *   memory only and never rewrite .git/index (or take index.lock).
 * - core.fsmonitor=false and core.hooksPath=/dev/null: no repository hook or
 *   fsmonitor daemon is ever executed.
 * - GIT_NO_LAZY_FETCH=1 and protocol.allow=never: a partial clone never
 *   fetches missing objects; no command can reach a remote.
 * - gc.auto=0 and maintenance.auto=false: no automatic housekeeping.
 * - Inherited GIT_* variables (GIT_DIR, GIT_INDEX_FILE, ...) are dropped so
 *   the server cannot be pointed at another repository by its parent shell.
 */
export const READ_ONLY_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["protocol.allow", "never"],
  ["submodule.recurse", "false"],
  ["color.ui", "false"],
  ["core.pager", "cat"]
];

export function readOnlyGitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_COUNT = String(READ_ONLY_GIT_CONFIG.length);
  READ_ONLY_GIT_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** Replaces process.env in place, before any Git process is spawned. */
export function applyReadOnlyGitEnvironment(): void {
  const env = readOnlyGitEnvironment(process.env);
  for (const key of Object.keys(process.env)) {
    if (!(key in env)) delete process.env[key];
  }
  Object.assign(process.env, env);
}
