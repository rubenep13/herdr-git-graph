import { GitGraphProtocolError } from "@web-git-graph/protocol";
import type { GitRunner } from "./git.ts";
import type { RepoEntry } from "./registry.ts";

export type SearchField = "hash" | "message" | "author";

export interface SearchResult {
  oid: string;
  subject: string;
  author: string;
  email: string;
  authoredAt: string;
  matched: SearchField[];
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  /** True when the limit was reached before the history ended. */
  limited: boolean;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

/**
 * Searches the whole history reachable from the same tips the graph walks
 * (branches, remote branches, tags and HEAD — never refs/herdr-gpui), by hash
 * prefix, author name/e-mail and full message. One `git log` process streams
 * the commits and stops as soon as `limit` matches were found.
 */
export async function searchCommits(
  git: GitRunner,
  repository: RepoEntry,
  rawQuery: string,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<SearchResponse> {
  const query = rawQuery.trim();
  if (!query || query.length > 200) {
    throw new GitGraphProtocolError("bad_request", "The search needs 1 to 200 characters.");
  }
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  const needle = query.toLowerCase();
  const hashLike = /^[0-9a-f]{4,64}$/i.test(query);
  const head = await git.run(repository.path, ["rev-parse", "--verify", "--quiet", "HEAD"], {
    allowFailure: true,
    ...(options.signal ? { signal: options.signal } : {})
  });
  const results: SearchResult[] = [];
  const { stopped } = await git.stream(
    repository.path,
    [
      "log",
      "--date-order",
      "--no-color",
      `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%B${RECORD}`,
      "--branches",
      "--remotes",
      "--tags",
      ...(head.code === 0 ? ["HEAD"] : []),
      "--"
    ],
    RECORD,
    (record) => {
      const text = record.replace(/^\n/, "");
      if (!text) return;
      const [oid, author = "", email = "", authoredAt = "", message = ""] = text.split(FIELD);
      if (!oid) return;
      const matched: SearchField[] = [];
      if (hashLike && oid.startsWith(needle)) matched.push("hash");
      if (author.toLowerCase().includes(needle) || email.toLowerCase().includes(needle)) matched.push("author");
      if (message.toLowerCase().includes(needle)) matched.push("message");
      if (!matched.length) return;
      results.push({
        oid,
        subject: message.split("\n", 1)[0] ?? "",
        author,
        email,
        authoredAt,
        matched
      });
      if (results.length >= limit) return false;
    },
    options.signal ? { signal: options.signal } : {}
  );
  return { query, results, limited: stopped };
}
