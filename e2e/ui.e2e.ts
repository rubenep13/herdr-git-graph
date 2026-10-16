import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { PROJECT_DIR } from "../server/config.ts";
import { Fixture } from "../test/helpers/fixture.ts";
import { createDemoRepos, type DemoRepos } from "../test/helpers/demo.ts";
import { startTestServer, type TestServer } from "../test/helpers/http.ts";

/**
 * Drives the real page in a headless browser against synthetic fixture
 * repositories. Needs `npm run build` first. The browser is Google Chrome on
 * macOS (channel "chrome"), or HGG_BROWSER=/path/to/chromium elsewhere.
 * Screenshots go to e2e/artifacts/.
 */
const ARTIFACTS = join(PROJECT_DIR, "e2e", "artifacts");

async function launch(): Promise<Browser> {
  const executablePath = process.env.HGG_BROWSER ?? (process.platform === "linux" && existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: "chrome" }) });
}

describe("the viewer in a browser", () => {
  const fixture = new Fixture("hgg-e2e-");
  let demo: DemoRepos;
  let server: TestServer;
  let browser: Browser;
  let page: Page;
  let alphaId: string;
  const requests: string[] = [];
  const problems: string[] = [];

  before(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    demo = createDemoRepos(fixture);
    server = await startTestServer({ roots: [{ path: fixture.root, depth: 2 }] });
    const repos = (await (await fetch(`http://127.0.0.1:${server.port}/api/repos`)).json()) as { repositories: Array<{ id: string; name: string }> };
    alphaId = repos.repositories.find((repo) => repo.name === "alpha")!.id;
    browser = await launch();
    page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    page.on("request", (request) => requests.push(request.url()));
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    await page.goto(`http://127.0.0.1:${server.port}/#/repo/${alphaId}`);
    await page.waitForSelector(".row[data-row='3']");
  });

  after(async () => {
    await browser?.close();
    await server?.close();
    fixture.dispose();
  });

  const box = async (selector: string) => {
    const found = await page.locator(selector).first().boundingBox();
    assert.ok(found, `${selector} is visible`);
    return found;
  };

  it("puts refs left of the graph, joined to their commit, and messages in one column on the right", async () => {
    await page.screenshot({ path: join(ARTIFACTS, "01-history.png") });
    const row = page.locator(".row", { has: page.locator(".chip.current") }).first();
    const chip = await row.locator(".chip.current").boundingBox();
    const message = await row.locator(".cell.msg").boundingBox();
    const index = Number(await row.getAttribute("data-row"));
    const geometry = await page.evaluate((rowIndex) => {
      const svg = document.querySelector<SVGSVGElement>(".graph")!;
      const svgBox = svg.getBoundingClientRect();
      const top = document.querySelector<HTMLElement>(".row")!;
      const firstRow = Number(top.dataset.row);
      const rowHeight = top.getBoundingClientRect().height;
      const y = (rowIndex - firstRow) * rowHeight + rowHeight / 2;
      const circle = [...svg.querySelectorAll("circle")].find((item) => Number(item.getAttribute("cy")) === y)!;
      const connector = [...svg.querySelectorAll(".connectors line")].find((item) => Number(item.getAttribute("y1")) === y)!;
      return {
        nodeX: svgBox.left + Number(circle.getAttribute("cx")),
        connectorFrom: svgBox.left + Number(connector.getAttribute("x1")),
        connectorTo: svgBox.left + Number(connector.getAttribute("x2")),
        svgLeft: svgBox.left
      };
    }, index);
    assert.ok(chip && message);
    assert.ok(chip.x + chip.width <= geometry.svgLeft, "the label ends before the graph starts");
    assert.ok(geometry.nodeX < message.x, "the node is left of the message");
    assert.equal(geometry.connectorFrom, geometry.svgLeft, "the connector starts at the label column");
    assert.ok(geometry.connectorTo < geometry.nodeX && geometry.nodeX - geometry.connectorTo <= 11, "and ends at the node");
    const starts = await page.locator(".row .cell.msg").evaluateAll((cells) => [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().left)))]);
    assert.equal(starts.length, 1, "every message starts in the same column");
  });

  it("selects with the keyboard and shows the commit with its parents, refs and a lazy diff", async () => {
    await page.locator(".viewport").focus();
    await page.keyboard.press("Home");
    for (let step = 0; step < 3; step += 1) await page.keyboard.press("j");
    const selected = page.locator(".row.selected");
    assert.equal(await selected.getAttribute("data-row"), "3");
    const expected = (await selected.locator(".subject").textContent())?.trim();
    // Keyboard selection loads the detail after a short pause (skimming with j/k stays cheap).
    await page.waitForFunction((text) => document.querySelector(".details .subject")?.textContent === text, expected);
    assert.ok(await page.locator(".details .ref-pill", { hasText: "v1.0.0" }).count(), "the annotated tag is listed on its commit");
    assert.equal(await page.locator(".details .patch").count(), 0, "no diff is loaded before a file is chosen");
    await page.locator(".details .file").first().click();
    await page.waitForSelector(".details .patch .pl-add");
    await page.screenshot({ path: join(ARTIFACTS, "02-commit-diff.png") });
  });

  it("shows staged, unstaged and untracked changes of the working tree", async () => {
    await page.keyboard.press("w");
    await page.waitForSelector(".details .section-staged");
    const heads = await page.locator(".details .files-head").allTextContents();
    assert.ok(heads.some((text) => text.startsWith("Preparados")));
    assert.ok(heads.some((text) => text.startsWith("Sin preparar")));
    assert.ok(heads.some((text) => text.startsWith("Sin seguimiento")));
    await page.locator(".details .file", { hasText: "notes-untracked.md" }).click();
    await page.waitForSelector(".details .patch .pl-add");
    await page.screenshot({ path: join(ARTIFACTS, "03-worktree.png") });
  });

  it("loads more history while scrolling, keeping every row's lane", async () => {
    const before = await page.evaluate(() => document.querySelector(".statusbar")!.textContent);
    assert.match(before!, /300 commits cargados \(hay más\)/);
    const lanesBefore = await page.evaluate(() => {
      return [...document.querySelectorAll<HTMLElement>(".row")].slice(0, 5).map((row) => row.dataset.oid);
    });
    for (let step = 0; step < 12; step += 1) {
      await page.locator(".viewport").evaluate((element) => (element.scrollTop = element.scrollHeight));
      await page.waitForTimeout(250);
    }
    await page.waitForFunction(() => !/hay más/.test(document.querySelector(".statusbar")!.textContent ?? ""), undefined, { timeout: 20_000 });
    const after = await page.evaluate(() => document.querySelector(".statusbar")!.textContent);
    assert.match(after!, /\d+ commits/);
    await page.screenshot({ path: join(ARTIFACTS, "04-end-of-history.png") });
    // Back at the top the same commits sit in the same rows.
    await page.locator(".viewport").evaluate((element) => (element.scrollTop = 0));
    await page.waitForTimeout(200);
    const lanesAfter = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".row")].slice(0, 5).map((row) => row.dataset.oid));
    assert.deepEqual(lanesAfter, lanesBefore);
  });

  it("searches the whole history and jumps to the result", async () => {
    await page.keyboard.press("/");
    await page.keyboard.type("f40): second");
    await page.waitForSelector(".search-results .result");
    await page.screenshot({ path: join(ARTIFACTS, "05-search.png") });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /f40\): second/.test(document.querySelector(".row.selected .subject")?.textContent ?? ""));
    assert.ok(await page.locator(".row.match").count(), "matches are highlighted in the graph");
    await page.keyboard.press("Escape");
  });

  it("opens every label of a commit, with long names in full", async () => {
    await page.locator(".viewport").focus();
    await page.keyboard.press("Home");
    const more = page.locator(".chip-more").first();
    await more.click();
    await page.waitForSelector(".popover:not(.hidden)");
    const text = await page.locator(".popover").textContent();
    assert.ok(text?.includes(demo.longBranch), "the long branch name is shown in full");
    await page.screenshot({ path: join(ARTIFACTS, "06-refs-popover.png") });
    await page.keyboard.press("Escape");
  });

  it("switches repository with the quick picker and handles an empty one", async () => {
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".picker-input");
    await page.keyboard.type("beta");
    await page.screenshot({ path: join(ARTIFACTS, "07-picker.png") });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".repo-button")?.textContent?.includes("beta"));
    await page.waitForFunction(() => document.querySelectorAll(".row").length === 2);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("empty");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /vacío/.test(document.querySelector(".state-overlay:not(.hidden)")?.textContent ?? ""));
    await page.keyboard.press("Control+k");
    await page.keyboard.type("hotfix");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".repo-button")?.textContent?.includes("hotfix/urgent"));
  });

  it("shows only branch/tag, graph and message by default, and adds author, date and SHA from the gear", async () => {
    await page.keyboard.press("Control+k");
    await page.keyboard.type("alpha");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".repo-button")?.textContent?.includes("alpha"));
    await page.waitForSelector(".row[data-row='3']");
    assert.equal(await page.locator(".row .cell.author").count(), 0, "GitKraken's default columns");
    assert.ok(await page.locator(".row .when").count(), "relative time markers replace the date column");
    await page.locator(".col-gear").click();
    for (const label of ["Autor", "Fecha", "SHA"]) await page.locator(".col-menu-item", { hasText: label }).locator("input").check();
    await page.waitForSelector(".row .cell.hash");
    assert.ok(await page.locator(".row .cell.author").count());
    await page.screenshot({ path: join(ARTIFACTS, "08-all-columns.png") });
    await page.reload();
    await page.waitForSelector(".row .cell.hash");
    assert.ok(true, "the choice survives a reload");
    await page.locator(".col-gear").click();
    for (const label of ["Autor", "Fecha", "SHA"]) await page.locator(".col-menu-item", { hasText: label }).locator("input").uncheck();
    await page.waitForFunction(() => !document.querySelector(".row .cell.hash"));
  });

  it("only ever talks to its own server, without errors", async () => {
    const origin = `http://127.0.0.1:${server.port}/`;
    assert.deepEqual(requests.filter((url) => !url.startsWith(origin) && !url.startsWith("data:")), []);
    assert.deepEqual(problems, []);
  });
});
