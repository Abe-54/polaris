/**
 * The arcade in the real app on an isolated profile: node apps/desktop/scripts/arcadeSmoke.ts
 * [out dir] (build first). A partial name finds no game; "pong" and "space invaders" open
 * theirs, the keys play them, p pauses, esc closes; screenshots in both themes.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { scriptedElectron as electron, APP_DIR, stockElectronBinary } from "./lib/electron.ts";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-arcade-")));

const userData = join(profile, "user-data");

const out = process.argv[2] ?? join(tmpdir(), "polaris-arcade-screens");

mkdirSync(userData);

mkdirSync(out, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

const launch = async () => {
  if (daemon === undefined) throw new Error("Daemon missing");

  app = await electron.launch({
    executablePath: stockElectronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });

  return page;
};

const rows = (page: Page) => page.getByTestId("palette-row").allTextContents();

const search = async (page: Page, query: string) => {
  await page.keyboard.press("Meta+Shift+P");
  await page.getByTestId("command-palette").waitFor({ timeout: 10_000 });
  await page.getByTestId("palette-input").fill(query);
  await page.waitForTimeout(150);
};

const theme = async (page: Page, value: "dark" | "light") => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${value}" } })`
  );
  await page.locator(`html[data-theme="${value}"]`).waitFor({ state: "attached" });
};

/** Holds a key for a while, as a player would. */
const hold = async (page: Page, key: string, ms: number) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};

const play = async (page: Page, query: string, title: string, keys: ReadonlyArray<string>) => {
  await search(page, query);
  assert.deepEqual(await rows(page), [title], `"${query}" finds only ${title}`);
  await page.keyboard.press("Enter");

  const arcade = page.getByTestId("arcade");

  await arcade.waitFor({ timeout: 10_000 });

  for (const key of keys) await hold(page, key, 400);
  await page.waitForTimeout(600);

  return arcade;
};

try {
  daemon = await startDaemon({ home: profile, benchHarness: true });
  const page = await launch();

  await theme(page, "dark");

  for (const partial of ["po", "pon", "space", "invaders"]) {
    await search(page, partial);
    const shown = await rows(page);

    assert.ok(
      !shown.includes("Pong") && !shown.includes("Space Invaders"),
      `"${partial}" shows no game`
    );
    await page.keyboard.press("Escape");
  }

  console.log("a partial name finds no game");

  const invaders = await play(page, "space invaders", "Space Invaders", [
    "ArrowLeft",
    "Space",
    "ArrowRight",
    "Space",
  ]);

  await page.screenshot({ path: join(out, "invaders-dark.png") });
  await theme(page, "light");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, "invaders-light.png") });
  await page.keyboard.press("KeyP");
  await invaders.getByRole("status").filter({ hasText: "Paused" }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(out, "invaders-paused-light.png") });
  await page.keyboard.press("Escape");
  await invaders.waitFor({ state: "detached", timeout: 5_000 });
  console.log("space invaders opens, plays, pauses and closes");

  const pong = await play(page, "pong", "Pong", ["ArrowUp", "ArrowDown", "ArrowDown"]);

  await page.screenshot({ path: join(out, "pong-light.png") });
  await theme(page, "dark");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, "pong-dark.png") });
  await page.keyboard.press("Escape");
  await pong.waitFor({ state: "detached", timeout: 5_000 });
  console.log(`pong opens, plays and closes; screenshots in ${out}`);
} finally {
  await app?.close();
  await daemon?.stop();
  rmSync(profile, { recursive: true, force: true });
}
