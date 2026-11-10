#!/usr/bin/env node
/**
 * The Simulator in Output (ENG-829) against a real Daemon on this Mac: the tab, the picker,
 * booting, starting, live, the toolbar, restarting, the rail row and the narrow panel, in dark
 * and light. Creates throwaway iOS Simulators and deletes them. Needs a built app and Xcode.
 *
 *   node scripts/simulatorScreens.ts <out dir>
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { seedSource } from "./lib/seed.ts";

const out = process.argv[2] ?? "/tmp/polaris-simulator-screens";

mkdirSync(out, { recursive: true });

const simctl = (...args: ReadonlyArray<string>) =>
  execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 300_000 }).trim();

const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";

const LONG_NAME = "Polaris U2 iPhone 17 Pro Max for the checkout redesign review (throwaway)";

/** Throwaway Simulators: one to stream, one with a long name, and a crowd for the picker. */
const created = [
  simctl(
    "create",
    "Polaris U2 iPhone",
    "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    RUNTIME
  ),
  simctl("create", LONG_NAME, "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max", RUNTIME),
];

const [streamed = ""] = created;

// A short path: the Daemon's Unix socket lives under it.
const home = mkdtempSync("/tmp/pu2-");

const daemon = await startDaemon({ home: join(home, "d"), benchHarness: true });

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", welcomeSeen: true })
);

const launch = () =>
  electron.launch({
    executablePath: electronBinary(),
    args: ["--use-mock-keychain", APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

const shoot = async (page: Page, name: string) => {
  await page.mouse.move(10, 880);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`simulator-screens: saved ${name}.png`);
};

const theme = (page: Page, value: "dark" | "light") =>
  page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${value}" } })`
  );

const bothThemes = async (page: Page, name: string) => {
  for (const value of ["dark", "light"] as const) {
    await theme(page, value);
    await shoot(page, `${name}-${value}`);
  }

  await theme(page, "dark");
};

const pick = async (page: Page, name: string) => {
  await page.getByTestId("simulator-picker").click();
  await page.getByTestId("simulator-picker-row").filter({ hasText: name }).first().click();
};

const app = await launch();

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 30_000 });
  await page.evaluate(
    seedSource([
      { hostKey: "local", name: "acme", sessions: [{ title: "Checkout flow", state: "idle" }] },
    ])
  );
  await page.locator('[data-slot="chip"]', { hasText: "acme" }).first().click();
  await page.getByText("Checkout flow", { exact: true }).first().click();
  await page.getByTestId("output-panel").or(page.getByTestId("output-rail")).first().waitFor();

  // The rail lists the Simulator on a Mac.
  if (await page.getByTestId("output-rail").isVisible()) {
    await page.getByTestId("output-rail-simulator").waitFor({ timeout: 20_000 });
    await shoot(page, "rail");
    await page.getByTestId("output-rail-simulator").click();
  } else {
    await page.getByTestId("output-tab-simulator").click({ timeout: 20_000 });
  }

  await page.getByTestId("simulator").waitFor({ timeout: 10_000 });
  await page.getByTestId("simulator-picker").waitFor({ timeout: 20_000 });
  await shoot(page, "first-open");

  await page.getByTestId("simulator-picker").click();
  await page.getByTestId("simulator-picker-row").first().waitFor();
  await bothThemes(page, "picker");
  await page.keyboard.press("Escape");

  await pick(page, "Polaris U2 iPhone");
  await page
    .getByText("Booting Polaris U2 iPhone")
    .or(page.getByText("Starting Simulators on"))
    .first()
    .waitFor({ timeout: 60_000 });
  await shoot(page, "booting-or-starting");
  await page
    .getByText("Starting Simulators on Mac Studio")
    .waitFor({ timeout: 120_000 })
    .catch(() => undefined);
  await shoot(page, "starting");
  await page.locator('[data-testid="simulator-live"] canvas').waitFor({ timeout: 180_000 });
  await page.getByTestId("simulator-bezel").waitFor({ state: "detached", timeout: 180_000 });
  await page.waitForTimeout(3000);
  await bothThemes(page, "live");

  // The toolbar: home, rotate (back to portrait), screenshot into the composer.
  await page.getByRole("button", { name: "Home" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Rotate left" }).click();
  await page.waitForTimeout(2500);
  await shoot(page, "rotated");

  for (let i = 0; i < 3; i += 1) {
    await page.getByRole("button", { name: "Rotate left" }).click();
    await page.waitForTimeout(1500);
  }

  // iOS has no Lock: serve-sim's lock does nothing on iOS 27 (ENG-851).
  assert.equal(await page.getByRole("button", { name: "Lock" }).count(), 0);
  await page.getByTestId("simulator-screenshot").click();
  await page.waitForTimeout(3000);
  await shoot(page, "screenshot-attached");

  // Restart: the last frame dims under "Reconnecting to …" until the hub is back.
  await page.getByTestId("simulator-restart").click();
  await page.getByTestId("simulator-reconnecting").waitFor({ timeout: 10_000 });
  await shoot(page, "restarting");
  await page.getByTestId("simulator-reconnecting").waitFor({ state: "detached", timeout: 120_000 });
  await page.waitForTimeout(2000);
  await shoot(page, "after-restart");

  // Narrow Output (360).
  await page.getByTestId("output-resize").focus();

  for (let i = 0; i < 60; i += 1) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1500);
  await shoot(page, "narrow");
  await page.getByTestId("output-resize").dblclick();
  await page.waitForTimeout(1000);

  // The long name in the picker and the toolbar.
  await pick(page, LONG_NAME);
  await page.waitForTimeout(1500);
  await shoot(page, "long-name");
  await page.getByTestId("simulator-picker").click();
  await shoot(page, "long-name-picker");
  await page.keyboard.press("Escape");

  // Shut down the streamed one from the picker.
  await pick(page, "Polaris U2 iPhone");
  await page.waitForTimeout(1000);
  await page.getByTestId("simulator-picker").click();
  await page.getByRole("menuitem", { name: "Shut down Polaris U2 iPhone" }).click();
  await page.getByText("Polaris U2 iPhone is shut down").waitFor({ timeout: 120_000 });
  await bothThemes(page, "shut-down");

  // Hiding Output detaches: the panel closes to the rail.
  await page.getByRole("button", { name: "Hide output" }).click();
  await page.getByTestId("output-rail").waitFor();
  await shoot(page, "rail-after");
  assert.ok(true);
} finally {
  await app.close().catch(() => undefined);
  await daemon.stop();

  for (const id of created) {
    try {
      simctl("shutdown", id);
    } catch {
      // Already shut down.
    }

    simctl("delete", id);
  }

  rmSync(home, { recursive: true, force: true });
  console.log(`simulator-screens: deleted ${created.length} throwaway Simulators (${streamed})`);
}
