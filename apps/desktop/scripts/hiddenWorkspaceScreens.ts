#!/usr/bin/env node
/**
 * Screenshots of hiding a Workspace (docs/adr/0037) from real Daemons: two local Daemons
 * on the bench Harness stand in for this Mac and a Mac Studio. The chip's menu, the toast,
 * a hidden chip that needs you, the Host's menu, the palette, the jump menu and the machine bar.
 *
 *   node scripts/hiddenWorkspaceScreens.ts <out dir> [--build]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Page } from "playwright-core";
import { startDaemon, type TestDaemon } from "./lib/daemon.ts";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { type SeedWorkspace, seedSource } from "./lib/seed.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-hidden-workspaces");

if (process.argv.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const step = (message: string) => console.log(`hidden: ${message}`);

mkdirSync(out, { recursive: true });

const LONG = "customer-onboarding-experiments-with-a-very-long-workspace-name";

const FEW: ReadonlyArray<SeedWorkspace> = [
  {
    hostKey: "studio",
    name: "polaris",
    sessions: [{ title: "Polaris planning", state: "working" }],
  },
  { hostKey: "studio", name: "sightline", sessions: [] },
  {
    hostKey: "studio",
    name: "nj-homes-choice-next",
    sessions: [{ title: "Fix eligibility form validation", state: "needs-you" }],
  },
  { hostKey: "studio", name: LONG, sessions: [] },
  { hostKey: "local", name: "dotfiles", sessions: [] },
];

const MANY: ReadonlyArray<SeedWorkspace> = [
  ...FEW,
  ...["api-gateway", "data-pipelines", "docs-site", "billing", "infra", "notes", "bench"].map(
    (name) => ({ hostKey: "studio", name, sessions: [] })
  ),
];

interface Rig {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly daemons: ReadonlyArray<TestDaemon>;
  readonly home: string;
}

const launch = async (theme: "dark" | "light"): Promise<Rig> => {
  const home = mkdtempSync(join(tmpdir(), "polaris-hidden-"));

  const daemons = await Promise.all(
    ["local", "studio"].map((key) => startDaemon({ home: join(home, key), benchHarness: true }))
  );

  const userData = join(home, "user-data");

  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ theme, welcomeSeen: true }));

  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemons[0]?.socketPath ?? "",
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_LOCAL_LABEL: "MacBook Pro",
      POLARIS_DESKTOP_EXTRA_HOSTS: JSON.stringify([
        { key: "studio", label: "Mac Studio", socket: daemons[1]?.socketPath ?? "" },
      ]),
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
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

const shoot = async (page: Page, name: string, park = true) => {
  if (park) await page.mouse.move(1300, 860);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${name}.png`) });
  step(`saved ${name}.png`);
};

const density = async (page: Page, value: "calm" | "balanced" | "compact") => {
  await page.evaluate(`window.polaris.request("settings.setDensity", { density: "${value}" })`);
  await page.locator(`html[data-density="${value}"]`).waitFor({ state: "attached" });
};

const chip = (page: Page, name: string) =>
  page.locator('nav[aria-label="Workspaces"] [data-slot="chip"]', { hasText: name }).first();

const escape = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
};

const menuOn = async (page: Page, name: string) => {
  await chip(page, name).click({ button: "right" });
  await page.getByTestId("workspace-context-menu").waitFor();
};

const hideVia = async (page: Page, name: string) => {
  await menuOn(page, name);
  await page.getByTestId("workspace-hide").click();
};

/** The Workspace bar: the menu, hiding, the hidden chip that needs you, the Host's menu. */
const bar = async (look: "dark" | "light") => {
  const rig = await launch(look);
  const { page } = rig;

  await page.evaluate(seedSource(FEW));
  await chip(page, "nj-homes-choice-next").locator('[data-slot="badge"]').waitFor({
    timeout: 30_000,
  });
  await chip(page, "polaris").click();

  for (const d of ["calm", "balanced", "compact"] as const) {
    await density(page, d);
    await menuOn(page, LONG);
    await shoot(page, `1-chip-menu-${look}-${d}`, false);
    await escape(page);
  }

  await density(page, "calm");
  await hideVia(page, LONG);
  await page.locator('[data-slot="toast"]').waitFor();
  await shoot(page, `2-hidden-toast-${look}`);

  await hideVia(page, "nj-homes-choice-next");
  await chip(page, "nj-homes-choice-next").locator("text=hidden").waitFor();
  await shoot(page, `3-hidden-needs-you-${look}`);

  await page.locator('[data-host="studio"]').first().click({ button: "right" });
  await page.getByTestId("host-hidden-workspaces").hover();
  await page.getByTestId("host-show-workspace").first().waitFor();
  await shoot(page, `4-host-menu-${look}`, false);
  await escape(page);
  await escape(page);

  await page.keyboard.press("Meta+Shift+P");
  await page.getByTestId("command-palette").waitFor();
  await page.keyboard.type("hidden", { delay: 20 });
  await shoot(page, `5-palette-hidden-${look}`);
  await page.getByText("Show hidden workspaces…", { exact: true }).click();
  await shoot(page, `6-palette-show-${look}`);
  await escape(page);

  await page.keyboard.press("Meta+K");
  await page.getByRole("combobox").waitFor();
  await page.getByRole("combobox").pressSequentially("customer", { delay: 20 });
  await shoot(page, `7-jump-hidden-${look}`);
  await page.keyboard.press("Enter");
  await chip(page, LONG).waitFor();

  for (const d of ["calm", "balanced", "compact"] as const) {
    await density(page, d);
    await shoot(page, `8-hidden-open-${look}-${d}`);
  }

  await close(rig);
};

/** The machine bar: hiding from a machine's sidebar group. */
const machines = async (look: "dark" | "light") => {
  const rig = await launch(look);
  const { page } = rig;

  await page.evaluate(seedSource(MANY));
  await page.locator('nav[aria-label="Machines"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-host="studio"]').first().click();

  const group = page.locator("aside button[aria-expanded]", { hasText: "sightline" }).first();

  await group.click({ button: "right" });
  await page.getByTestId("workspace-context-menu").waitFor();
  await shoot(page, `9-machine-group-menu-${look}`, false);
  await page.getByTestId("workspace-hide").click();
  await page.locator('[data-slot="toast"]').waitFor();
  await shoot(page, `10-machine-hidden-${look}`);
  await close(rig);
};

for (const look of ["dark", "light"] as const) await bar(look);

for (const look of ["dark", "light"] as const) await machines(look);
