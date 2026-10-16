export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "ctx" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** Parses a unified patch into lines with old/new line numbers. */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const source = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  for (const text of source.split("\n")) {
    const hunk = /^@@@? -(\d+)(?:,\d+)? (?:-\d+(?:,\d+)? )?\+(\d+)(?:,\d+)? @@@?/.exec(text);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text });
    } else if (!inHunk || text.startsWith("diff --git ") || text.startsWith("diff --cc ")) {
      inHunk = false;
      lines.push({ kind: "meta", text });
    } else if (text.startsWith("\\")) {
      lines.push({ kind: "note", text });
    } else if (text.startsWith("+")) {
      lines.push({ kind: "add", text: text.slice(1), newNo: newNo++ });
    } else if (text.startsWith("-")) {
      lines.push({ kind: "del", text: text.slice(1), oldNo: oldNo++ });
    } else {
      lines.push({ kind: "ctx", text: text.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return lines;
}
