import type { GitGraphChange, GitGraphCommitDetails, GitGraphRef, GitGraphRevision } from "@web-git-graph/protocol";
import { api, ApiError, type WorktreeFile, type WorktreeSection, type WorktreeStatus } from "./api.ts";
import { parsePatch } from "./diff.ts";
import { authorColour, formatFullDate, h, initials, prefs, relativeTime, shortOid } from "./dom.ts";

export const EMPTY_TREE_REVISION = "__EMPTY_TREE__";
const MAX_DIFF_LINES = 4000;

export interface DetailsHost {
  repoId(): string | undefined;
  subjectOf(oid: string): string | undefined;
  jumpTo(oid: string): void;
  close(): void;
}

const CHANGE_LETTER: Record<GitGraphChange["kind"], string> = {
  add: "A",
  modify: "M",
  delete: "D",
  rename: "R",
  copy: "C",
  binary: "B",
  submodule: "S",
  unknown: "?"
};

const SECTION_TITLES: Record<WorktreeSection, string> = {
  conflicted: "Conflictos",
  staged: "Preparados (staged)",
  unstaged: "Sin preparar (unstaged)",
  untracked: "Sin seguimiento (untracked)"
};

function refLabel(ref: GitGraphRef): string {
  if (ref.kind === "current") return ref.name === "HEAD" ? "HEAD (detached)" : `HEAD → ${ref.name}`;
  return ref.name.replace(/^refs\/(heads|tags|remotes)\//, "");
}

export function renderPatch(patch: string | undefined, options: { truncated?: boolean; binary?: boolean; reason?: string } = {}): HTMLElement {
  const container = h("div", { class: "patch" });
  if (options.binary) container.append(h("div", { class: "patch-note" }, "Archivo binario: no hay diff de texto."));
  if (!patch) {
    container.append(h("div", { class: "patch-note" }, options.reason ?? "Sin cambios de texto."));
    return container;
  }
  const lines = parsePatch(patch);
  const table = h("div", { class: "patch-lines" });
  const draw = (limit: number) => {
    const rows: HTMLElement[] = [];
    for (const line of lines.slice(0, limit)) {
      if (line.kind === "meta" && /^(diff --git|index |--- |\+\+\+ )/.test(line.text)) continue;
      rows.push(
        h(
          "div",
          { class: `pl pl-${line.kind}` },
          h("span", { class: "ln" }, line.oldNo !== undefined ? String(line.oldNo) : ""),
          h("span", { class: "ln" }, line.newNo !== undefined ? String(line.newNo) : ""),
          h("span", { class: "code" }, line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "ctx" ? " " : "", line.text)
        )
      );
    }
    table.replaceChildren(...rows);
  };
  draw(MAX_DIFF_LINES);
  container.append(table);
  if (lines.length > MAX_DIFF_LINES) {
    const more = h("button", { class: "btn small", type: "button" }, `Mostrar las ${lines.length} líneas`);
    more.addEventListener("click", () => {
      draw(lines.length);
      more.remove();
    });
    container.append(more);
  }
  if (options.truncated) container.append(h("div", { class: "patch-note" }, "Diff truncado por tamaño."));
  return container;
}

/** The right-hand panel: one commit, or the working tree. Diffs load only when a file is chosen. */
export class DetailsPanel {
  readonly element: HTMLElement;
  readonly #host: DetailsHost;
  readonly #body: HTMLElement;
  #abort: AbortController | undefined;
  #diffAbort: AbortController | undefined;
  #current: string | undefined;

  constructor(host: DetailsHost) {
    this.#host = host;
    const close = h("button", { class: "icon-btn", type: "button", title: "Cerrar (Esc)", "aria-label": "Cerrar detalle" }, "×");
    close.addEventListener("click", () => host.close());
    this.#body = h("div", { class: "details-body" });
    this.element = h("aside", { class: "details", "aria-label": "Detalle" }, h("div", { class: "details-top" }, close), this.#body);
    this.element.style.setProperty("--panel-w", `${prefs.get("panelWidth", 520)}px`);
  }

  get current(): string | undefined {
    return this.#current;
  }

  clear(): void {
    this.#abort?.abort();
    this.#diffAbort?.abort();
    this.#current = undefined;
    this.#body.replaceChildren();
  }

  #begin(key: string): AbortSignal {
    this.#abort?.abort();
    this.#diffAbort?.abort();
    this.#abort = new AbortController();
    this.#current = key;
    return this.#abort.signal;
  }

  #error(error: unknown): HTMLElement {
    const message = error instanceof ApiError ? error.message : "No se pudo cargar.";
    return h("div", { class: "state state-error" }, message);
  }

  async showCommit(oid: string): Promise<void> {
    const id = this.#host.repoId();
    if (!id) return;
    const signal = this.#begin(oid);
    this.#body.replaceChildren(h("div", { class: "state" }, "Cargando commit…"));
    let details: GitGraphCommitDetails;
    try {
      details = await api.commit(id, oid, signal);
    } catch (error) {
      if ((error as Error).name !== "AbortError") this.#body.replaceChildren(this.#error(error));
      return;
    }
    if (signal.aborted) return;
    const commit = details.commit;
    const [subject = "", ...rest] = (details.body ?? commit.message).split("\n");
    const body = rest.join("\n").trim();
    const copy = h("button", { class: "btn small", type: "button", title: "Copiar hash completo" }, "Copiar");
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(commit.oid).then(() => {
        copy.textContent = "Copiado";
        setTimeout(() => (copy.textContent = "Copiar"), 1200);
      });
    });
    const parents = h("div", { class: "parents" });
    for (const parent of commit.parents) {
      const link = h("button", { class: "link mono", type: "button", title: parent }, shortOid(parent));
      link.addEventListener("click", () => this.#host.jumpTo(parent));
      parents.append(h("div", { class: "parent" }, link, h("span", { class: "muted" }, this.#host.subjectOf(parent) ?? "")));
    }
    if (!commit.parents.length) parents.append(h("span", { class: "muted" }, "Ninguno (commit raíz)"));
    const avatar = h("span", { class: "avatar", "aria-hidden": "true" }, initials(commit.author?.name ?? commit.author?.email));
    avatar.style.background = authorColour(commit.author?.email ?? commit.author?.name);
    const meta = h(
      "dl",
      { class: "meta" },
      h("dt", {}, "Commit"),
      h("dd", {}, h("span", { class: "mono select" }, commit.oid), copy),
      h("dt", {}, "Autor"),
      h("dd", {}, avatar, h("span", {}, `${commit.author?.name ?? ""}${commit.author?.email ? ` <${commit.author.email}>` : ""}`)),
      h("dt", {}, "Fecha"),
      h("dd", {}, `${formatFullDate(commit.authoredAt)} · ${relativeTime(commit.authoredAt)}`),
      ...(commit.committedAt && commit.committedAt !== commit.authoredAt
        ? [h("dt", {}, "Commit el"), h("dd", {}, formatFullDate(commit.committedAt))]
        : []),
      h("dt", {}, commit.parents.length > 1 ? `Padres (${commit.parents.length})` : "Padre"),
      h("dd", {}, parents),
      ...(details.refs.length
        ? [h("dt", {}, "Refs"), h("dd", { class: "ref-list" }, ...details.refs.map((ref) => h("span", { class: `ref-pill ref-${ref.kind}`, title: ref.name }, refLabel(ref))))]
        : [])
    );
    const files = h("div", { class: "files" });
    const diff = h("div", { class: "diff" });
    const header = h(
      "div",
      { class: "files-head" },
      h("span", {}, `${commit.changedFiles ?? details.changes.length} archivos`),
      h("span", { class: "add" }, `+${commit.additions ?? 0}`),
      h("span", { class: "del" }, `−${commit.deletions ?? 0}`)
    );
    const content = h("div", { class: "commit" }, h("h2", { class: "subject" }, subject), body ? h("pre", { class: "body" }, body) : null, meta);
    if (commit.parents.length > 1) {
      const selector = h("div", { class: "segmented", role: "tablist", "aria-label": "Comparar con el padre" });
      commit.parents.forEach((parent, index) => {
        const button = h("button", { type: "button", class: index === 0 ? "on" : "", role: "tab" }, `Padre ${index + 1} · ${shortOid(parent)}`);
        button.addEventListener("click", () => {
          selector.querySelectorAll("button").forEach((item) => item.classList.remove("on"));
          button.classList.add("on");
          void this.#loadComparison(id, parent, commit.oid, files, diff, header);
        });
        selector.append(button);
      });
      content.append(h("div", { class: "merge-note" }, h("span", { class: "muted" }, "Cambios respecto a"), selector));
    }
    content.append(header, files, diff);
    this.#body.replaceChildren(content);
    const base: GitGraphRevision = { kind: "commit", oid: commit.parents[0] ?? EMPTY_TREE_REVISION };
    this.#renderFiles(files, diff, details.changes, (change) => api.fileDiff(id, base, { kind: "commit", oid: commit.oid }, change.path, this.#diffSignal()));
  }

  async #loadComparison(id: string, parent: string, oid: string, files: HTMLElement, diff: HTMLElement, header: HTMLElement): Promise<void> {
    files.replaceChildren(h("div", { class: "state" }, "Comparando…"));
    diff.replaceChildren();
    const base: GitGraphRevision = { kind: "commit", oid: parent };
    const head: GitGraphRevision = { kind: "commit", oid };
    try {
      const comparison = await api.compare(id, base, head, this.#abort?.signal);
      header.replaceChildren(
        h("span", {}, `${comparison.changes.length} archivos`),
        h("span", { class: "add" }, `+${comparison.additions}`),
        h("span", { class: "del" }, `−${comparison.deletions}`)
      );
      this.#renderFiles(files, diff, comparison.changes, (change) => api.fileDiff(id, base, head, change.path, this.#diffSignal()));
    } catch (error) {
      if ((error as Error).name !== "AbortError") files.replaceChildren(this.#error(error));
    }
  }

  #diffSignal(): AbortSignal {
    this.#diffAbort?.abort();
    this.#diffAbort = new AbortController();
    return this.#diffAbort.signal;
  }

  #renderFiles(
    container: HTMLElement,
    diff: HTMLElement,
    changes: readonly GitGraphChange[],
    load: (change: GitGraphChange) => Promise<{ patch?: string; truncated?: boolean; binary?: boolean; unavailableReason?: string }>
  ): void {
    if (!changes.length) {
      container.replaceChildren(h("div", { class: "state" }, "Este commit no cambia archivos."));
      return;
    }
    const buttons = changes.map((change) => {
      const button = h(
        "button",
        { class: "file", type: "button", title: change.previousPath ? `${change.previousPath} → ${change.path}` : change.path },
        h("span", { class: `st st-${CHANGE_LETTER[change.kind]}` }, CHANGE_LETTER[change.kind]),
        h("span", { class: "path" }, change.previousPath ? `${change.previousPath} → ${change.path}` : change.path),
        change.binary ? h("span", { class: "muted" }, "bin") : h("span", { class: "stat" }, h("span", { class: "add" }, `+${change.additions ?? 0}`), h("span", { class: "del" }, `−${change.deletions ?? 0}`))
      );
      button.addEventListener("click", () => select(button, change));
      return button;
    });
    const select = (button: HTMLElement, change: GitGraphChange) => {
      buttons.forEach((item) => item.classList.toggle("on", item === button));
      diff.replaceChildren(h("div", { class: "state" }, "Cargando diff…"));
      load(change).then(
        (result) => {
          if (!button.classList.contains("on")) return;
          diff.replaceChildren(
            h("div", { class: "diff-title mono" }, change.path),
            renderPatch(result.patch, {
              ...(result.truncated ? { truncated: true } : {}),
              ...(result.binary || change.binary ? { binary: true } : {}),
              ...(result.unavailableReason ? { reason: result.unavailableReason } : {})
            })
          );
        },
        (error: unknown) => {
          if ((error as Error).name !== "AbortError") diff.replaceChildren(this.#error(error));
        }
      );
    };
    this.#bindListKeys(container, buttons);
    container.replaceChildren(...buttons);
  }

  #bindListKeys(container: HTMLElement, buttons: HTMLElement[]): void {
    container.onkeydown = (event) => {
      const index = buttons.indexOf(document.activeElement as HTMLElement);
      if (index < 0) return;
      const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : -1;
      if (next >= 0 && next < buttons.length) {
        event.preventDefault();
        event.stopPropagation();
        buttons[next]!.focus();
        buttons[next]!.click();
      }
    };
  }

  showWorktree(status: WorktreeStatus | undefined, error?: unknown): void {
    const id = this.#host.repoId();
    if (!id) return;
    const previous = this.#current === "worktree" ? this.#body.querySelector<HTMLElement>(".file.on")?.dataset.key : undefined;
    this.#begin("worktree");
    if (!status) {
      this.#body.replaceChildren(error ? this.#error(error) : h("div", { class: "state" }, "Cargando cambios…"));
      return;
    }
    const sections = (["conflicted", "staged", "unstaged", "untracked"] as const).filter((section) => status[section].length);
    const diff = h("div", { class: "diff" });
    const tracking = status.upstream
      ? `${status.upstream}${status.ahead || status.behind ? ` · ↑${status.ahead ?? 0} ↓${status.behind ?? 0}` : ""}`
      : "sin upstream";
    const content = h(
      "div",
      { class: "commit" },
      h("h2", { class: "subject" }, "Cambios sin commit"),
      h(
        "dl",
        { class: "meta" },
        h("dt", {}, "Rama"),
        h("dd", {}, status.detached ? "HEAD detached" : status.branch ?? ""),
        h("dt", {}, "Upstream"),
        h("dd", {}, tracking)
      ),
      h("p", { class: "muted note" }, "Solo lectura: prepara, descarta o confirma cambios desde la terminal.")
    );
    if (!sections.length) content.append(h("div", { class: "state" }, "El árbol de trabajo está limpio."));
    const buttons: HTMLElement[] = [];
    let restore: HTMLElement | undefined;
    for (const section of sections) {
      const list = h("div", { class: "files" });
      for (const file of status[section]) {
        const key = `${section}:${file.path}`;
        const button = h(
          "button",
          { class: "file", type: "button", "data-key": key, title: file.previousPath ? `${file.previousPath} → ${file.path}` : file.path },
          h("span", { class: `st st-${file.status === "?" ? "A" : file.status}` }, file.status === "?" ? "U" : file.status),
          h("span", { class: "path" }, file.previousPath ? `${file.previousPath} → ${file.path}` : file.path)
        );
        button.addEventListener("click", () => this.#selectWorktreeFile(id, section, file, button, buttons, diff));
        buttons.push(button);
        list.append(button);
        if (key === previous) restore = button;
      }
      content.append(h("div", { class: `files-head section-${section}` }, h("span", {}, `${SECTION_TITLES[section]} · ${status[section].length}`)), list);
    }
    this.#bindListKeys(content, buttons);
    content.append(diff);
    this.#body.replaceChildren(content);
    restore?.click();
  }

  #selectWorktreeFile(id: string, section: WorktreeSection, file: WorktreeFile, button: HTMLElement, buttons: HTMLElement[], diff: HTMLElement): void {
    buttons.forEach((item) => item.classList.toggle("on", item === button));
    diff.replaceChildren(h("div", { class: "state" }, "Cargando diff…"));
    api.worktreeDiff(id, section, file.path, this.#diffSignal()).then(
      (result) => {
        if (!button.classList.contains("on")) return;
        diff.replaceChildren(
          h("div", { class: "diff-title mono" }, `${SECTION_TITLES[section]} · ${file.path}`),
          renderPatch(result.patch, {
            ...(result.truncated ? { truncated: true } : {}),
            ...(result.binary ? { binary: true } : {}),
            ...(result.unavailableReason ? { reason: result.unavailableReason } : {})
          })
        );
      },
      (error: unknown) => {
        if ((error as Error).name !== "AbortError") diff.replaceChildren(this.#error(error));
      }
    );
  }
}
