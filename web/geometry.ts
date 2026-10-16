import type { GitGraphSegment } from "@web-git-graph/web";

// Proportions of GitKraken's graph: tall rows, avatar-sized nodes, wide lanes.
export const ROW_H = 30;
export const LANE_W = 22;
export const GRAPH_PAD = 12;
/** Radius of a commit node (an author bubble). */
export const NODE_R = 10;
/** Radius of a merge commit dot. */
export const MERGE_R = 5;
/** Never narrower than its column header. */
export const GRAPH_MIN_W = 64;

/** GitKraken's default graph colours, in its lane order. */
export const PALETTE = [
  "#15a0bf",
  "#0669f7",
  "#8e00c2",
  "#c517b6",
  "#d90171",
  "#cd0101",
  "#f25d2e",
  "#f2ca33",
  "#7bd938",
  "#2ece9d"
] as const;

export function laneColour(colour: number): string {
  return PALETTE[((colour % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
}

export function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_W + LANE_W / 2;
}

export function graphWidth(laneCount: number): number {
  return Math.max(GRAPH_MIN_W, GRAPH_PAD * 2 + Math.max(1, laneCount) * LANE_W);
}

export function rowY(row: number, originRow = 0): number {
  return (row - originRow) * ROW_H + ROW_H / 2;
}

/**
 * The SVG path of a layout segment, relative to `originRow`, drawn as
 * GitKraken does: a lane runs straight down; where it meets another lane it
 * turns at a right angle with a rounded corner, and the horizontal part sits
 * on the row of the node it belongs to (`anchor`): leaving a merge node
 * ("from") it goes out sideways then down; arriving at the commit that
 * absorbs it ("to") it comes down then sideways into the node.
 */
export function segmentPath(segment: GitGraphSegment, originRow = 0): string {
  const x1 = laneX(segment.from.lane);
  const x2 = laneX(segment.to.lane);
  const y1 = rowY(segment.from.row, originRow);
  const y2 = rowY(segment.to.row, originRow);
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const direction = x2 > x1 ? 1 : -1;
  const radius = Math.min(LANE_W / 2, (y2 - y1) / 2, Math.abs(x2 - x1) / 2);
  if (segment.anchor === "from") {
    // Out of the node sideways, round the corner, then down the new lane.
    const sweep = direction > 0 ? 1 : 0;
    return `M ${x1} ${y1} H ${x2 - direction * radius} A ${radius} ${radius} 0 0 ${sweep} ${x2} ${y1 + radius} V ${y2}`;
  }
  // Down the old lane, round the corner, then sideways into the node.
  const sweep = direction > 0 ? 0 : 1;
  return `M ${x1} ${y1} V ${y2 - radius} A ${radius} ${radius} 0 0 ${sweep} ${x1 + direction * radius} ${y2} H ${x2}`;
}

export interface ChipFit {
  /** Indices of the chips shown, in priority order. */
  shown: number[];
  /** Chips folded into the "+N" badge. */
  hidden: number;
  /** Width left for the only chip shown when even it does not fit (it is then ellipsised). */
  firstMaxWidth?: number;
}

/**
 * Which reference labels fit in the BRANCH / TAG column, in priority order,
 * keeping room for a "+N" badge and a short connector to the graph. A label
 * too wide to fit is skipped so the ones after it can still show; the first
 * one is always shown, ellipsised if needed.
 */
export function fitChips(
  widths: readonly number[],
  available: number,
  badgeWidth: (hidden: number) => number,
  gap = 4,
  minLeader = 14
): ChipFit {
  const space = available - minLeader;
  const total = widths.length;
  if (!total) return { shown: [], hidden: 0 };
  const shown: number[] = [];
  let used = 0;
  for (let index = 0; index < total; index += 1) {
    const next = used + (shown.length ? gap : 0) + widths[index]!;
    // Room for a badge counting every chip not shown so far or after this one.
    const notShown = total - shown.length - 1;
    const reserve = notShown ? gap + badgeWidth(notShown) : 0;
    if (next + reserve <= space) {
      used = next;
      shown.push(index);
    }
  }
  if (!shown.length || shown[0] !== 0) {
    // The highest-priority label always shows; it takes the room it needs, ellipsised.
    const others = shown.filter((index) => index !== 0);
    const othersWidth = others.reduce((sum, index) => sum + widths[index]! + gap, 0);
    const hidden = total - 1 - others.length;
    const reserve = hidden ? gap + badgeWidth(hidden) : 0;
    const room = space - othersWidth - reserve;
    if (room >= Math.min(widths[0]!, 60)) {
      return { shown: [0, ...others], hidden, ...(room < widths[0]! ? { firstMaxWidth: room } : {}) };
    }
    const alone = total - 1;
    return { shown: [0], hidden: alone, firstMaxWidth: Math.max(24, space - (alone ? gap + badgeWidth(alone) : 0)) };
  }
  return { shown, hidden: total - shown.length };
}
