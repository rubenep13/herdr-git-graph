type Child = Node | string | null | undefined | false;

/** Creates an element; text children are always inserted as text, never as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | number | boolean | undefined> & { class?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") element.className = String(value);
    else if (key === "text") element.textContent = String(value);
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const value = localStorage.getItem(`hgg.${key}`);
      return value === null ? fallback : (JSON.parse(value) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`hgg.${key}`, JSON.stringify(value));
    } catch {
      // Preferences are a convenience; the page works without storage.
    }
  }
};

export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Compact local date: time today, day and month this year, full date before. */
export function formatDate(iso: string | undefined, now = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return time;
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  if (date.getFullYear() === now.getFullYear()) return `${date.getDate()} ${months[date.getMonth()]} ${time}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatFullDate(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Two-letter initials for an author bubble: "Ruben Esteban" → "RE", "Rubén" → "RU". */
export function initials(name: string | undefined): string {
  const words = (name ?? "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : words[0]!.slice(0, 2);
  return letters.toUpperCase();
}

/** A stable colour per author (like GitKraken's initials bubbles), from name or e-mail. */
export function authorColour(key: string | undefined): string {
  let hash = 0;
  for (const char of key ?? "") hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 42% 38%)`;
}

/**
 * GitKraken-style relative time bucket, in Spanish: rows of the same bucket
 * share one marker. Returns "" for an unknown date.
 */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, (now - time) / 1000);
  const plural = (value: number, one: string, many: string) => `hace ${value} ${value === 1 ? one : many}`;
  if (seconds < 60) return "hace un momento";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, "minuto", "minutos");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hora", "horas");
  const days = Math.floor(hours / 24);
  if (days < 7) return plural(days, "día", "días");
  if (days < 31) return plural(Math.floor(days / 7), "semana", "semanas");
  if (days < 365) return plural(Math.floor(days / 30.4), "mes", "meses");
  return plural(Math.floor(days / 365), "año", "años");
}
