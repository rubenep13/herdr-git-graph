import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Access control for the API. Loopback alone lets any local process — or a
 * browser extension in the client's browser, through Herdr's forward — read
 * the repositories; a secret narrows that to whoever can read the token file
 * on this Mac.
 *
 * - The long-lived secret lives in a 0600 file next to the server and never
 *   leaves this machine.
 * - `hgg` signs a one-time ticket with it (valid two minutes, single use) and
 *   opens the page with the ticket in the URL fragment, so it is never sent
 *   to the server in a request line or a Referer, and is worthless once used.
 * - The page trades the ticket for a session token, kept in localStorage
 *   (isolated per origin, port included — unlike cookies, which every server
 *   on localhost would receive) and sent as `Authorization: Bearer`.
 * - The session token is derived from the secret, so it survives server
 *   restarts; rotating the secret ends every session.
 */
const TICKET_VERSION = "v1";
export const TICKET_TTL_SECONDS = 120;

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Reads the secret from `file`, creating it (0600, in a 0700 folder) on first use. */
export function ensureSecret(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, `${newSecret()}\n`, { mode: 0o600, flag: "wx" });
    } catch {
      // Another process created it first; read theirs.
    }
    chmodSync(file, 0o600);
    return readFileSync(file, "utf8").trim();
  }
}

/** A one-time login ticket: `v1.<unix seconds>.<nonce>.<signature>`. */
export function makeTicket(secret: string, now = Date.now()): string {
  const issued = Math.floor(now / 1000);
  const nonce = randomBytes(12).toString("base64url");
  const body = `${TICKET_VERSION}.${issued}.${nonce}`;
  return `${body}.${sign(secret, `ticket.${body}`)}`;
}

export function sessionFor(secret: string): string {
  return sign(secret, "session.v1");
}

export class TokenStore {
  readonly #file: string;
  #secret = "";
  #mtimeMs = -1;
  readonly #usedNonces = new Map<string, number>();

  constructor(file: string) {
    this.#file = file;
    this.#secret = ensureSecret(file);
    this.#mtimeMs = statSync(file).mtimeMs;
  }

  /** The current secret; a rotated file (`hgg rotate-token`) is picked up without a restart. */
  #current(): string {
    try {
      const mtime = statSync(this.#file).mtimeMs;
      if (mtime !== this.#mtimeMs) {
        this.#secret = readFileSync(this.#file, "utf8").trim();
        this.#mtimeMs = mtime;
        this.#usedNonces.clear();
      }
    } catch {
      // The file went away: keep the secret in memory rather than fail open or closed.
    }
    return this.#secret;
  }

  /** Trades a valid, unexpired, unused ticket for a session token. */
  redeem(ticket: string, now = Date.now()): string | undefined {
    const secret = this.#current();
    const parts = ticket.split(".");
    if (parts.length !== 4 || parts[0] !== TICKET_VERSION || !secret) return undefined;
    const [, issuedText, nonce, signature] = parts as [string, string, string, string];
    if (!/^\d{1,12}$/.test(issuedText) || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return undefined;
    if (!safeEqual(signature, sign(secret, `ticket.${TICKET_VERSION}.${issuedText}.${nonce}`))) return undefined;
    const seconds = now / 1000;
    const issued = Number(issuedText);
    if (issued > seconds + 30 || seconds - issued > TICKET_TTL_SECONDS) return undefined;
    for (const [used, expiry] of this.#usedNonces) if (expiry < seconds) this.#usedNonces.delete(used);
    if (this.#usedNonces.has(nonce)) return undefined;
    this.#usedNonces.set(nonce, issued + TICKET_TTL_SECONDS + 30);
    return sessionFor(secret);
  }

  verifySession(token: string | undefined): boolean {
    const secret = this.#current();
    return Boolean(token && secret) && safeEqual(token!, sessionFor(secret));
  }
}
