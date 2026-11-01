#!/usr/bin/env node
/**
 * The span panel, Output's Traces tab and Traces' setup states on fixtures (DESIGN.md, Traces →
 * Span panel, Setup, In Orchestrate) in Midnight and light at every density. Needs a built app.
 *
 *   node scripts/tracesStatesScreens.ts <out dir> [--only span-db,empty]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const out = args.find((a) => !a.startsWith("--")) ?? "/tmp/t5-traces";

const onlyAt = args.indexOf("--only");

const only = onlyAt === -1 ? null : new Set((args[onlyAt + 1] ?? "").split(","));

interface Shot {
  readonly name: string;
  readonly hash: string;
  readonly ready: string;
  /** A span panel tab to pick first. */
  readonly tab?: RegExp;
}

const SHOTS: ReadonlyArray<Shot> = [
  { name: "span-db", hash: "#traces/traces?view=span-db", ready: "span-name" },
  { name: "span-db-logs", hash: "#traces/traces?view=span-db", ready: "span-name", tab: /^Logs/ },
  {
    name: "span-error-events",
    hash: "#traces/traces?view=span-error",
    ready: "span-name",
    tab: /^Events/,
  },
  {
    name: "span-error-links",
    hash: "#traces/traces?view=span-error",
    ready: "span-name",
    tab: /^Links/,
  },
  { name: "span-timeout", hash: "#traces/traces?view=span-timeout", ready: "span-name" },
  { name: "empty", hash: "#traces/empty", ready: "traces-setup-empty" },
  { name: "unavailable", hash: "#traces/unavailable", ready: "traces-setup-unavailable" },
  { name: "user-exported", hash: "#traces/userExported", ready: "traces-setup-user-exported" },
  { name: "loading", hash: "#traces/traces?view=loading", ready: "traces-setup-loading" },
  {
    name: "reconnecting",
    hash: "#traces/traces?view=reconnecting",
    ready: "traces-setup-reconnecting",
  },
  { name: "offline", hash: "#traces/traces?view=offline", ready: "traces-setup-offline" },
  {
    name: "needs-attention",
    hash: "#traces/traces?view=needs-attention",
    ready: "traces-setup-needs-attention",
  },
  {
    name: "unavailable-stored",
    hash: "#traces/unavailableStored?view=span-error",
    ready: "traces-receiver",
  },
  { name: "output", hash: "#preview/traces-output", ready: "traces-output" },
  {
    name: "fixed-exporter",
    hash: "#traces/empty?settings=sightline",
    ready: "traces-fixed-exporter",
  },
  // Fixed exporters detected, but the app exports elsewhere: the elsewhere note, no card (P10-8).
  {
    name: "fixed-exporter-user-exported",
    hash: "#traces/userExported?settings=sightline",
    ready: "traces-setup-user-exported",
  },
  {
    name: "settings-traces",
    hash: "#traces/empty?settings=sightline&page=settings",
    ready: "settings-traces-card",
  },
  {
    name: "settings-traces-fresh",
    hash: "#traces/empty?page=settings",
    ready: "settings-traces-card",
  },
];

const THEMES = [
  { name: "midnight", theme: "dark", darkTheme: "midnight" },
  { name: "light", theme: "light", darkTheme: "midnight" },
] as const;

const DENSITIES = ["calm", "balanced", "compact"] as const;

mkdirSync(out, { recursive: true });

// A short path: the Daemon's Unix socket lives under it.
const home = mkdtempSync("/tmp/t5s-");

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  // A mock Keychain: the screenshots need no secrets, and a background session can't unlock it.
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const appearance = (page: Page, patch: Record<string, string>) =>
  page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: ${JSON.stringify(patch)} })`
  );

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);

  for (const shot of SHOTS.filter((s) => only === null || only.has(s.name))) {
    await page.evaluate(`location.hash = ${JSON.stringify(shot.hash)}; location.reload()`);
    await page.getByTestId(shot.ready).first().waitFor({ timeout: 30_000 });

    if (shot.tab !== undefined) await page.getByRole("tab", { name: shot.tab }).click();

    for (const density of DENSITIES)
      for (const { name, theme, darkTheme } of THEMES) {
        await appearance(page, { theme, darkTheme, density });
        await page
          .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
          .waitFor({ state: "attached" });
        await page.mouse.move(1430, 890);
        await page.waitForTimeout(400);
        const file = `${shot.name}-${name}-${density}.png`;

        await page.screenshot({ path: join(out, file) });
        console.log(`traces-states: ${file}`);
      }
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
