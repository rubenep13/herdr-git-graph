export interface PickerItem {
  id: string;
  name: string;
  displayPath: string;
  branch?: string;
}

/**
 * Filters repositories for the quick picker: every word of the query must
 * appear in the name, path or branch. Name prefix matches rank first, then
 * name matches, then path/branch matches; ties keep path order.
 */
export function filterRepositories<T extends PickerItem>(items: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const name = item.name.toLowerCase();
    const haystack = `${name} ${item.displayPath.toLowerCase()} ${(item.branch ?? "").toLowerCase()}`;
    if (!words.every((word) => haystack.includes(word))) return;
    const first = words[0]!;
    const score = name.startsWith(first) ? 0 : name.includes(first) ? 1 : 2;
    scored.push({ item, score, index });
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((entry) => entry.item);
}
