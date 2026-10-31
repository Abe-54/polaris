/**
 * The transcript's structure in the real app, on the bench Harness: node
 * apps/desktop/scripts/transcriptSmoke.ts (build first). A new Turn never folds
 * the one being read, a Turn folds and opens by hand, Turns show their time, and
 * ⌘F finds text in folded and open Turns. Screenshots in both themes go to
 * `.dagr/evidence/tstruct`.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";
import { seedSource } from "./lib/seed.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-transcript-")));

const userData = join(home, "user-data");

const evidence = join(REPO_ROOT, ".dagr/evidence/tstruct");

for (const path of [userData, evidence]) mkdirSync(path, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

const bench = (script: Record<string, number>) => `bench:${JSON.stringify(script)}`;

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(250);
};

const shoot = async (page: Page, name: string) => {
  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.screenshot({ path: join(evidence, `${name}-${theme}.png`) });
  }

  await appearance(page, "dark");
  console.log(`shot: ${name}`);
};

const idle = (page: Page) =>
  page.getByTestId("session-state").filter({ hasText: /^Idle/ }).waitFor({ timeout: 60_000 });

const send = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input");

  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await page.getByTestId("prompt").filter({ hasText: text }).first().waitFor();
};

const counts = async (page: Page) => ({
  prompts: await page.getByTestId("prompt").count(),
  summaries: await page.getByTestId("turn-summary").count(),
});

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  daemon = await startDaemon({ home, benchHarness: true });
  const socket = daemon.socketPath;

  const launch = () =>
    electron.launch({
      executablePath: stockElectronBinary(),
      args: [APP_DIR],
      env: {
        ...process.env,
        POLARIS_DESKTOP_LOCAL_SOCKET: socket,
        POLARIS_DESKTOP_BENCH_HARNESS: "1",
        POLARIS_DESKTOP_USER_DATA: userData,
        POLARIS_DESKTOP_HIDDEN: "1",
      },
    });

  app = await launch();

  let page = await app.firstWindow();

  await sizeWindow(app, 1280, 900);
  await page.evaluate(
    seedSource([
      { hostKey: "local", name: "proof", sessions: [{ title: "Transcript proof", state: "idle" }] },
    ])
  );
  await page.locator('[data-slot="chip"]', { hasText: "proof" }).first().click();
  await page.getByText("Transcript proof", { exact: true }).first().click();
  await idle(page);

  // C5: the Turn's time sits beside its Model under the prompt.
  const time = await page.getByTestId("turn-time").first().textContent();

  assert.match(time ?? "", /^\d{2}:\d{2}$/, `turn time reads ${time}`);
  console.log(`ok: turn time ${time}`);

  // C2: the Turn being read stays open while newer Turns arrive.
  await send(page, "Second turn: keep the first one open");
  await idle(page);
  await send(page, bench({ items: 2, deltasPerItem: 2, deltaIntervalMs: 5 }));
  await idle(page);
  assert.deepEqual(await counts(page), { prompts: 3, summaries: 0 });
  console.log("ok: three Turns, none folded by the newer ones");
  await shoot(page, "c2-turns-stay-open");

  // C2: fold the first Turn by hand; it stays folded, then opens again.
  const first = page.getByTestId("prompt").first();

  await first.hover();
  await first.getByTestId("turn-fold").click();
  await page.getByTestId("turn-summary").first().waitFor();
  assert.deepEqual(await counts(page), { prompts: 2, summaries: 1 });
  await shoot(page, "c2-folded-by-hand");
  await send(page, "Fourth turn: the folded one stays folded");
  await idle(page);
  assert.deepEqual(await counts(page), { prompts: 3, summaries: 1 });
  await page.getByTestId("turn-summary").first().click();
  assert.deepEqual(await counts(page), { prompts: 4, summaries: 0 });
  console.log("ok: fold and open by hand");

  await shoot(page, "c5-turn-times");

  // C4: ⌘F finds in a folded Turn, opens it, lights the match and steps through the rest.
  const second = page.getByTestId("prompt").nth(1);

  await second.hover();
  await second.getByTestId("turn-fold").click();
  await page.getByTestId("turn-summary").first().waitFor();
  await page.getByTestId("composer-input").click();
  await page.keyboard.press("Meta+KeyF");

  const field = page.getByTestId("transcript-search-input");
  const count = page.getByTestId("transcript-search-count");

  await field.waitFor();
  await field.fill("keep the first");
  await count.filter({ hasText: "1 of 1" }).waitFor();
  assert.deepEqual(await counts(page), { prompts: 4, summaries: 0 });

  const lit = () =>
    page.evaluate(
      `[CSS.highlights.get("transcript-match")?.size ?? 0, CSS.highlights.get("transcript-current")?.size ?? 0]`
    );

  await page.waitForTimeout(200);
  assert.deepEqual(await lit(), [1, 1]);
  console.log("ok: ⌘F opened the folded Turn and lit its match");
  await shoot(page, "c4-find-in-folded-turn");

  await field.fill("turn");
  await count.filter({ hasText: /^1 of \d+$/ }).waitFor();
  await field.press("Enter");
  await count.filter({ hasText: /^2 of \d+$/ }).waitFor();
  await field.press("Shift+Enter");
  await count.filter({ hasText: /^1 of \d+$/ }).waitFor();
  // Prompts and replies only: the bench's `bun test` command line isn't searched.
  await field.fill("bun test");
  await count.filter({ hasText: "No matches" }).waitFor();
  await field.fill("nothing like this anywhere");
  await count.filter({ hasText: "No matches" }).waitFor();
  await shoot(page, "c4-no-matches");
  await field.press("Escape");
  await page.getByTestId("transcript-search").waitFor({ state: "detached" });
  assert.deepEqual(await lit(), [0, 0]);
  console.log("ok: ↵ and ⇧↵ step, esc closes and clears");

  // C1: the Turn rail, a tick per Turn; hover arcs and previews, click jumps, keys move.
  const rail = page.getByTestId("turn-rail");
  const options = rail.getByRole("option");

  await rail.waitFor();
  assert.equal(await options.count(), 4);

  const box = await rail.getByRole("listbox").boundingBox();

  assert.ok(box !== null, "the rail has a box");
  await page.mouse.move(box.x + box.width - 8, box.y + 6);
  const preview = page.getByTestId("turn-rail-preview");

  await preview.filter({ hasText: "Turn 1" }).waitFor();
  await page.waitForTimeout(200);
  await shoot(page, "c1-rail-hover");
  await page.mouse.click(box.x + box.width - 8, box.y + 6);
  await page.waitForTimeout(400);

  const top = Number(
    await page.evaluate(`(() => {
    const list = document.querySelector('[data-testid="conversation"]').getBoundingClientRect();
    const first = document.querySelector('[data-testid="prompt"]').getBoundingClientRect();
    return first.top - list.top;
  })()`)
  );

  assert.ok(top >= 0 && top < 80, `Turn 1's prompt sits at the top (${top}px)`);
  console.log("ok: hover previews Turn 1, click jumps to it");

  await page.mouse.move(box.x - 300, box.y);
  // Tab backwards from the composer until the rail has focus, as a keyboard user would.
  await page.getByTestId("composer-input").click();

  for (let i = 0; i < 40; i++) {
    const role = await page.evaluate(`document.activeElement?.getAttribute("role")`);

    if (role === "listbox") break;
    await page.keyboard.press("Shift+Tab");
  }

  await preview.waitFor();
  await page.keyboard.press("End");
  await page.waitForTimeout(300);
  await preview.filter({ hasText: "Turn 4" }).waitFor();
  await page.keyboard.press("ArrowUp");
  await preview.filter({ hasText: "Turn 3" }).waitFor();
  assert.equal(
    await page.evaluate(`getComputedStyle(document.activeElement).outlineStyle`),
    "solid",
    "the focused rail shows the Starlight ring"
  );
  await shoot(page, "c1-rail-keyboard");
  await page.keyboard.press("Enter");
  console.log("ok: Tab in, ↑ moves, ↵ jumps");

  // The arc animates transform only, 140ms; Reduce Motion keeps only the pointed tick long.
  const ticks = () =>
    page.evaluate(`[...document.querySelectorAll('[data-testid="turn-rail"] [role="option"] span')].map((t) => {
      const style = getComputedStyle(t);
      return [Number(new DOMMatrix(style.transform).a.toFixed(2)), style.transitionDuration];
    })`);

  await page.mouse.move(box.x + box.width - 8, box.y + 4 + 8 + 4);
  await page.waitForTimeout(300);
  assert.deepEqual(await ticks(), [
    [0.86, "0.14s"],
    [1, "0.14s"],
    [0.86, "0.14s"],
    [0.73, "0.14s"],
  ]);
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { motion: "reduce" } })`
  );
  await page.locator('html[data-reduce-motion="true"]').waitFor({ state: "attached" });
  await page.mouse.move(box.x + box.width - 10, box.y + 4 + 8 + 5);
  await page.waitForTimeout(100);
  assert.deepEqual(await ticks(), [
    [0.36, "0s"],
    [1, "0s"],
    [0.36, "0s"],
    [0.36, "0s"],
  ]);
  console.log("ok: 140ms arc on transform; Reduce Motion drops it");

  // Paging: past the feed's 20 Turns, a relaunch shows the last 20; the top loads the rest.
  for (let n = 5; n <= 25; n++) {
    await send(page, `Turn ${n} of the paging run`);
    await idle(page);
  }

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await sizeWindow(app, 1280, 900);
  await page.locator('[data-slot="chip"]', { hasText: "proof" }).first().click();
  await page.getByText("Transcript proof", { exact: true }).first().click();
  await idle(page);

  const loaded = async () =>
    Number(
      await page.evaluate(
        `document.querySelectorAll('[data-testid="turn-rail"] [role="option"]').length`
      )
    );

  assert.equal(await loaded(), 20, "the feed opens with the last 20 Turns");
  await page.evaluate(
    `document.querySelector('[data-testid="conversation"]').scrollTo({ top: 0 })`
  );
  await page.getByTestId("older-turns").waitFor();
  await shoot(page, "paging-loading");

  for (const end = Date.now() + 20_000; Date.now() < end && (await loaded()) < 25;)
    await page.waitForTimeout(250);

  assert.equal(await loaded(), 25, "scrolling to the top loaded the 5 older Turns");
  await page.getByTestId("older-turns").waitFor({ state: "detached" });

  // The page lands above what was on screen: the list keeps its place, Turn 6 still in view.
  const sixth = String(
    await page.evaluate(`(() => {
    const list = document.querySelector('[data-testid="conversation"]');
    const row = [...list.querySelectorAll('[data-testid="turn-summary"]')].find((r) => r.textContent.startsWith("Turn 6"));
    const box = list.getBoundingClientRect();
    const at = row?.getBoundingClientRect();
    return JSON.stringify({ scrollTop: list.scrollTop, visible: at !== undefined && at.bottom > box.top && at.top < box.bottom });
  })()`)
  );

  assert.match(sixth, /"visible":true/, `Turn 6 stays in view after the load: ${sixth}`);
  assert.ok(
    Number(/"scrollTop":(\d+)/.exec(sixth)?.[1]) > 200,
    `the list scrolled with the new rows instead of jumping to them: ${sixth}`
  );
  console.log("ok: the top loads older Turns, and stops at the first");
  await page.evaluate(
    `document.querySelector('[data-testid="conversation"]').scrollTo({ top: 0 })`
  );
  await page.waitForTimeout(300);
  await shoot(page, "paging-loaded");

  // H2 and per-message times on fixtures (the bench Harness doesn't stamp items).
  await page.evaluate(`location.hash = "#preview/order"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("turn-item").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);

  const order = await page.evaluate(
    `[...document.querySelectorAll('[data-testid="turn-item"], [data-testid="steered"]')].map((n) => n.dataset.kind ?? "steer")`
  );

  assert.deepEqual(order, ["command", "tool", "message", "steer", "message"]);
  await page
    .getByTestId("steered")
    .filter({ hasText: /Steered this turn\s*·\s*\d{2}:\d{2}/ })
    .waitFor();

  const reply = page.locator('[data-testid="turn-item"][data-kind="message"]').last();

  await reply.hover();
  await reply
    .getByTestId("reply-time")
    .filter({ hasText: /^\d{2}:\d{2}$/ })
    .waitFor();
  console.log("ok: the running command stays where it began; steer and reply times show");
  await shoot(page, "h2-order-and-times");
} finally {
  await app?.close().catch(() => undefined);
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
}
