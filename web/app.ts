import type { GitGraphCommit, GitGraphPage, GitGraphRef } from "@web-git-graph/protocol";
import { api, ApiError, type InfoResponse, type RepoState, type RepoSummary, type SearchResult, type WorktreeStatus } from "./api.ts";
import { DetailsPanel } from "./details.ts";
import { formatDate, h, prefs, shortOid, svg } from "./dom.ts";
import { GraphView } from "./graph-view.ts";
import { HistoryModel, WORKTREE_OID, worktreeCommit } from "./model.ts";
import { RepoPicker } from "./picker.ts";

const PAGE = 300;
const MAX_PAGE = 500;

interface RepoData {
  id: string;
  info?: InfoResponse;
  commits: GitGraphCommit[];
  refs: GitGraphRef[];
  head?: string;
  cursor?: string;
  hasMore: boolean;
  worktree?: WorktreeStatus;
  state?: RepoState;
}

type Live = "off" | "live" | "retrying";

export class App {
  readonly #root: HTMLElement;
  readonly #graph: GraphView;
  readonly #details: DetailsPanel;
  readonly #picker = new RepoPicker();
  readonly #repoButton: HTMLButtonElement;
  readonly #searchInput: HTMLInputElement;
  readonly #searchResults: HTMLElement;
  readonly #live: HTMLElement;
  readonly #status: HTMLElement;
  readonly #overlay: HTMLElement;
  readonly #banner: HTMLElement;
  readonly #popover: HTMLElement;
  readonly #help: HTMLElement;
  readonly #main: HTMLElement;
  #repos: RepoSummary[] = [];
  #roots = "";
  #data: RepoData | undefined;
  #generation = 0;
  #loadingMore: Promise<void> | undefined;
  #events: EventSource | undefined;
  #liveState: Live = "off";
  #searchAbort: AbortController | undefined;
  #searchTimer = 0;
  #results: SearchResult[] = [];
  #activeResult = -1;
  #detailsOpen = prefs.get("detailsOpen", true);
  #selectedOid: string | undefined;
  #detailTimer = 0;
  #reloadQueued = false;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#graph = new GraphView({
      onSelect: (row, open) => this.select(row, open),
      onNeedMore: () => void this.loadMore(),
      onShowRefs: (row, anchor) => this.#showRefs(row, anchor)
    });
    this.#details = new DetailsPanel({
      repoId: () => this.#data?.id,
      subjectOf: (oid) => {
        const row = this.#graph.model?.rowOf.get(oid);
        return row === undefined ? undefined : this.#graph.model?.commits[row]?.message.split("\n", 1)[0];
      },
      jumpTo: (oid) => void this.jumpTo(oid),
      close: () => this.#setDetails(false)
    });

    this.#repoButton = h("button", { class: "repo-button", type: "button", title: "Cambiar de repositorio (Ctrl+K)" }, "Elegir repositorio…");
    this.#repoButton.addEventListener("click", () => void this.openPicker());
    this.#searchInput = h("input", {
      class: "search-input",
      type: "search",
      placeholder: "Buscar mensaje, hash o autor  ( / )",
      "aria-label": "Buscar commits",
      autocomplete: "off",
      spellcheck: "false"
    });
    this.#searchResults = h("div", { class: "search-results hidden", role: "listbox" });
    this.#live = h("span", { class: "live off", title: "Actualización automática" }, "sin conexión");
    const refresh = h("button", { class: "icon-btn", type: "button", title: "Recargar (r)", "aria-label": "Recargar" });
    const refreshIcon = svg("svg", { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" });
    refreshIcon.append(
      svg("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.7-3.98", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" }),
      svg("path", { d: "M12.6 1.8v2.9H9.7", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" })
    );
    refresh.append(refreshIcon);
    refresh.addEventListener("click", () => void this.reload({ full: true }));
    const helpButton = h("button", { class: "icon-btn", type: "button", title: "Atajos de teclado (?)", "aria-label": "Ayuda" }, "?");
    helpButton.addEventListener("click", () => this.#toggleHelp());

    this.#banner = h("div", { class: "banner hidden", role: "alert" });
    this.#overlay = h("div", { class: "state-overlay hidden" });
    this.#status = h("div", { class: "statusbar" });
    this.#popover = h("div", { class: "popover hidden", role: "dialog" });
    this.#help = this.#buildHelp();

    const splitter = h("div", { class: "splitter", title: "Arrastra para cambiar la anchura del detalle" });
    this.#bindSplitter(splitter);
    this.#main = h("main", { class: `main${this.#detailsOpen ? "" : " no-details"}` }, h("div", { class: "history-wrap" }, this.#banner, this.#graph.element, this.#overlay), splitter, this.#details.element);

    root.append(
      h(
        "header",
        { class: "topbar" },
        this.#repoButton,
        h("div", { class: "search" }, this.#searchInput, this.#searchResults),
        this.#live,
        refresh,
        helpButton
      ),
      this.#main,
      this.#status,
      this.#picker.element,
      this.#popover,
      this.#help
    );
    this.#bindSearch();
    this.#bindKeys();
    document.addEventListener("mousedown", (event) => {
      if (!this.#popover.contains(event.target as Node)) this.#popover.classList.add("hidden");
      if (!(event.target as HTMLElement).closest(".search")) this.#searchResults.classList.add("hidden");
    });
    window.addEventListener("hashchange", () => {
      const id = this.#hashRepo();
      if (id && id !== this.#data?.id) void this.openRepo(id);
    });
  }

  async start(): Promise<void> {
    this.#showState("Cargando repositorios…");
    try {
      await this.#loadRepos(false);
    } catch (error) {
      this.#showError(error);
      return;
    }
    const id = this.#hashRepo() ?? prefs.get<string | undefined>("lastRepo", undefined);
    if (id && this.#repos.some((repo) => repo.id === id)) {
      await this.openRepo(id);
    } else {
      this.#showState("Elige un repositorio (Ctrl+K).");
      void this.openPicker();
    }
  }

  #hashRepo(): string | undefined {
    const match = /^#\/?repo\/([^/?#]+)/.exec(location.hash);
    return match ? decodeURIComponent(match[1]!) : undefined;
  }

  async #loadRepos(rescan: boolean): Promise<void> {
    const response = await api.repos(rescan);
    this.#repos = response.repositories;
    this.#roots = response.roots.map((root) => root.path.replace(/^\/(Users|home)\/[^/]+/, "~")).join(", ");
  }

  async openPicker(): Promise<void> {
    const open = (loading = false) =>
      this.#picker.open({
        repos: this.#repos,
        roots: this.#roots,
        ...(this.#data ? { current: this.#data.id } : {}),
        loading,
        onPick: (repo) => void this.openRepo(repo.id),
        onRescan: () => void this.#rescan()
      });
    open();
    try {
      await this.#loadRepos(false);
      if (this.#picker.isOpen) this.#picker.update(this.#repos, this.#roots);
    } catch {
      // The picker keeps the list it already has.
    }
  }

  async #rescan(): Promise<void> {
    try {
      await this.#loadRepos(true);
      this.#picker.update(this.#repos, this.#roots);
    } catch (error) {
      this.#showBanner(error);
    }
  }

  // ---- repository lifecycle ------------------------------------------------

  async openRepo(id: string): Promise<void> {
    const generation = ++this.#generation;
    this.#events?.close();
    this.#events = undefined;
    this.#setLive("off");
    this.#data = { id, commits: [], refs: [], hasMore: false };
    this.#selectedOid = undefined;
    this.#results = [];
    this.#graph.setMatches(new Set());
    this.#searchInput.value = "";
    this.#searchResults.classList.add("hidden");
    this.#details.clear();
    this.#graph.setModel(undefined);
    this.#graph.viewport.scrollTop = 0;
    this.#hideBanner();
    const summary = this.#repos.find((repo) => repo.id === id);
    this.#renderRepoButton(summary);
    this.#showState("Cargando historial…");
    if (location.hash !== `#/repo/${encodeURIComponent(id)}`) history.replaceState(null, "", `#/repo/${encodeURIComponent(id)}`);
    try {
      const info = await api.info(id);
      if (generation !== this.#generation) return;
      this.#data.info = info;
      this.#renderRepoButton(info.repository, info.branch);
      prefs.set("lastRepo", id);
      document.title = `${info.repository.name} · Git Graph`;
      await Promise.all([this.#fetchHistory(generation, PAGE), this.#fetchWorktree(generation)]);
      if (generation !== this.#generation) return;
      this.#rebuild();
      this.#subscribe(id, generation);
      const first = this.#graph.model?.rowCount ? 0 : -1;
      if (first >= 0) this.select(first, this.#detailsOpen);
    } catch (error) {
      if (generation === this.#generation) this.#showError(error);
    }
  }

  async #fetchHistory(generation: number, wanted: number): Promise<void> {
    const data = this.#data!;
    const commits: GitGraphCommit[] = [];
    let page: GitGraphPage | undefined;
    let cursor: string | undefined;
    // Counted in rows asked for: a page can return fewer (stash internals are left out).
    let requested = 0;
    do {
      const limit = Math.min(MAX_PAGE, Math.max(PAGE, wanted - requested));
      page = await api.history(data.id, { limit, ...(cursor ? { cursor } : {}) });
      if (generation !== this.#generation) return;
      requested += limit;
      commits.push(...page.commits);
      cursor = page.cursor;
    } while (cursor && requested < wanted);
    data.commits = commits;
    data.refs = [...page.refs];
    if (page.head) data.head = page.head;
    else delete data.head;
    if (cursor) data.cursor = cursor;
    else delete data.cursor;
    data.hasMore = Boolean(cursor);
  }

  async #fetchWorktree(generation: number): Promise<void> {
    const data = this.#data!;
    if (data.info?.repository.bare) return;
    try {
      const status = await api.worktree(data.id);
      if (generation === this.#generation) data.worktree = status;
    } catch (error) {
      if (generation === this.#generation) delete data.worktree;
      if (error instanceof ApiError && error.network) throw error;
    }
  }

  #rebuild(anchor = this.#graph.anchor()): void {
    const data = this.#data;
    if (!data) return;
    const rows = [...data.commits];
    const status = data.worktree;
    if (status) {
      const counts = {
        staged: status.staged.length,
        unstaged: status.unstaged.length,
        untracked: status.untracked.length,
        conflicted: status.conflicted.length
      };
      if (counts.staged + counts.unstaged + counts.untracked + counts.conflicted) rows.unshift(worktreeCommit(data.head, counts));
    }
    const model = new HistoryModel(rows, data.refs, data.head);
    this.#graph.setModel(model, anchor);
    const selected = this.#selectedOid ? model.rowOf.get(this.#selectedOid) : undefined;
    this.#graph.setSelected(selected ?? -1, false);
    if (!rows.length) {
      this.#showState(data.info?.empty ? "Repositorio vacío: todavía no tiene commits." : "No hay commits visibles en este repositorio.");
    } else {
      this.#hideState();
    }
    this.#renderStatus();
  }

  async loadMore(): Promise<void> {
    const data = this.#data;
    if (!data?.hasMore || !data.cursor || this.#loadingMore) return;
    const generation = this.#generation;
    this.#loadingMore = (async () => {
      this.#renderStatus("Cargando más commits…");
      try {
        const page = await api.history(data.id, { limit: PAGE, cursor: data.cursor! });
        if (generation !== this.#generation) return;
        data.commits = [...data.commits, ...page.commits];
        if (page.cursor) data.cursor = page.cursor;
        else delete data.cursor;
        data.hasMore = page.hasMore;
        this.#rebuild();
      } catch (error) {
        if (generation !== this.#generation) return;
        if (error instanceof ApiError && error.code === "snapshot_expired") {
          await this.reload({ full: true });
        } else {
          this.#showBanner(error);
        }
      } finally {
        this.#loadingMore = undefined;
        this.#renderStatus();
      }
    })();
    return this.#loadingMore;
  }

  /** Re-reads history (keeping as many rows as are loaded) and/or the working tree, keeping the view in place. */
  async reload(options: { full?: boolean; history?: boolean; worktree?: boolean } = {}): Promise<void> {
    const data = this.#data;
    if (!data) return;
    if (this.#loadingMore) {
      this.#reloadQueued = true;
      return;
    }
    const generation = this.#generation;
    const history = options.full || options.history;
    const worktree = options.full || options.worktree;
    const anchor = this.#graph.anchor();
    try {
      if (options.full) {
        const info = await api.info(data.id);
        if (generation !== this.#generation) return;
        data.info = info;
        this.#renderRepoButton(info.repository, info.branch);
      }
      await Promise.all([
        history ? this.#fetchHistory(generation, Math.max(PAGE, data.commits.length)) : Promise.resolve(),
        worktree ? this.#fetchWorktree(generation) : Promise.resolve()
      ]);
      if (generation !== this.#generation) return;
      this.#hideBanner();
      this.#rebuild(anchor);
      if (this.#detailsOpen && this.#selectedOid === WORKTREE_OID && worktree) this.#details.showWorktree(data.worktree);
      if (this.#detailsOpen && this.#selectedOid && !this.#graph.model?.rowOf.has(this.#selectedOid)) this.#details.clear();
    } catch (error) {
      if (generation === this.#generation) this.#showBanner(error);
    } finally {
      if (this.#reloadQueued) {
        this.#reloadQueued = false;
        void this.reload({ history: true, worktree: true });
      }
    }
  }

  #subscribe(id: string, generation: number): void {
    const source = new EventSource(api.eventsUrl(id));
    this.#events = source;
    source.addEventListener("ready", (event) => {
      if (generation !== this.#generation) return;
      const { state } = JSON.parse((event as MessageEvent<string>).data) as { state: RepoState };
      const previous = this.#data?.state;
      if (this.#data) this.#data.state = state;
      this.#setLive("live");
      this.#hideBanner();
      // After a reconnection, catch up with whatever changed while away.
      if (previous && (previous.refs !== state.refs || previous.worktree !== state.worktree)) {
        void this.reload({ history: previous.refs !== state.refs, worktree: previous.worktree !== state.worktree });
      }
    });
    source.addEventListener("change", (event) => {
      if (generation !== this.#generation) return;
      const change = JSON.parse((event as MessageEvent<string>).data) as { refs: boolean; worktree: boolean; state: RepoState };
      if (this.#data) this.#data.state = change.state;
      void this.reload({ history: change.refs, worktree: change.worktree || change.refs });
    });
    source.addEventListener("error", () => {
      if (generation !== this.#generation) return;
      this.#setLive("retrying");
    });
  }

  // ---- selection and details -----------------------------------------------

  select(row: number, open = false): void {
    const model = this.#graph.model;
    if (!model || row < 0 || row >= model.rowCount) return;
    const commit = model.commits[row]!;
    this.#selectedOid = commit.oid;
    this.#graph.setSelected(row);
    if (open && !this.#detailsOpen) this.#setDetails(true);
    if (this.#detailsOpen) {
      clearTimeout(this.#detailTimer);
      // Holding j/k skims rows without loading every commit on the way.
      this.#detailTimer = window.setTimeout(() => this.#showDetails(commit), open ? 0 : 120);
    }
    this.#renderStatus();
  }

  #showDetails(commit: GitGraphCommit): void {
    if (commit.oid === WORKTREE_OID) {
      this.#details.showWorktree(this.#data?.worktree);
    } else if (this.#details.current !== commit.oid) {
      void this.#details.showCommit(commit.oid);
    }
  }

  #setDetails(open: boolean): void {
    this.#detailsOpen = open;
    prefs.set("detailsOpen", open);
    this.#main.classList.toggle("no-details", !open);
    if (open) {
      const row = this.#graph.selected;
      const commit = row >= 0 ? this.#graph.model?.commits[row] : undefined;
      if (commit) this.#showDetails(commit);
    } else {
      this.#details.clear();
      this.#graph.viewport.focus();
    }
  }

  async jumpTo(oid: string): Promise<boolean> {
    const generation = this.#generation;
    let row = this.#graph.model?.rowOf.get(oid);
    let pages = 0;
    while (row === undefined && this.#data?.hasMore && pages < 200) {
      this.#renderStatus("Buscando el commit en el historial…");
      await this.loadMore();
      if (generation !== this.#generation) return false;
      row = this.#graph.model?.rowOf.get(oid);
      pages += 1;
    }
    if (row === undefined) {
      this.#renderStatus(`${shortOid(oid)} no está en el historial mostrado.`);
      return false;
    }
    this.#graph.scrollToRow(row, "center");
    this.select(row, true);
    return true;
  }

  #showRefs(row: number, anchor: HTMLElement): void {
    const model = this.#graph.model;
    const commit = model?.commits[row];
    if (!model || !commit) return;
    this.select(row, false);
    const chips = model.chips.get(commit.oid) ?? [];
    const list = h("div", { class: "popover-list" });
    for (const chip of chips) {
      for (const name of chip.names) {
        list.append(
          h(
            "div",
            { class: "popover-item" },
            h("span", { class: `ref-pill ref-${chip.kind === "branch" ? "head" : chip.kind}` }, name.replace(/^refs\/(heads|tags|remotes)\//, "")),
            h("span", { class: "muted mono" }, name),
            chip.current && name.startsWith("refs/heads/") ? h("span", { class: "badge" }, "HEAD") : null
          )
        );
      }
    }
    this.#popover.replaceChildren(h("div", { class: "popover-title" }, `Referencias en ${shortOid(commit.oid)}`), list);
    const rect = anchor.getBoundingClientRect();
    this.#popover.style.left = `${Math.max(8, rect.left)}px`;
    this.#popover.style.top = `${rect.bottom + 4}px`;
    this.#popover.classList.remove("hidden");
  }

  // ---- search ----------------------------------------------------------------

  #bindSearch(): void {
    this.#searchInput.addEventListener("input", () => {
      clearTimeout(this.#searchTimer);
      this.#searchTimer = window.setTimeout(() => void this.#runSearch(), 220);
    });
    this.#searchInput.addEventListener("focus", () => {
      if (this.#results.length || this.#searchInput.value.trim()) this.#searchResults.classList.remove("hidden");
    });
    this.#searchInput.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!this.#results.length) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        this.#activeResult = Math.min(this.#results.length - 1, Math.max(0, this.#activeResult + delta));
        this.#renderResults();
      } else if (event.key === "Enter") {
        event.preventDefault();
        const result = this.#results[Math.max(0, this.#activeResult)];
        if (result) {
          this.#activeResult = this.#results.indexOf(result);
          this.#searchResults.classList.add("hidden");
          void this.jumpTo(result.oid).then(() => this.#graph.viewport.focus());
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (this.#searchInput.value) {
          this.#searchInput.value = "";
          void this.#runSearch();
        } else {
          this.#searchResults.classList.add("hidden");
          this.#graph.viewport.focus();
        }
      }
    });
  }

  async #runSearch(): Promise<void> {
    const data = this.#data;
    const query = this.#searchInput.value.trim();
    this.#searchAbort?.abort();
    if (!data || query.length < 2) {
      this.#results = [];
      this.#activeResult = -1;
      this.#graph.setMatches(new Set());
      this.#searchResults.classList.toggle("hidden", !query);
      this.#searchResults.replaceChildren(query ? h("div", { class: "state" }, "Escribe al menos 2 caracteres.") : "");
      return;
    }
    const controller = new AbortController();
    this.#searchAbort = controller;
    this.#searchResults.classList.remove("hidden");
    this.#searchResults.replaceChildren(h("div", { class: "state" }, "Buscando…"));
    try {
      const response = await api.search(data.id, query, controller.signal);
      if (controller.signal.aborted || data !== this.#data) return;
      this.#results = response.results;
      this.#activeResult = response.results.length ? 0 : -1;
      this.#graph.setMatches(new Set(response.results.map((result) => result.oid)));
      this.#renderResults(response.limited);
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      this.#searchResults.replaceChildren(h("div", { class: "state state-error" }, error instanceof ApiError ? error.message : "Error al buscar."));
    }
  }

  #renderResults(limited = false): void {
    if (!this.#results.length) {
      this.#searchResults.replaceChildren(h("div", { class: "state" }, "Sin resultados."));
      return;
    }
    const labels = { hash: "hash", message: "mensaje", author: "autor" } as const;
    const items = this.#results.map((result, index) => {
      const item = h(
        "div",
        { class: `result${index === this.#activeResult ? " active" : ""}`, role: "option" },
        h("span", { class: "mono hash" }, shortOid(result.oid)),
        h("span", { class: "result-subject" }, result.subject),
        h("span", { class: "muted result-author" }, result.author),
        h("span", { class: "muted result-date" }, formatDate(result.authoredAt)),
        h("span", { class: "result-match" }, result.matched.map((field) => labels[field]).join(" · "))
      );
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.#activeResult = index;
        this.#searchResults.classList.add("hidden");
        void this.jumpTo(result.oid);
      });
      return item;
    });
    this.#searchResults.replaceChildren(
      h("div", { class: "results-head muted" }, `${this.#results.length}${limited ? "+" : ""} resultados · ↑↓ y Enter para ir · n / N en el grafo`),
      ...items
    );
    items[this.#activeResult]?.scrollIntoView({ block: "nearest" });
  }

  #nextMatch(delta: number): void {
    if (!this.#results.length) return;
    this.#activeResult = (this.#activeResult + delta + this.#results.length) % this.#results.length;
    void this.jumpTo(this.#results[this.#activeResult]!.oid);
  }

  // ---- keyboard ----------------------------------------------------------------

  #bindKeys(): void {
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        void this.openPicker();
        return;
      }
      if (this.#picker.isOpen) return;
      const target = event.target as HTMLElement;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (event.key === "Escape") {
        if (!this.#help.classList.contains("hidden")) this.#help.classList.add("hidden");
        else if (!this.#popover.classList.contains("hidden")) this.#popover.classList.add("hidden");
        else if (!typing && this.#detailsOpen) this.#setDetails(false);
        return;
      }
      if (typing || event.altKey || event.ctrlKey || event.metaKey) return;
      if (target.closest(".files") && (event.key === "ArrowDown" || event.key === "ArrowUp")) return;
      const model = this.#graph.model;
      const row = this.#graph.selected;
      const page = this.#graph.visibleRows() - 1;
      const move = (to: number) => {
        if (!model?.rowCount) return;
        event.preventDefault();
        this.select(Math.min(model.rowCount - 1, Math.max(0, to)));
      };
      switch (event.key) {
        case "ArrowDown":
        case "j":
          move(row + 1);
          break;
        case "ArrowUp":
        case "k":
          move(row - 1);
          break;
        case "PageDown":
          move(row + page);
          break;
        case "PageUp":
          move(row - page);
          break;
        case "Home":
        case "g":
          move(0);
          break;
        case "End":
        case "G":
          move((model?.rowCount ?? 1) - 1);
          break;
        case "Enter":
        case "o":
          event.preventDefault();
          if (this.#detailsOpen) this.#setDetails(false);
          else if (row >= 0) this.select(row, true);
          break;
        case "/":
          event.preventDefault();
          this.#searchInput.focus();
          this.#searchInput.select();
          break;
        case "n":
          this.#nextMatch(1);
          break;
        case "N":
          this.#nextMatch(-1);
          break;
        case "r":
          void this.reload({ full: true });
          break;
        case "w":
          if (model?.rowOf.has(WORKTREE_OID)) move(model.rowOf.get(WORKTREE_OID)!);
          break;
        case "h":
          if (this.#data?.head) void this.jumpTo(this.#data.head);
          break;
        case "c": {
          const commit = row >= 0 ? model?.commits[row] : undefined;
          if (commit && commit.oid !== WORKTREE_OID) {
            void navigator.clipboard?.writeText(commit.oid);
            this.#renderStatus(`Copiado ${shortOid(commit.oid)}`);
          }
          break;
        }
        case "p":
          event.preventDefault();
          void this.openPicker();
          break;
        case "?":
          this.#toggleHelp();
          break;
        default:
          return;
      }
    });
  }

  #buildHelp(): HTMLElement {
    const keys: Array<[string, string]> = [
      ["j / k  ·  ↓ / ↑", "Commit siguiente / anterior"],
      ["PgDn / PgUp  ·  g / G", "Página · primero / último cargado"],
      ["Enter  ·  o", "Abrir / cerrar el detalle"],
      ["/", "Buscar por mensaje, hash o autor"],
      ["n / N", "Resultado siguiente / anterior"],
      ["Ctrl+K  ·  p", "Cambiar de repositorio"],
      ["w  ·  h", "Ir a los cambios sin commit · a HEAD"],
      ["c", "Copiar el hash seleccionado"],
      ["r", "Recargar"],
      ["Esc", "Cerrar"]
    ];
    const list = h("dl", { class: "help-keys" });
    for (const [key, text] of keys) list.append(h("dt", { class: "mono" }, key), h("dd", {}, text));
    const dialog = h(
      "div",
      { class: "picker help", role: "dialog", "aria-label": "Atajos" },
      h("h2", {}, "Atajos de teclado"),
      list,
      h("p", { class: "muted" }, "Visor de solo lectura. Las ramas y tags se muestran a la izquierda, unidas a su commit. Los checkpoints de Herdr (refs/herdr-gpui/*) no se muestran.")
    );
    const overlay = h("div", { class: "overlay hidden" }, dialog);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) overlay.classList.add("hidden");
    });
    return overlay;
  }

  #toggleHelp(): void {
    this.#help.classList.toggle("hidden");
  }

  #bindSplitter(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const panel = this.#details.element;
      const startWidth = panel.getBoundingClientRect().width;
      let width = startWidth;
      const move = (moveEvent: PointerEvent) => {
        width = Math.min(window.innerWidth * 0.75, Math.max(320, startWidth - (moveEvent.clientX - startX)));
        panel.style.setProperty("--panel-w", `${width}px`);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        prefs.set("panelWidth", Math.round(width));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  // ---- chrome ----------------------------------------------------------------

  #renderRepoButton(repo?: RepoSummary, branch?: string): void {
    if (!repo) {
      this.#repoButton.replaceChildren("Elegir repositorio…");
      return;
    }
    this.#repoButton.replaceChildren(
      ...[
        h("span", { class: "repo-name" }, repo.name),
        repo.linkedWorktree ? h("span", { class: "badge" }, "worktree") : null,
        h("span", { class: "repo-branch" }, branch ?? repo.branch ?? "HEAD detached"),
        h("span", { class: "caret" }, "▾")
      ].filter((node): node is HTMLSpanElement => node !== null)
    );
    this.#repoButton.title = `${repo.displayPath} — cambiar (Ctrl+K)`;
  }

  #setLive(state: Live): void {
    this.#liveState = state;
    this.#live.className = `live ${state}`;
    this.#live.textContent = state === "live" ? "en vivo" : state === "retrying" ? "reconectando…" : "sin conexión";
    this.#live.title =
      state === "live"
        ? "Se actualiza solo tras operaciones hechas en la terminal"
        : "Sin canal de actualizaciones: el servidor o el túnel no responden. Se reintenta solo.";
  }

  #renderStatus(message?: string): void {
    const data = this.#data;
    const model = this.#graph.model;
    if (!data) {
      this.#status.replaceChildren(h("span", { class: "muted" }, message ?? ""));
      return;
    }
    const commits = data.commits.length;
    const parts: Array<HTMLElement | string> = [
      h("span", { class: "muted" }, data.info?.repository.displayPath ?? ""),
      h("span", {}, `${commits} commits${data.hasMore ? " cargados (hay más)" : ""}`)
    ];
    if (model) parts.push(h("span", { class: "muted" }, `${model.laneCount} carriles`));
    if (data.info?.hiddenRefs) {
      parts.push(h("span", { class: "muted", title: "refs/herdr-gpui/* no se recorren ni se modifican" }, `${data.info.hiddenRefs} checkpoints ocultos`));
    }
    if (message) parts.push(h("span", { class: "status-msg" }, message));
    this.#status.replaceChildren(
      h("div", { class: "status-left" }, ...parts),
      h("div", { class: "status-right muted" }, "j/k mover · Enter detalle · / buscar · Ctrl+K repos · ? ayuda")
    );
  }

  #showState(text: string): void {
    this.#overlay.replaceChildren(h("div", { class: "state" }, text));
    this.#overlay.classList.remove("hidden");
  }

  #hideState(): void {
    this.#overlay.classList.add("hidden");
  }

  #describe(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.network) {
        return "No se puede contactar con el servidor del visor. Si el túnel de Herdr se cerró o el servidor se detuvo, ejecuta `hgg open` en una pestaña del Mac en Herdr y recarga.";
      }
      if (error.code === "repository_not_found") return "Repositorio no disponible: se movió, se borró o ya no está en las raíces configuradas.";
      return error.message;
    }
    return "Error inesperado.";
  }

  #showError(error: unknown): void {
    const retry = h("button", { class: "btn", type: "button" }, "Reintentar");
    retry.addEventListener("click", () => {
      if (this.#data) void this.openRepo(this.#data.id);
      else void this.start();
    });
    const pick = h("button", { class: "btn", type: "button" }, "Elegir otro repositorio");
    pick.addEventListener("click", () => void this.openPicker());
    this.#overlay.replaceChildren(h("div", { class: "state state-error" }, h("p", {}, this.#describe(error)), h("div", { class: "actions" }, retry, pick)));
    this.#overlay.classList.remove("hidden");
  }

  #showBanner(error: unknown): void {
    const retry = h("button", { class: "btn small", type: "button" }, "Reintentar");
    retry.addEventListener("click", () => void this.reload({ full: true }));
    this.#banner.replaceChildren(h("span", {}, this.#describe(error)), retry);
    this.#banner.classList.remove("hidden");
  }

  #hideBanner(): void {
    this.#banner.classList.add("hidden");
  }
}
