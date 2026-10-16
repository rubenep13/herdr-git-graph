import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeConfig } from "../server/config.ts";
import { request as httpRequest } from "node:http";
import { ROUTES, checkMethod } from "../server/http.ts";
import { repoId } from "../server/registry.ts";
import { makeTicket, newSecret, sessionFor, TokenStore } from "../server/auth.ts";
import { Fixture } from "./helpers/fixture.ts";
import { raw, startTestServer, type TestServer } from "./helpers/http.ts";

describe("HTTP access rules", () => {
  const fixture = new Fixture();
  let server: TestServer;
  let inside: string;
  let outside: string;
  let id: string;

  before(async () => {
    const root = join(fixture.root, "root");
    mkdirSync(root);
    inside = fixture.init("root/inside");
    fixture.commit(inside, "inside: first", { "tracked.txt": "same" });
    fixture.write(inside, "dirty.txt", "untracked");
    outside = fixture.init("outside");
    fixture.commit(outside, "outside: secret", { "secret.txt": "do not show" });
    // A symbolic link from inside the root to a repository outside it is not followed.
    symlinkSync(outside, join(root, "link-to-outside"));
    server = await startTestServer({ roots: [{ path: root, depth: 2 }] });
    const repos = (await raw(server.port, "/api/repos", { headers: server.auth })).json<{ repositories: Array<{ id: string; name: string }> }>();
    id = repos.repositories.find((repo) => repo.name === "inside")!.id;
  });

  after(async () => {
    await server?.close();
    fixture.dispose();
  });

  it("lists only repositories under the configured roots", async () => {
    const repos = (await raw(server.port, "/api/repos", { headers: server.auth })).json<{ repositories: Array<{ name: string }> }>();
    assert.deepEqual(repos.repositories.map((repo) => repo.name), ["inside"]);
  });

  it("accepts loopback Host names on any port (Herdr may forward to another one)", async () => {
    for (const host of [`127.0.0.1:${server.port}`, "localhost:41234", "[::1]:3020", "127.0.0.1", "LOCALHOST:1"]) {
      assert.equal((await raw(server.port, "/api/health", { headers: { host } })).status, 200, host);
    }
  });

  it("rejects other Host names (DNS rebinding)", async () => {
    for (const host of ["evil.example", "evil.example:3020", "127.0.0.1.evil.example", "192.0.2.10:3020", "0.0.0.0:3020", "localhost.evil.example"]) {
      const response = await raw(server.port, "/api/health", { headers: { host } });
      assert.equal(response.status, 403, host);
    }
    assert.equal((await raw(server.port, "/", { headers: { host: "evil.example" } })).status, 403, "the page itself too");
  });

  it("rejects cross-origin and cross-site API requests and never sends CORS headers", async () => {
    const host = `localhost:${server.port}`;
    assert.equal((await raw(server.port, "/api/repos", { headers: { host, origin: `http://${host}`, ...server.auth } })).status, 200);
    for (const origin of ["http://evil.example", "null", `http://localhost:${server.port + 1}`, `https://${host}`]) {
      const response = await raw(server.port, "/api/repos", { headers: { host, origin } });
      assert.equal(response.status, 403, origin);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
    assert.equal((await raw(server.port, "/api/repos", { headers: { host, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await raw(server.port, "/api/repos", { headers: { host, "sec-fetch-site": "same-site" } })).status, 403);
    assert.equal((await raw(server.port, "/api/repos", { headers: { host, "sec-fetch-site": "same-origin", ...server.auth } })).status, 200);
    const preflight = await raw(server.port, `/v1/repositories/${id}/diff`, {
      method: "OPTIONS",
      headers: { host, origin: "http://evil.example", "access-control-request-method": "POST" }
    });
    assert.notEqual(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  });

  it("refuses every method but reads, so no route can write", async () => {
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      for (const path of ["/api/repos", `/api/repos/${id}/worktree`, `/v1/repositories/${id}/history`, "/"]) {
        const response = await raw(server.port, path, { method });
        assert.equal(response.status, 405, `${method} ${path}`);
      }
    }
    assert.equal((await raw(server.port, `/api/repos/${id}/worktree`, { method: "POST" })).status, 405);
    assert.equal((await raw(server.port, `/v1/repositories/${id}/history`, { method: "POST" })).status, 405);
    assert.doesNotThrow(() => checkMethod("POST", `/v1/repositories/${id}/diff`));
    const writes = ROUTES.filter((route) => !route.startsWith("GET "));
    assert.deepEqual(
      writes,
      ["POST /api/session", "POST /v1/repositories/:id/compare", "POST /v1/repositories/:id/diff"],
      "only the login exchange and the two read-only POST computations"
    );
  });

  it("resolves repositories only by registered id, never by path", async () => {
    for (const bad of ["not-registered", repoId(outside), encodeURIComponent(outside), "..%2F..%2Fetc", encodeURIComponent("../outside")]) {
      assert.equal((await raw(server.port, `/api/repos/${bad}/info`, { headers: server.auth })).status, 404, bad);
      assert.equal((await raw(server.port, `/v1/repositories/${bad}/history`, { headers: server.auth })).status, 404, bad);
    }
  });

  it("serves diffs only for files Git lists in that section of the working tree", async () => {
    const ok = await raw(server.port, `/api/repos/${id}/worktree/diff?section=untracked&path=dirty.txt`, { headers: server.auth });
    assert.equal(ok.status, 200);
    assert.match(ok.json<{ patch: string }>().patch, /\+untracked/);
    for (const query of [
      "section=untracked&path=../outside/secret.txt",
      `section=untracked&path=${encodeURIComponent(join(outside, "secret.txt"))}`,
      "section=unstaged&path=tracked.txt",
      "section=staged&path=dirty.txt",
      "section=everything&path=dirty.txt",
      "section=untracked&path=/etc/passwd"
    ]) {
      assert.equal((await raw(server.port, `/api/repos/${id}/worktree/diff?${query}`, { headers: server.auth })).status, 400, query);
    }
  });

  it("serves only the page's own files", async () => {
    assert.equal((await raw(server.port, "/")).status, 200);
    assert.equal((await raw(server.port, "/app.js")).status, 200);
    for (const path of ["/../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc%2fpasswd", "/.git/config", "/.env", "/server/main.ts", "/package.json"]) {
      assert.equal((await raw(server.port, path)).status, 404, path);
    }
  });

  it("sends a strict content security policy and no-store API responses", async () => {
    const page = await raw(server.port, "/");
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    const apiResponse = await raw(server.port, `/v1/repositories/${id}/history?limit=5`, { headers: server.auth });
    assert.equal(apiResponse.headers["cache-control"], "no-store");
    assert.match(String(apiResponse.headers["content-security-policy"]), /default-src 'none'/);
  });

  it("needs a session for every API route but health and the ticket exchange", async () => {
    const routes = ["/api/repos", `/api/repos/${id}/info`, `/api/repos/${id}/worktree`, `/api/repos/${id}/search?q=a`, `/api/repos/${id}/events`, `/v1/repositories`, `/v1/repositories/${id}/history`, "/v1/capabilities"];
    for (const path of routes) {
      assert.equal((await raw(server.port, path)).status, 401, `${path} without a session`);
      assert.equal((await raw(server.port, path, { headers: { authorization: "Bearer not-the-session" } })).status, 401, `${path} with a wrong session`);
      assert.equal((await raw(server.port, path, { headers: { authorization: `Bearer ${server.session}x` } })).status, 401, `${path} with a longer token`);
    }
    const diff = await raw(server.port, `/v1/repositories/${id}/diff`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(diff.status, 401);
    // The session travels as a parameter only for the change stream, which EventSource cannot give headers.
    assert.equal((await raw(server.port, `/api/repos?s=${server.session}`)).status, 401);
    const stream = await new Promise<number>((done) => {
      const req = httpRequest({ host: "127.0.0.1", port: server.port, path: `/api/repos/${id}/events?s=${server.session}`, headers: { host: `127.0.0.1:${server.port}` } }, (res) => {
        done(res.statusCode ?? 0);
        req.destroy();
      });
      req.on("error", () => {});
      req.end();
    });
    assert.equal(stream, 200);
    const health = await raw(server.port, "/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys(health.json<object>()).sort(), ["app", "pid", "port", "startedAt", "version"], "health tells nothing about repositories");
    assert.equal((await raw(server.port, "/")).status, 200, "the page itself has no data");
  });

  it("trades a one-time, short-lived, signed ticket for the session; never sets a cookie", async () => {
    const redeem = (ticket: string) =>
      raw(server.port, "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
    const ticket = server.ticket();
    const first = await redeem(ticket);
    assert.equal(first.status, 200);
    assert.equal(first.json<{ session: string }>().session, server.session);
    assert.equal(first.headers["set-cookie"], undefined);
    assert.equal((await redeem(ticket)).status, 401, "a ticket works once");
    assert.equal((await redeem(server.ticket(Date.now() - 10 * 60_000))).status, 401, "an expired ticket");
    assert.equal((await redeem(server.ticket(Date.now() + 10 * 60_000))).status, 401, "a ticket from the future");
    assert.equal((await redeem(makeTicket(newSecret()))).status, 401, "a ticket signed with another secret");
    const valid = server.ticket();
    assert.equal((await redeem(`${valid.slice(0, -2)}AA`)).status, 401, "a tampered signature");
    for (const junk of ["", "v1", "v1.1.2.3", "v2.1.abcdefgh.x", "x".repeat(1500)]) assert.equal((await redeem(junk)).status, 401, junk.slice(0, 20));
    const huge = await raw(server.port, "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: "x".repeat(5_000) }) });
    assert.equal(huge.status, 413);
  });

  it("ends every session when the secret is rotated, without a restart", async () => {
    const before = await raw(server.port, "/api/repos", { headers: server.auth });
    assert.equal(before.status, 200);
    const secret = newSecret();
    await new Promise((wait) => setTimeout(wait, 15));
    writeFileSync(server.config.tokenFile, `${secret}\n`);
    assert.equal((await raw(server.port, "/api/repos", { headers: server.auth })).status, 401, "the old session no longer works");
    assert.equal((await raw(server.port, "/api/repos", { headers: { authorization: `Bearer ${sessionFor(secret)}` } })).status, 200);
    const store = new TokenStore(server.config.tokenFile);
    assert.equal(store.redeem(makeTicket(secret)), sessionFor(secret));
  });

  it("refuses to listen anywhere but loopback", () => {
    for (const host of ["0.0.0.0", "::", "192.0.2.10", "example.com"]) {
      assert.throws(() => normalizeConfig({ host }), /loopback/);
    }
    assert.throws(() => normalizeConfig({ port: 80 }), /port/);
    assert.throws(() => normalizeConfig({ roots: [{ path: "/", depth: 2 }] }), /root/);
  });
});
