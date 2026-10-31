#!/usr/bin/env node
/**
 * The transcript's copy menu and overlay scrollbar in the real app, on the bench Harness:
 * right-click a reply (Copy message, Copy turn output, to the clipboard), no native scrollbar,
 * the overlay bar while scrolling and on the edge, clear of the Turn rail. Both themes.
 *
 *   node scripts/transcriptCopyScreens.ts --out <dir> [--build] [--classic-scrollbars]
 *
 * `--classic-scrollbars` asks macOS for always-shown scrollbars, as with a mouse attached.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";
import { seedSource } from "./lib/seed.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("usage: node scripts/transcriptCopyScreens.ts --out <dir>");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

mkdirSync(out, { recursive: true });

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-transcript-copy-")));

const bench = (script: Record<string, number>) => `bench:${JSON.stringify(script)}`;

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(250);
};

/** `before` runs again after each theme switch (a menu closes when the page re-renders). */
const shoot = async (page: Page, name: string, before: () => Promise<void> = async () => {}) => {
  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await before();
    await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
    await page.keyboard.press("Escape");
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
  await idle(page);
};

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: stockElectronBinary(),
  args: [
    APP_DIR,
    ...(args.includes("--classic-scrollbars") ? ["-AppleShowScrollBars", "Always"] : []),
  ],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1280, 900);
  await page.evaluate(
    seedSource([
      { hostKey: "local", name: "proof", sessions: [{ title: "Copy proof", state: "idle" }] },
    ])
  );
  await page.locator('[data-slot="chip"]', { hasText: "proof" }).first().click();
  await page.getByText("Copy proof", { exact: true }).first().click();
  await idle(page);

  // Six items make two replies (kinds rotate every five); each prompt differs by its interval.
  for (const n of [1, 2, 3])
    await send(page, bench({ items: 6, deltasPerItem: 3, deltaIntervalMs: n, itemBytes: 900 }));
  // Let the bar shown by the list following new output hide again.
  await page.mouse.move(400, 400);
  await page.waitForTimeout(1300);

  // The native scrollbar takes no width: the list's client width is its whole width.
  const conversation = page.getByTestId("conversation");

  const nativeBar = await page.evaluate<number>(
    `(() => { const el = document.querySelector('[data-testid="conversation"]'); return el.offsetWidth - el.clientWidth; })()`
  );

  console.log(`native scrollbar width: ${nativeBar}px`);
  assert.equal(nativeBar, 0, "the conversation shows no native scrollbar");

  const bar = page.getByTestId("conversation-scrollbar");

  assert.equal(await bar.getAttribute("data-shown"), "false", "the bar is hidden at rest");
  await shoot(page, "rest");

  // Scrolling shows the bar; the rail's ticks stay left of it.
  const wheel = async () => {
    const box = await conversation.boundingBox();

    assert.ok(box !== null);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(200);
  };

  await wheel();
  assert.equal(await bar.getAttribute("data-shown"), "true", "scrolling shows the bar");

  const [railBox, barBox] = await Promise.all([
    page.getByTestId("turn-rail").boundingBox(),
    bar.boundingBox(),
  ]);

  assert.ok(railBox !== null && barBox !== null);
  console.log(`rail right ${railBox.x + railBox.width}, bar left ${barBox.x}`);
  assert.ok(railBox.x + railBox.width <= barBox.x, "the rail stays clear of the scrollbar");
  await shoot(page, "scrolling", wheel);

  // The bar hides again, and comes back with the pointer on the edge.
  await page.mouse.move(400, 400);
  await page.waitForTimeout(1300);
  assert.equal(await bar.getAttribute("data-shown"), "false", "the bar hides after scrolling");

  const edge = async () => {
    const box = await bar.boundingBox();

    assert.ok(box !== null);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(250);
  };

  await edge();
  assert.equal(await bar.getAttribute("data-shown"), "true", "the edge shows the bar");
  await shoot(page, "edge-hover", edge);

  // The old "Copy output" button is gone; right-click a reply of a finished Turn.
  assert.equal(await page.getByRole("button", { name: "Copy output" }).count(), 0);

  const reply = page.getByTestId("message").last();

  const openMenu = async () => {
    await reply.scrollIntoViewIfNeeded();
    await reply.click({ button: "right", position: { x: 40, y: 10 } });
    await page.getByTestId("turn-menu").waitFor();
    await page.waitForTimeout(250);
  };

  await openMenu();

  const items = await page.getByTestId("turn-menu").getByRole("menuitem").allTextContents();

  console.log(`menu: ${items.join(" | ")}`);
  assert.deepEqual(items, ["Copy message", "Copy turn output"]);
  await page.keyboard.press("Escape");
  await shoot(page, "menu", openMenu);

  const clipboard = () => app.evaluate(({ clipboard: c }) => c.readText());

  await openMenu();
  await page.getByRole("menuitem", { name: "Copy turn output" }).click();
  await page.getByText("Copied turn output").waitFor();

  const output = await clipboard();

  assert.ok(output.includes("\n\n"), "the Turn's output joins its replies");
  console.log(`ok: copied turn output (${output.length} chars)`);
  await page.screenshot({ path: join(out, "copied-toast-dark.png") });

  await openMenu();
  await page.getByRole("menuitem", { name: "Copy message" }).click();
  await page.waitForTimeout(200);
  assert.ok((await clipboard()).length < output.length, "Copy message copies one reply");
  console.log("ok: copied message");

  // The hover icon stays on a reply.
  await reply.hover();
  await page.getByRole("button", { name: "Copy message" }).last().waitFor();
  await shoot(page, "hover-icon", () => reply.hover());
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
