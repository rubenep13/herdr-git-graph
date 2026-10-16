import { authorColour, formatDate, formatFullDate, h, initials, prefs, relativeTime, shortOid, svg } from "./dom.ts";
import { MERGE_R, NODE_R, ROW_H, fitChips, graphWidth, laneColour, laneX, rowY, segmentPath } from "./geometry.ts";
import { WORKTREE_OID, splitMessage, type HistoryModel, type RefChip } from "./model.ts";

export interface GraphViewCallbacks {
  onSelect(row: number, open: boolean): void;
  onNeedMore(): void;
  onShowRefs(row: number, anchor: HTMLElement): void;
}

export interface ScrollAnchor {
  oid: string;
  offset: number;
}

export type OptionalColumn = "author" | "date" | "sha";

/** Columns GitKraken hides by default; the gear in the header turns them on. */
const OPTIONAL_COLUMNS: ReadonlyArray<{ key: OptionalColumn; label: string; width: number }> = [
  { key: "author", label: "Autor", width: 150 },
  { key: "date", label: "Fecha", width: 118 },
  { key: "sha", label: "SHA", width: 78 }
];

const OVERSCAN = 10;
const CHIP_FONT = '500 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const CHIP_PAD = 14;
const ICON_W = 16;
const REFS_DEFAULT = 190;
const REFS_MIN = 90;
const REFS_MAX = 640;
const GRAPH_USER_MIN = 64;

type IconName = "check" | "laptop" | "remote" | "tag" | "stash";

function icon(name: IconName): SVGSVGElement {
  const element = svg("svg", { class: `icon icon-${name}`, viewBox: "0 0 16 16", width: 13, height: 13, "aria-hidden": "true" });
  const stroke = { fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" };
  if (name === "check") {
    element.append(svg("path", { d: "M3 8.5l3.2 3.2L13 4.8", ...stroke, "stroke-width": 2.2 }));
  } else if (name === "laptop") {
    element.append(svg("rect", { x: 3, y: 3.5, width: 10, height: 7, rx: 1, ...stroke }), svg("path", { d: "M1.5 12.8h13", ...stroke }));
  } else if (name === "remote") {
    element.append(svg("path", { d: "M4.6 12.5a3.1 3.1 0 0 1-.3-6.2 4 4 0 0 1 7.6-.9 3.2 3.2 0 0 1 .2 6.4z", ...stroke }));
  } else if (name === "tag") {
    element.append(svg("path", { d: "M2.5 2.5h5.2l6 6-5.2 5.2-6-6z", ...stroke }), svg("circle", { cx: 5.6, cy: 5.6, r: 1.1, fill: "currentColor" }));
  } else {
    element.append(svg("rect", { x: 2.5, y: 3.5, width: 11, height: 9, rx: 1.5, ...stroke }), svg("path", { d: "M2.5 7h11", ...stroke }));
  }
  return element;
}

/** The icons of a label, in GitKraken's order: ✓ before the name, local/remote after it. */
function chipIcons(chip: RefChip): { before: IconName[]; after: IconName[] } {
  const before: IconName[] = chip.current ? ["check"] : [];
  const after: IconName[] = [];
  if (chip.kind === "branch") after.push("laptop");
  if (chip.kind === "remote" || chip.remotes.length) after.push("remote");
  if (chip.kind === "tag") before.push("tag");
  if (chip.kind === "stash") before.push("stash");
  return { before, after };
}

export class GraphView {
  readonly element: HTMLElement;
  readonly viewport: HTMLElement;
  readonly #callbacks: GraphViewCallbacks;
  readonly #header: HTMLElement;
  readonly #sizer: HTMLElement;
  readonly #window: HTMLElement;
  readonly #menu: HTMLElement;
  readonly #measure: CanvasRenderingContext2D | null;
  readonly #widths = new Map<string, number>();
  #model: HistoryModel | undefined;
  #selected = -1;
  #matches = new Set<string>();
  #refsWidth: number;
  #autoGraphWidth = graphWidth(1);
  #userGraphWidth: number | null;
  #columns: Record<OptionalColumn, boolean>;
  #rendered = { start: -1, end: -1, version: -1 };
  #version = 0;
  #frame = 0;

  constructor(callbacks: GraphViewCallbacks) {
    this.#callbacks = callbacks;
    this.#refsWidth = Math.min(REFS_MAX, Math.max(REFS_MIN, prefs.get("refsWidth.v2", REFS_DEFAULT)));
    this.#userGraphWidth = prefs.get<number | null>("graphWidth", null);
    this.#columns = { author: false, date: false, sha: false, ...prefs.get<Partial<Record<OptionalColumn, boolean>>>("columns", {}) };
    this.#measure = document.createElement("canvas").getContext("2d");

    this.#header = h("div", { class: "cols", role: "row" });
    this.#menu = h("div", { class: "col-menu hidden", role: "menu" });
    this.#window = h("div", { class: "window" });
    this.#sizer = h("div", { class: "sizer" }, this.#window);
    this.viewport = h("div", { class: "viewport", tabindex: 0, role: "grid", "aria-label": "Historial de commits" }, this.#sizer);
    this.element = h("section", { class: "history" }, this.#header, this.#menu, this.viewport);
    this.element.style.setProperty("--row-h", `${ROW_H}px`);
    this.#buildHeader();
    this.#applyWidths();

    this.viewport.addEventListener("scroll", () => this.#schedule(), { passive: true });
    new ResizeObserver(() => this.#schedule()).observe(this.viewport);
    this.#window.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const chip = target.closest<HTMLElement>(".chip, .chip-more");
      const row = target.closest<HTMLElement>(".row");
      if (!row) return;
      const index = Number(row.dataset.row);
      if (chip) {
        event.stopPropagation();
        this.#callbacks.onShowRefs(index, chip);
        return;
      }
      this.#callbacks.onSelect(index, true);
    });
    document.addEventListener("mousedown", (event) => {
      if (!this.#menu.contains(event.target as Node) && !(event.target as HTMLElement).closest(".col-gear")) this.#menu.classList.add("hidden");
    });
  }

  get model(): HistoryModel | undefined {
    return this.#model;
  }

  get selected(): number {
    return this.#selected;
  }

  setModel(model: HistoryModel | undefined, anchor?: ScrollAnchor): void {
    this.#model = model;
    this.#version += 1;
    this.#autoGraphWidth = graphWidth(model?.laneCount ?? 1);
    this.#applyWidths();
    this.#sizer.style.height = `${(model?.rowCount ?? 0) * ROW_H}px`;
    if (anchor && model) {
      const row = model.rowOf.get(anchor.oid);
      if (row !== undefined) this.viewport.scrollTop = row * ROW_H + anchor.offset;
    }
    this.render(true);
  }

  setSelected(row: number, scroll: "nearest" | "center" | false = "nearest"): void {
    this.#selected = row;
    if (scroll && row >= 0) this.scrollToRow(row, scroll);
    this.render(true);
  }

  setMatches(oids: Set<string>): void {
    this.#matches = oids;
    this.render(true);
  }

  anchor(): ScrollAnchor | undefined {
    const model = this.#model;
    if (!model?.rowCount) return undefined;
    const row = Math.min(model.rowCount - 1, Math.floor(this.viewport.scrollTop / ROW_H));
    const commit = model.commits[row];
    return commit ? { oid: commit.oid, offset: this.viewport.scrollTop - row * ROW_H } : undefined;
  }

  visibleRows(): number {
    return Math.max(1, Math.floor(this.viewport.clientHeight / ROW_H));
  }

  scrollToRow(row: number, mode: "nearest" | "center" = "nearest"): void {
    const top = row * ROW_H;
    const view = this.viewport;
    if (mode === "center") {
      view.scrollTop = Math.max(0, top - view.clientHeight / 2 + ROW_H / 2);
    } else if (top < view.scrollTop) {
      view.scrollTop = top;
    } else if (top + ROW_H > view.scrollTop + view.clientHeight) {
      view.scrollTop = top + ROW_H - view.clientHeight;
    }
  }

  get #graphWidth(): number {
    return this.#userGraphWidth ?? this.#autoGraphWidth;
  }

  #visibleOptional() {
    return OPTIONAL_COLUMNS.filter((column) => this.#columns[column.key]);
  }

  #schedule(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.render(false);
    });
  }

  #applyWidths(): void {
    const optional = this.#visibleOptional();
    const template = [`${this.#refsWidth}px`, `${this.#graphWidth}px`, "minmax(220px, 1fr)", ...optional.map((column) => `${column.width}px`)].join(" ");
    this.element.style.setProperty("--cols", template);
    this.element.style.setProperty("--refs-w", `${this.#refsWidth}px`);
    this.element.style.setProperty("--graph-w", `${this.#graphWidth}px`);
    this.element.style.setProperty("--tail-w", `${optional.reduce((sum, column) => sum + column.width, 0)}px`);
  }

  #buildHeader(): void {
    const refsResizer = h("div", { class: "col-resizer", title: "Arrastra para cambiar la anchura (doble clic: restablecer)" });
    const graphResizer = h("div", { class: "col-resizer", title: "Arrastra para cambiar la anchura del grafo (doble clic: automática)" });
    const gear = h("button", { class: "col-gear", type: "button", title: "Columnas", "aria-label": "Elegir columnas" });
    // Feather "settings" icon (MIT).
    const gearIcon = svg("svg", { viewBox: "0 0 24 24", width: 14, height: 14, "aria-hidden": "true" });
    gearIcon.append(
      svg("circle", { cx: 12, cy: 12, r: 3, fill: "none", stroke: "currentColor", "stroke-width": 2 }),
      svg("path", {
        d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round"
      })
    );
    gear.append(gearIcon);
    gear.addEventListener("click", () => this.#toggleMenu(gear));
    this.#header.replaceChildren(
      h("div", { class: "col col-refs", role: "columnheader" }, "Rama / Tag", refsResizer),
      h("div", { class: "col col-graph", role: "columnheader" }, "Grafo", graphResizer),
      h("div", { class: "col col-msg", role: "columnheader" }, "Mensaje del commit"),
      ...this.#visibleOptional().map((column) => h("div", { class: `col col-${column.key}`, role: "columnheader" }, column.label)),
      gear
    );
    this.#bindResizer(refsResizer, () => this.#refsWidth, (width) => {
      this.#refsWidth = Math.min(REFS_MAX, Math.max(REFS_MIN, width));
    }, () => prefs.set("refsWidth.v2", this.#refsWidth), () => {
      this.#refsWidth = REFS_DEFAULT;
      prefs.set("refsWidth.v2", this.#refsWidth);
    });
    this.#bindResizer(graphResizer, () => this.#graphWidth, (width) => {
      this.#userGraphWidth = Math.max(GRAPH_USER_MIN, width);
    }, () => prefs.set("graphWidth", this.#userGraphWidth), () => {
      this.#userGraphWidth = null;
      prefs.set("graphWidth", null);
    });
  }

  #toggleMenu(anchor: HTMLElement): void {
    if (!this.#menu.classList.contains("hidden")) {
      this.#menu.classList.add("hidden");
      return;
    }
    const items = OPTIONAL_COLUMNS.map((column) => {
      const input = h("input", { type: "checkbox", ...(this.#columns[column.key] ? { checked: true } : {}) });
      input.addEventListener("change", () => {
        this.#columns = { ...this.#columns, [column.key]: input.checked };
        prefs.set("columns", this.#columns);
        this.#buildHeader();
        this.#applyWidths();
        this.render(true);
      });
      return h("label", { class: "col-menu-item" }, input, column.label);
    });
    this.#menu.replaceChildren(h("div", { class: "col-menu-title" }, "Columnas"), ...items);
    this.#menu.style.top = `${anchor.offsetTop + anchor.offsetHeight + 4}px`;
    this.#menu.classList.remove("hidden");
  }

  #bindResizer(handle: HTMLElement, current: () => number, set: (width: number) => void, save: () => void, reset: () => void): void {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = current();
      const move = (moveEvent: PointerEvent) => {
        set(startWidth + moveEvent.clientX - startX);
        this.#applyWidths();
        this.render(true);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        save();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    handle.addEventListener("dblclick", () => {
      reset();
      this.#applyWidths();
      this.render(true);
    });
  }

  #textWidth(text: string, font: string): number {
    const key = `${font}|${text}`;
    let width = this.#widths.get(key);
    if (width === undefined) {
      if (this.#measure) {
        this.#measure.font = font;
        width = this.#measure.measureText(text).width;
      } else {
        width = text.length * 7;
      }
      this.#widths.set(key, width);
    }
    return width;
  }

  #chipWidth(chip: RefChip): number {
    const icons = chipIcons(chip);
    return Math.ceil(this.#textWidth(chip.label, CHIP_FONT)) + CHIP_PAD + (icons.before.length + icons.after.length) * ICON_W;
  }

  #renderChips(chips: RefChip[], colour: string): HTMLElement {
    const cell = h("div", { class: "cell refs" });
    const fit = fitChips(
      chips.map((chip) => this.#chipWidth(chip)),
      this.#refsWidth - 14,
      (hidden) => Math.ceil(this.#textWidth(`+${hidden}`, CHIP_FONT)) + 12
    );
    fit.shown.forEach((chipIndex, index) => {
      const chip = chips[chipIndex]!;
      const icons = chipIcons(chip);
      const remotes = chip.remotes.length && chip.kind !== "remote" ? `\nTambién en: ${chip.remotes.join(", ")}` : "";
      const element = h(
        "span",
        {
          class: `chip chip-${chip.kind}${chip.current ? " current" : ""}`,
          title: `${chip.names.join("\n")}${chip.current && chip.kind === "branch" ? "\n(rama actual, HEAD)" : ""}${remotes}`,
          role: "button"
        },
        ...icons.before.map(icon),
        h("span", { class: "chip-label" }, chip.label),
        ...icons.after.map(icon)
      );
      element.style.setProperty("--c", colour);
      if (index === 0 && fit.firstMaxWidth !== undefined) element.style.setProperty("--fit", `${fit.firstMaxWidth}px`);
      cell.append(element);
    });
    if (fit.hidden) {
      const hiddenNames = chips.filter((_, chipIndex) => !fit.shown.includes(chipIndex)).flatMap((chip) => chip.names);
      const more = h("span", { class: "chip-more", role: "button", title: hiddenNames.join("\n") }, `+${fit.hidden}`);
      more.style.setProperty("--c", colour);
      cell.append(more);
    }
    const leader = h("span", { class: "leader" });
    leader.style.setProperty("--c", colour);
    cell.append(leader);
    return cell;
  }

  render(force: boolean): void {
    const model = this.#model;
    if (!model) {
      this.#window.replaceChildren();
      this.#rendered = { start: -1, end: -1, version: this.#version };
      return;
    }
    const first = Math.floor(this.viewport.scrollTop / ROW_H);
    const start = Math.max(0, first - OVERSCAN);
    const end = Math.min(model.rowCount, first + this.visibleRows() + 1 + OVERSCAN);
    if (end >= model.rowCount - 60) this.#callbacks.onNeedMore();
    if (!force && start === this.#rendered.start && end === this.#rendered.end && this.#version === this.#rendered.version) {
      return;
    }
    this.#rendered = { start, end, version: this.#version };
    this.#window.style.transform = `translateY(${start * ROW_H}px)`;

    const width = this.#graphWidth;
    const graph = svg("svg", { class: "graph", width, height: Math.max(0, (end - start) * ROW_H), "aria-hidden": "true" });
    const bands = svg("g", { class: "bands" });
    const connectors = svg("g", { class: "connectors" });
    const lanes = svg("g", { class: "lanes" });
    const nodes = svg("g", { class: "nodes" });
    graph.append(bands, connectors, lanes, nodes);

    for (const segment of model.segmentsBetween(start, end)) {
      const path = svg("path", { d: segmentPath(segment, start), stroke: laneColour(segment.colour) });
      if (segment.dangling) path.setAttribute("class", "dangling");
      lanes.append(path);
    }

    const now = Date.now();
    const optional = this.#visibleOptional();
    const rows: HTMLElement[] = [];
    for (let index = start; index < end; index += 1) {
      const commit = model.commits[index]!;
      const node = model.node(index)!;
      const wip = commit.kind === "working-tree";
      const colour = wip ? "#8d96a0" : laneColour(node.colour);
      const x = laneX(node.lane);
      const top = (index - start) * ROW_H;
      const y = rowY(index, start);
      const chips = model.chips.get(commit.oid) ?? [];
      const selected = index === this.#selected;

      // The row's tint, from its node to the edge of the graph (GitKraken's lane band).
      bands.append(svg("rect", { x, y: top + 1, width: Math.max(0, width - x), height: ROW_H - 2, fill: colour, class: selected ? "band selected" : "band" }));
      if (chips.length) connectors.append(svg("line", { x1: 0, y1: y, x2: x - NODE_R, y2: y, stroke: colour }));

      if (wip) {
        nodes.append(svg("circle", { cx: x, cy: y, r: NODE_R - 1, class: "node-wip" }));
      } else if (commit.kind === "stash") {
        nodes.append(svg("rect", { x: x - 7, y: y - 7, width: 14, height: 14, rx: 3, class: "node-stash", stroke: colour }));
      } else if (commit.parents.length > 1) {
        nodes.append(svg("circle", { cx: x, cy: y, r: MERGE_R, fill: colour, class: "node-merge" }));
      } else {
        const author = commit.author?.name ?? commit.author?.email;
        nodes.append(
          svg("circle", { cx: x, cy: y, r: NODE_R, fill: authorColour(commit.author?.email ?? author), stroke: colour, class: "node-commit" })
        );
        const text = svg("text", { x, y: y + 0.5, class: "node-initials" });
        text.textContent = initials(author);
        nodes.append(text);
      }

      const classes = ["row"];
      if (selected) classes.push("selected");
      if (this.#matches.has(commit.oid)) classes.push("match");
      if (commit.kind !== "commit") classes.push(`row-${commit.kind}`);
      if (commit.parents.length > 1) classes.push("row-merge");

      let message: HTMLElement;
      if (commit.oid === WORKTREE_OID) {
        const counts = commit.worktree ?? { staged: 0, unstaged: 0, untracked: 0 };
        message = h(
          "div",
          { class: "cell msg" },
          h("span", { class: "subject wip" }, "// WIP"),
          counts.staged ? h("span", { class: "wt-count wt-staged", title: "Preparados (staged)" }, `${counts.staged} preparados`) : null,
          counts.unstaged ? h("span", { class: "wt-count wt-unstaged", title: "Sin preparar (unstaged)" }, `${counts.unstaged} sin preparar`) : null,
          counts.untracked ? h("span", { class: "wt-count wt-untracked", title: "Sin seguimiento (untracked)" }, `${counts.untracked} sin seguimiento`) : null
        );
      } else {
        const { subject, description } = splitMessage(commit.message);
        const who = commit.author?.name ? `${commit.author.name}${commit.author.email ? ` <${commit.author.email}>` : ""}` : "";
        message = h(
          "div",
          { class: "cell msg", title: `${commit.message}\n\n${who}\n${formatFullDate(commit.authoredAt)} · ${shortOid(commit.oid)}` },
          h("span", { class: "subject" }, subject),
          description ? h("span", { class: "desc" }, description) : null
        );
      }
      message.style.setProperty("--c", colour);

      const extra = optional.map((column) => {
        if (column.key === "author") return h("div", { class: "cell author", title: commit.author?.email ?? "" }, commit.author?.name ?? "");
        if (column.key === "date") {
          const when = commit.authoredAt ?? commit.committedAt;
          return h("div", { class: "cell date", title: formatFullDate(when) }, formatDate(when));
        }
        return h("div", { class: "cell hash", title: wip ? "" : commit.oid }, wip ? "" : shortOid(commit.oid));
      });

      // A relative-time marker where the time bucket changes, as GitKraken does.
      const when = relativeTime(commit.authoredAt ?? commit.committedAt, now);
      const previous = index > 0 ? model.commits[index - 1] : undefined;
      const previousWhen = previous ? relativeTime(previous.authoredAt ?? previous.committedAt, now) : undefined;
      // Like GitKraken, the newest group has no marker; each later group gets one on its top edge.
      const marker = index > 0 && when && when !== previousWhen ? h("span", { class: "when", title: formatFullDate(commit.authoredAt ?? commit.committedAt) }, when) : null;

      const row = h(
        "div",
        { class: classes.join(" "), "data-row": index, "data-oid": commit.oid, role: "row", "aria-selected": selected ? "true" : "false" },
        chips.length ? this.#renderChips(chips, colour) : h("div", { class: "cell refs" }),
        h("div", { class: "cell graph-cell" }),
        message,
        ...extra,
        marker
      );
      rows.push(row);
    }
    graph.style.left = `${this.#refsWidth}px`;
    this.#window.replaceChildren(graph, ...rows);
  }
}
