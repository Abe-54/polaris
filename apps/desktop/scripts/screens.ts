#!/usr/bin/env node
/**
 * Screenshots of the shell against Paper's 11U-0 (Workspace bar, dark) and
 * MX-0 (machine bar, light), from real Daemons: four local Daemons on the
 * bench Harness stand in for four machines. Needs a built app.
 *
 *   node scripts/screens.ts <out dir> [--only jump|bars]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Page } from "playwright-core";
import { startDaemon, type TestDaemon } from "./lib/daemon.ts";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { type SeedWorkspace, seedSource } from "./lib/seed.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-screens");

/** `--only jump|bars|states` runs one set. */
const only = process.argv.includes("--only")
  ? (process.argv[process.argv.indexOf("--only") + 1] ?? null)
  : null;

const step = (message: string) => console.log(`screens: ${message}`);

mkdirSync(out, { recursive: true });

const MACHINES = [
  { key: "studio", label: "Mac Studio" },
  { key: "vm", label: "Linux VM" },
  { key: "pi", label: "Raspberry Pi 4" },
] as const;

/** Artboard 5's Workspaces: seven, across four machines. */
const FEW: ReadonlyArray<SeedWorkspace> = [
  {
    hostKey: "studio",
    name: "polaris",
    sessions: [
      { title: "Spike GPUI review screen", state: "needs-you" },
      { title: "Polaris planning", state: "working" },
      { title: "Orchestrator layout prototype", state: "idle" },
    ],
  },
  {
    hostKey: "studio",
    name: "sightline",
    sessions: [{ title: "Tighten the ingest path", state: "idle" }],
  },
  { hostKey: "studio", name: "shellhacks-fiu", sessions: [] },
  {
    hostKey: "vm",
    name: "nj-homes-choice-next",
    sessions: [{ title: "Fix eligibility form validation", state: "needs-you" }],
  },
  {
    hostKey: "vm",
    name: "dcai",
    sessions: [{ title: "Migrate reports to Postgres 17", state: "working" }],
  },
  {
    hostKey: "pi",
    name: "code",
    sessions: [{ title: "Rebuild the sensor dashboard", state: "idle" }],
  },
  { hostKey: "local", name: "~", sessions: [{ title: "Dotfiles cleanup", state: "idle" }] },
];

/** Artboard 2's: 17 Workspaces, so the machine bar takes over. */
const MANY: ReadonlyArray<SeedWorkspace> = [
  ...FEW,
  {
    hostKey: "vm",
    name: "infra",
    sessions: [
      { title: "Flaky export test", state: "idle" },
      { title: "Rollup view benchmarks", state: "working" },
    ],
  },
  ...["api-gateway", "data-pipelines", "docs-site", "billing"].map((name) => ({
    hostKey: "vm",
    name,
    sessions: [{ title: `Tidy ${name}`, state: "idle" as const }],
  })),
  ...["notes", "site", "scratch", "bench", "tools"].map((name) => ({
    hostKey: "local",
    name,
    sessions: [],
  })),
];

interface Rig {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly daemons: ReadonlyArray<TestDaemon>;
  readonly home: string;
}

interface LaunchOptions {
  /** Add a Host whose Daemon never answers (its socket doesn't exist): it needs attention. */
  readonly broken?: boolean;
}

/** Pi 4's link, pretended slow (Paper MX-0 "Slow link"). */
const PI_LATENCY_MS = 380;

const launch = async (theme: "dark" | "light", options: LaunchOptions = {}): Promise<Rig> => {
  const home = mkdtempSync(join(tmpdir(), "polaris-screens-"));

  const daemons = await Promise.all(
    ["local", ...MACHINES.map((m) => m.key)].map((key) =>
      startDaemon({ home: join(home, key), benchHarness: true })
    )
  );

  const [local, ...rest] = daemons;
  const userData = join(home, "user-data");

  const extras: Array<{ key: string; label: string; socket: string; latencyMs?: number }> =
    MACHINES.map((m, i) => ({ ...m, socket: rest[i]?.socketPath ?? "" }));

  for (const extra of extras) if (extra.key === "pi") extra.latencyMs = PI_LATENCY_MS;

  if (options.broken === true) {
    extras.push({ key: "lab", label: "Lab box", socket: join(home, "nowhere.sock") });
  }

  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ theme, welcomeSeen: true }));

  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: local?.socketPath ?? "",
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_LOCAL_LABEL: "MacBook Pro",
      POLARIS_DESKTOP_EXTRA_HOSTS: JSON.stringify(extras),
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: null });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });

  return { app, page, daemons, home };
};

const close = async ({ app, daemons, home }: Rig) => {
  await app.close();
  await Promise.all(daemons.map((d) => d.stop()));
  rmSync(home, { recursive: true, force: true });
};

const shoot = async (page: Page, name: string) => {
  // Park the pointer and focus off the chips, so no hover card covers the shot.
  await page.mouse.move(1300, 860);
  await page.evaluate(
    "document.activeElement instanceof HTMLElement && document.activeElement.blur()"
  );
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, `${name}.png`) });
  step(`saved ${name}.png`);
};

const density = async (page: Page, value: "calm" | "balanced" | "compact") => {
  await page.evaluate(`window.polaris.request("settings.setDensity", { density: "${value}" })`);
  await page.locator(`html[data-density="${value}"]`).waitFor({ state: "attached" });
};

// 11U-0: the Workspace bar, dark, polaris selected with Polaris planning working.
if (only === null || only === "bars") {
  const rig = await launch("dark");

  await rig.page.evaluate(seedSource(FEW));
  await rig.page.locator('[data-slot="chip"]', { hasText: "polaris" }).first().click();
  await rig.page.getByText("Polaris planning", { exact: true }).first().click();
  await shoot(rig.page, "11U-0-workspace-bar-dark-calm");
  await density(rig.page, "balanced");
  await shoot(rig.page, "11U-0-workspace-bar-dark-balanced");
  await density(rig.page, "compact");
  await shoot(rig.page, "11U-0-workspace-bar-dark-compact");
  await density(rig.page, "calm");
  await rig.page.evaluate(`window.polaris.request("settings.setTheme", { theme: "light" })`);
  await shoot(rig.page, "11U-0-workspace-bar-light-calm");
  await close(rig);
}

// AR-0: the K jump menu over artboard 5: open with no query (Recent, Needs you, Actions),
// typed "po", "working", and a query that matches nothing; then help.
if (only === null || only === "jump") {
  const rig = await launch("dark");

  await rig.page.evaluate(seedSource(FEW));
  await rig.page.locator('[data-slot="chip"]', { hasText: "polaris" }).first().click();
  await rig.page.getByText("Polaris planning", { exact: true }).first().click();
  await rig.page.getByText("Orchestrator layout prototype", { exact: true }).first().click();
  await rig.page.getByText("Polaris planning", { exact: true }).first().click();
  await rig.page.keyboard.press("Meta+K");
  await rig.page.getByRole("combobox").waitFor();
  await shoot(rig.page, "AR-0-jump-open-dark");
  await rig.page.getByRole("combobox").pressSequentially("po", { delay: 30 });
  await shoot(rig.page, "AR-0-jump-po-dark");
  await rig.page.getByRole("combobox").fill("working");
  await shoot(rig.page, "AR-0-jump-working-dark");
  await rig.page.getByRole("combobox").fill("zzqx nothing here");
  await shoot(rig.page, "AR-0-jump-no-match-dark");
  await rig.page.keyboard.press("Escape");
  await rig.page.evaluate(`window.polaris.request("settings.setTheme", { theme: "light" })`);
  await rig.page.keyboard.press("Meta+K");
  await rig.page.getByRole("combobox").pressSequentially("po", { delay: 30 });
  await shoot(rig.page, "AR-0-jump-po-light");
  await rig.page.keyboard.press("Escape");
  await rig.page.keyboard.press("Meta+Slash");
  await shoot(rig.page, "shortcut-help-light");
  await close(rig);
}

// MX-0: the machine bar, light, Linux VM selected; then a machine going away.
if (only === null || only === "bars") {
  const rig = await launch("light");

  await rig.page.evaluate(seedSource(MANY));
  await rig.page.locator('nav[aria-label="Machines"]').waitFor({ timeout: 20_000 });
  await rig.page.locator('[data-host="vm"]').click();
  await rig.page.getByText("Migrate reports to Postgres 17", { exact: true }).first().click();
  await shoot(rig.page, "MX-0-machine-bar-light-calm");
  await rig.page.evaluate(`window.polaris.request("settings.setTheme", { theme: "dark" })`);
  await shoot(rig.page, "MX-0-machine-bar-dark-calm");
  await rig.daemons[3]?.stop();
  await rig.page.locator('[data-host="pi"]').click();
  await rig.page
    .locator('[data-host="pi"][data-connection="reconnecting"]')
    .waitFor({ timeout: 20_000 });
  await shoot(rig.page, "host-reconnecting-dark");
  await close(rig);
}

// 5PM-1: Host states in the Workspace bar: reconnecting (chips dimmed), needs attention, and
// the sidebar's note in words; then the attention Host opened.
if (only === null || only === "states") {
  const rig = await launch("dark", { broken: true });

  await rig.page.evaluate(seedSource(FEW));
  await rig.page.locator('[data-slot="chip"]', { hasText: "polaris" }).first().click();
  await rig.page
    .locator('[data-host="lab"][data-connection="needs-attention"]')
    .waitFor({ timeout: 20_000 });
  await rig.daemons[2]?.stop();
  await rig.page
    .locator('[data-host="vm"][data-connection="reconnecting"]')
    .waitFor({ timeout: 20_000 });
  await rig.page.waitForTimeout(3000);
  await shoot(rig.page, "5PM-1-workspace-bar-states-dark");
  await rig.page.locator('[data-host="vm"]').click();
  await shoot(rig.page, "5PM-1-reconnecting-sidebar-dark");
  await rig.page.getByTestId("connection-lab").click();
  await shoot(rig.page, "5PM-1-needs-attention-sidebar-dark");
  await rig.page.evaluate(`window.polaris.request("settings.setTheme", { theme: "light" })`);
  await shoot(rig.page, "5PM-1-needs-attention-sidebar-light");
  await close(rig);
}
