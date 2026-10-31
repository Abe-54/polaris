#!/usr/bin/env node
/**
 * Space on a Constellation's Lead row (Paper 13) against a real Daemon: in the Workspace
 * sidebar's group and as a compact row in the machine sidebar (11+ Workspaces, Lead pinned),
 * hovered and focused. The preview opens and Space never scrolls the sidebar. Both themes.
 *
 *   node scripts/leadPeekSmoke.ts --out <dir> [--build]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Locator, type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  REPO_ROOT,
} from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("usage: node scripts/leadPeekSmoke.ts --out <dir> [--build]");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-lead-peek-"));

const repo = join(home, "code", "polaris");

mkdirSync(repo, { recursive: true });

spawnSync("git", ["init", "-q", repo]);

spawnSync(
  "git",
  ["-c", "user.name=P", "-c", "user.email=p@e.invalid", "commit", "-q", "--allow-empty", "-m", "b"],
  { cwd: repo }
);

// A first run writes the Host's identity; the graph is seeded while no Daemon holds the store.
const first = await startDaemon({ home, benchHarness: true });

await first.stop();

const seeded = spawnSync(
  "bun",
  [join(REPO_ROOT, "apps/daemon/src/engine/constellation.uiFixture.ts"), home, repo],
  { cwd: REPO_ROOT, encoding: "utf8" }
);

if (seeded.status !== 0) throw new Error(`seeding failed: ${seeded.stderr}`);

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

/** Sends a Daemon command written as the bridge's JSON (`command` is a JS object literal). */
const dispatch = (page: Page, command: string) =>
  page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: ${command} })`
  );

const sidebarScroll = (page: Page) =>
  page.evaluate<number>(`document.querySelector("aside [data-session-row]")
    ?.closest("[class*=overflow-y-auto]")?.scrollTop ?? -1`);

const appearance = async (page: Page, theme: "dark" | "light") => {
  await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${theme}" })`);
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

/** Space on `row` (hovered, or focused): the preview opens, nothing scrolls, Space closes it. */
const space = async (page: Page, row: Locator, how: "hover" | "focus", name: string) => {
  if (how === "hover") await row.hover();
  else await row.focus();
  await page.waitForTimeout(200);
  // Registered last, so it sees whether anything before it prevented the scroll.
  await page.evaluate(
    `window.__spacePrevented = null; window.addEventListener("keydown", (e) => { if (e.key === " ") window.__spacePrevented = e.defaultPrevented; }, { once: true })`
  );

  const before = await sidebarScroll(page);

  await page.keyboard.press("Space");
  await page.getByTestId("constellation-peek").waitFor({ timeout: 5_000 });

  const prevented = await page.evaluate<boolean | null>("window.__spacePrevented");
  const after = await sidebarScroll(page);

  if (prevented !== true || after !== before)
    throw new Error(`${name}: Space prevented=${prevented}, sidebar scroll ${before} → ${after}`);

  for (const theme of ["dark", "light"] as const) {
    await appearance(page, theme);
    await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
  }

  await appearance(page, "dark");
  await page.keyboard.press("Space");
  await page.getByTestId("constellation-peek").waitFor({ state: "detached", timeout: 5_000 });
  console.log(`peek: ${name} opens and closes on Space; the sidebar stays at ${after}`);
};

try {
  const page = await app.firstWindow();

  page.on("pageerror", (error) => console.log(`peek: page error: ${error.message}`));
  await page.setViewportSize({ width: 1200, height: 520 });

  const group = page.getByTestId("lead-group").first();

  await group.waitFor({ timeout: 30_000 });
  const leadId = await group.getAttribute("data-lead");
  const lead = group.locator('[data-slot="row"]').first();

  await space(page, lead, "hover", "workspace-hover");
  await space(page, lead, "focus", "workspace-focus");

  // Eleven more Workspaces: the machine sidebar, where the pinned Lead is a compact row.
  await dispatch(
    page,
    `{ _tag: "PinSession", sessionId: ${JSON.stringify(leadId)}, pinned: true }`
  );

  for (let i = 0; i < 11; i += 1) {
    const dir = join(home, "code", `ws${i}`);

    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q", dir]);
    await dispatch(
      page,
      `{ _tag: "RegisterWorkspace", path: ${JSON.stringify(dir)}, name: "ws${i}" }`
    );
  }

  await group.waitFor({ state: "detached", timeout: 15_000 });

  const compact = page
    .locator("aside [data-session-row]")
    .filter({ hasText: "Constellations v1 lead" })
    .first();

  await compact.waitFor({ timeout: 15_000 });
  await space(page, compact, "hover", "machine-hover");
  await space(page, compact, "focus", "machine-focus");
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
