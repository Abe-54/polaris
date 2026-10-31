#!/usr/bin/env node
/**
 * Screenshots of Settings → Hosts against Paper S4 / O3 / O4, both themes:
 * this Mac, a fake remote Host awaiting install approval (then installed),
 * `localhost` over the real ssh (host key not trusted here), and an
 * unreachable alias (reconnecting). Also the add-a-host form. Opens the
 * page the way a new user does, from the first-run card's "Browse hosts".
 * Then Hosts failing with host-key-changed, auth-failed and daemon-not-running
 * (lib/failingHosts.ts), each card and the Orchestrator's view of one.
 *
 *   node scripts/machineScreens.ts <dir> [--build]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { FAILING_HOSTS, writeFailingSsh } from "./lib/failingHosts.ts";
import { FAKE_ALIAS, prepareFakeHost } from "./lib/machineFlow.ts";

const dir = process.argv[2];

if (dir === undefined) throw new Error("usage: node scripts/machineScreens.ts <dir> [--build]");

if (process.argv.includes("--build")) {
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });
}

const home = mkdtempSync(join(tmpdir(), "polaris-screens-"));

const userData = join(home, "user-data");

const daemon = await startDaemon({ home, benchHarness: true });

const fake = prepareFakeHost(join(home, "remote"));

const failing = join(home, "failing");

writeFailingSsh(failing, join(home, "remote", "bin", "ssh"));

mkdirSync(userData, { recursive: true });

mkdirSync(dir, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    welcomeSeen: true,
    hosts: [
      { alias: FAKE_ALIAS, label: "Mac Studio" },
      { alias: "localhost", label: "Raspberry Pi 4" },
      { alias: "polaris-screens.invalid", label: "Linux VM" },
    ],
  })
);

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    ...fake.env,
    PATH: `${failing}:${fake.env.PATH ?? ""}`,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_LOCAL_LABEL: "MacBook Pro",
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const setTheme = async (page: Page, theme: "dark" | "light") => {
  await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${theme}" })`);
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

const shoot = async (page: Page, name: string) => {
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    const path = join(dir, `${name}-${theme}.png`);

    await page.screenshot({ path });
    console.log(`screens: ${path}`);
  }
};

/** Settings → Hosts: the sidebar's Settings button (as ⌘, does), then Hosts in the nav. */
/** The first-run card's "Connect a host → Browse hosts": Settings → Hosts with the add form open. */
const openHosts = async (page: Page) => {
  await page.getByRole("button", { name: "Browse hosts" }).click();
  await page.getByTestId("hosts-settings").waitFor({ timeout: 10_000 });
  await page.getByTestId("add-machine").waitFor({ timeout: 10_000 });
  await page.getByTestId("add-machine").getByRole("button", { name: "Cancel" }).click();
};

/** Each needs-attention card (O4), then the Orchestrator with a failing Host selected. */
const failingHosts = async (page: Page) => {
  for (const host of FAILING_HOSTS) {
    await page.evaluate(
      `window.polaris.request("machines.add", ${JSON.stringify({
        alias: host.alias,
        label: host.label,
        colour: null,
        forwardAgent: false,
      })})`
    );
  }

  for (const host of FAILING_HOSTS) {
    const row = page.getByTestId(`machine-${host.alias}`);

    await page
      .locator(`[data-testid="machine-${host.alias}"][data-state="needs-attention"]`)
      .waitFor({ timeout: 30_000 });
    await row.scrollIntoViewIfNeeded();

    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      const path = join(dir, `attention-${host.reason}-${theme}.png`);

      await row.screenshot({ path });
      console.log(`screens: ${path}`);
    }
  }

  await page.keyboard.press("Escape");
  await page.locator('[data-host="fail-auth"]').first().click();
  await page.waitForTimeout(800);
  await shoot(page, "orchestrator-needs-attention");
};

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page.emulateMedia({ colorScheme: null });
  await openHosts(page);
  await page.getByTestId("install-approval").waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="machine-localhost"][data-state="needs-attention"]').waitFor({
    timeout: 30_000,
  });
  await shoot(page, "hosts-attention");

  for (const density of ["balanced", "compact"] as const) {
    await page.evaluate(`window.polaris.request("settings.setDensity", { density: "${density}" })`);
    await page.locator(`html[data-density="${density}"]`).waitFor({ state: "attached" });
    await shoot(page, `hosts-attention-${density}`);
  }

  await page.evaluate(`window.polaris.request("settings.setDensity", { density: "calm" })`);

  // Trusting a host key: `ssh localhost` in a terminal on this Mac's local Host (left unanswered).
  await page
    .getByTestId("machine-localhost")
    .getByRole("button", { name: "Open in Terminal" })
    .click();
  // xterm draws on a canvas: wait for its surface, then for ssh's prompt to be drawn.
  await page.getByTestId("machine-localhost").locator(".xterm").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.getByTestId("machine-localhost").scrollIntoViewIfNeeded();
  await shoot(page, "ssh-terminal");

  await page.getByTestId("install-approval").scrollIntoViewIfNeeded();
  await shoot(page, "approve-install");
  await page.getByRole("button", { name: "Approve and install" }).click();
  await page
    .locator(`[data-testid="machine-${FAKE_ALIAS}"][data-state="connected"]`)
    .waitFor({ timeout: 60_000 });
  await page.getByTestId("install-outcome").waitFor({ timeout: 10_000 });
  await shoot(page, "installed");

  await page.getByRole("button", { name: "Add a host" }).click();
  await page.getByTestId("add-machine").scrollIntoViewIfNeeded();
  await shoot(page, "add-host");
  await page.getByTestId("add-machine").getByRole("button", { name: "Cancel" }).click();
  await failingHosts(page);
} catch (error) {
  await app.windows()[0]?.screenshot({ path: join(tmpdir(), "polaris-screens-failure.png") });
  throw error;
} finally {
  await app.close();
  await daemon.stop();
  fake.stop();
  rmSync(home, { recursive: true, force: true });
}
