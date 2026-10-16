import type { RepoSummary } from "./api.ts";
import { h } from "./dom.ts";
import { filterRepositories } from "./filter.ts";

/** Quick repository switcher (Ctrl+K): type to filter, arrows to move, Enter to open. */
export class RepoPicker {
  readonly element: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #list: HTMLElement;
  readonly #footer: HTMLElement;
  #repos: RepoSummary[] = [];
  #shown: RepoSummary[] = [];
  #active = 0;
  #current: string | undefined;
  #onPick: (repo: RepoSummary) => void = () => {};
  #onRescan: () => void = () => {};

  constructor() {
    this.#input = h("input", {
      class: "picker-input",
      type: "search",
      placeholder: "Buscar repositorio por nombre, ruta o rama…",
      "aria-label": "Buscar repositorio",
      autocomplete: "off",
      spellcheck: "false"
    });
    this.#list = h("div", { class: "picker-list", role: "listbox" });
    const rescan = h("button", { class: "btn small", type: "button" }, "Volver a escanear");
    rescan.addEventListener("click", () => this.#onRescan());
    this.#footer = h("div", { class: "picker-foot muted" });
    const dialog = h(
      "div",
      { class: "picker", role: "dialog", "aria-modal": "true", "aria-label": "Repositorios" },
      this.#input,
      this.#list,
      h("div", { class: "picker-bar" }, this.#footer, rescan)
    );
    this.element = h("div", { class: "overlay hidden" }, dialog);
    this.element.addEventListener("mousedown", (event) => {
      if (event.target === this.element) this.close();
    });
    this.#input.addEventListener("input", () => {
      this.#active = 0;
      this.#render();
    });
    this.#input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        this.#active = Math.min(this.#shown.length - 1, Math.max(0, this.#active + delta));
        this.#render();
      } else if (event.key === "Enter") {
        event.preventDefault();
        const repo = this.#shown[this.#active];
        if (repo) this.#pick(repo);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.element.classList.contains("hidden");
  }

  open(options: { repos: RepoSummary[]; roots: string; current?: string; onPick: (repo: RepoSummary) => void; onRescan: () => void; loading?: boolean }): void {
    this.#repos = options.repos;
    this.#current = options.current;
    this.#onPick = options.onPick;
    this.#onRescan = options.onRescan;
    this.#footer.textContent = options.loading ? "Escaneando…" : `${options.repos.length} repositorios en ${options.roots}`;
    this.element.classList.remove("hidden");
    this.#input.value = "";
    this.#active = Math.max(0, this.#repos.findIndex((repo) => repo.id === this.#current));
    this.#render();
    this.#input.focus();
  }

  update(repos: RepoSummary[], roots: string): void {
    this.#repos = repos;
    this.#footer.textContent = `${repos.length} repositorios en ${roots}`;
    this.#render();
  }

  close(): void {
    this.element.classList.add("hidden");
  }

  #pick(repo: RepoSummary): void {
    this.close();
    this.#onPick(repo);
  }

  #render(): void {
    this.#shown = filterRepositories(this.#repos, this.#input.value);
    this.#active = Math.min(this.#active, Math.max(0, this.#shown.length - 1));
    if (!this.#shown.length) {
      this.#list.replaceChildren(h("div", { class: "state" }, this.#repos.length ? "Ningún repositorio coincide." : "No hay repositorios en las raíces configuradas."));
      return;
    }
    const byId = new Map(this.#repos.map((repo) => [repo.id, repo]));
    const items = this.#shown.map((repo, index) => {
      const main = repo.mainId ? byId.get(repo.mainId) : undefined;
      const item = h(
        "div",
        {
          class: `picker-item${index === this.#active ? " active" : ""}${repo.id === this.#current ? " current" : ""}`,
          role: "option",
          "aria-selected": index === this.#active ? "true" : "false"
        },
        h(
          "span",
          { class: "picker-title" },
          h("span", { class: "picker-name" }, repo.name),
          repo.linkedWorktree ? h("span", { class: "badge", title: main ? `Worktree de ${main.displayPath}` : "Worktree enlazado" }, main ? `worktree · ${main.name}` : "worktree") : null,
          repo.bare ? h("span", { class: "badge" }, "bare") : null
        ),
        h("span", { class: "picker-branch" }, repo.branch ?? (repo.bare ? "" : "HEAD detached")),
        h("span", { class: "picker-path muted" }, repo.displayPath)
      );
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.#pick(repo);
      });
      return item;
    });
    this.#list.replaceChildren(...items);
    items[this.#active]?.scrollIntoView({ block: "nearest" });
  }
}
