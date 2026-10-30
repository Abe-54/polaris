#!/usr/bin/env node
/**
 * Settings → Hosts on fixtures (`#hosts/<scene>`): the host list (HS-D2) and Mac Studio's
 * host page (HS-D) in both themes and every density, each card on its own, every daemon
 * update state on its host's page, and a checked walk through Upgrade on `#hosts/live`.
 * Nothing is installed.
 *
 *   node scripts/hostsScreens.ts --out <dir> [--build]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { _electron as electron, type Page } from "playwright-core";
import { APP_DIR, electronBinary } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";
import { startDaemon } from "./lib/daemon.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

// A short path: the Daemon's Unix socket lives under it.
const home = mkdtempSync("/tmp/pgh-");

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_LOCAL_LABEL: "MacBook Pro",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

/** A look: `dark` is Moonlit, `midnight` Midnight's dark, `light` light. */
const appearance = async (page: Page, look: string, density: string) => {
  const theme = look === "light" ? "light" : "dark";
  const darkTheme = look === "midnight" ? "midnight" : "moonlit";

  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: ${JSON.stringify({ theme, darkTheme, density })} })`
  );
  await page
    .locator(
      `html[data-theme="${theme}"][data-density="${density}"]${theme === "dark" ? `[data-theme-dark="${darkTheme}"]` : ""}`
    )
    .waitFor({ state: "attached" });
  await page.waitForTimeout(400);
};

const open = async (page: Page, scene: string) => {
  await page.evaluate(`location.hash = "#hosts/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("hosts-settings").waitFor();
};

/** Opens a host's page from its list row; esc goes back to the list. */
const host = async (page: Page, key: string) => {
  await page.getByTestId(`machine-${key}`).getByRole("button").click();
  await page.getByTestId("host-page").waitFor();
};

const back = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page.getByTestId("hosts-settings").waitFor();
};

const shot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path });
  console.log(`screens: ${path}`);
};

const card = async (page: Page, testId: string, name: string) => {
  const path = join(out, `${name}.png`);
  const element = page.getByTestId(testId);

  await element.scrollIntoViewIfNeeded();
  await element.screenshot({ path });
  console.log(`screens: ${path}`);
};

const expectText = async (page: Page, text: string) => {
  await page.getByText(text).first().waitFor({ timeout: 10_000 });
  console.log(`hosts: saw "${text}"`);
};

const THEMES = ["dark", "midnight", "light"];

const DENSITIES = ["calm", "balanced", "compact"];

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });

  for (const density of DENSITIES)
    for (const theme of THEMES) {
      await open(page, "states");
      await appearance(page, theme, density);
      await shot(page, `list-${theme}-${density}`);
      await host(page, "studio");
      await expectText(page, "Polaris Relay");
      await shot(page, `host-${theme}-${density}`);
      await page.getByTestId("harness-claude").waitFor();
      await card(page, "harnesses-card", `harnesses-${theme}-${density}`);
      await card(page, "capacity-card", `capacity-${theme}-${density}`);
      await card(page, "remote-access-card", `remote-access-${theme}-${density}`);
    }

  // Every Harness name in full and clear of its neighbours, at the narrowest density.
  const names = page
    .getByTestId("harnesses-card")
    .locator('[data-testid^="harness-"] > span:nth-child(2)');

  const clash = String(
    await page.evaluate(`(() => {
      const spans = [...document.querySelectorAll('[data-testid^="harness-"] > span:nth-child(2)')];
      const cut = spans.find((el) => el.scrollWidth > el.clientWidth);
      if (cut) return cut.textContent + " is cut off";
      const rects = spans.map((el) => el.getBoundingClientRect());
      const i = rects.findIndex((r, j) => j > 0 && r.top === rects[j - 1].top && r.left < rects[j - 1].right);
      return i === -1 ? "" : spans[i - 1].textContent + " runs into " + spans[i].textContent;
    })()`)
  );

  if (clash !== "") throw new Error(`the Harnesses card: ${clash}`);
  console.log(`hosts: harness names in full: ${(await names.allTextContents()).join(", ")}`);

  // Resources… opens the resources alone: Workers at once stays Capacity's one stepper.
  await page.getByRole("button", { name: "Resources…" }).click();
  await page.getByTestId("resources-card").waitFor();

  const steppers = await page
    .getByRole("button", { name: /more workers|increase workers/i })
    .count();

  if (steppers !== 1) throw new Error(`${steppers} Workers at once steppers on the host page`);
  await card(page, "resources-card", "resources-light-compact");

  // Tailscale turns on and says where extensions connect; the relay's address is the footer.
  await appearance(page, "dark", "calm");
  const remote = page.getByTestId("remote-access-card");

  await expectText(page, "wss://relay.lux.dev/v1");
  await remote.getByRole("switch", { name: "Tailscale" }).click();
  await expectText(page, "Extensions connect to wss://studio.tail1234.ts.net/polaris/rpc");
  await card(page, "remote-access-card", "remote-access-tailscale-on-dark-calm");

  // This Mac first; every update state in words, each on its host's page.
  await open(page, "all");

  const keys = String(
    await page.evaluate(
      `[...document.querySelectorAll('[data-testid^="machine-"]')].map((row) => row.dataset.testid.slice(8)).join(" ")`
    )
  ).split(" ");

  if (keys[0] !== "local") throw new Error(`This Mac isn't first: ${keys[0]}`);
  const seen: Array<string> = [];

  for (const key of keys) {
    await host(page, key);
    seen.push(...(await page.getByTestId("daemon-update").allTextContents()));
    await back(page);
  }

  for (const text of [
    "0.5.0 available · upgrades its daemon only when you ask",
    "Copying polaris 0.5.0 · 7.3 of 18.6 MB",
    "Switching to 0.5.0; agent sessions keep going",
    "Checking NUC",
    "Upgrades to 0.5.0 when it connects",
    "Upgraded to 0.5.0 · 3m ago",
  ]) {
    if (!seen.some((line) => line.includes(text))) throw new Error(`no host page said "${text}"`);
    console.log(`hosts: saw "${text}"`);
  }

  // The host page's own upgrade choice, and a host that keeps its own choice says so.
  await host(page, "studio");
  await expectText(page, "Daemon upgrades");
  await card(page, "daemon-card", "daemon-dark-calm");
  await open(page, "current");
  await host(page, "studio");
  await expectText(page, "Keeps its daemon up to date on its own");

  // Upgrade walks through checking, copying and switching to done; the switch turns off.
  await open(page, "live");
  await appearance(page, "light", "calm");
  await host(page, "studio");
  await page.getByRole("button", { name: "Upgrade" }).click();
  await expectText(page, "Checking Mac Studio");
  await page.getByRole("progressbar").waitFor();
  await shot(page, "live-uploading-light");
  await expectText(page, "Switching to 0.5.0");
  await expectText(page, "Upgraded to 0.5.0");
  await shot(page, "live-done-light");
  await back(page);
  await page.getByRole("switch", { name: "Keep daemons up to date" }).click();
  await page
    .locator('[data-testid="keep-daemons-up-to-date"] [role="switch"][data-state="unchecked"]')
    .waitFor();

  // The list's sparklines advance with each sample, and freeze on their last frame under Reduce Motion.
  await open(page, "states");
  await appearance(page, "dark", "calm");

  const sparklines = async () =>
    Promise.all((await page.getByTestId("sparkline").all()).map((line) => line.screenshot()));

  for (const motion of ["full", "reduce"]) {
    await page.evaluate(
      `window.polaris.request("settings.setAppearance", { patch: { motion: "${motion}" } })`
    );
    await page.waitForTimeout(500);
    const before = await sparklines();

    await page.waitForTimeout(3_000);
    const after = await sparklines();
    const moved = before.some((frame, i) => !frame.equals(after[i] ?? Buffer.alloc(0)));

    if (moved !== (motion === "full"))
      throw new Error(`the sparklines ${moved ? "moved" : "stood still"} with motion ${motion}`);
    console.log(`hosts: sparklines ${moved ? "advance" : "are still"} with motion ${motion}`);
  }

  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { motion: "system" } })`
  );

  // The blurb is one line, and the list names the local Host "This Mac" with its own name below.
  await open(page, "states");

  const lines = Number(
    await page.evaluate(`(() => {
      const el = document.querySelector('[data-testid="hosts-settings"] p');
      return Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
    })()`)
  );

  if (lines !== 1) throw new Error(`the Hosts blurb wraps to ${lines} lines`);
  await expectText(page, "MacBook Pro · macOS arm64");
  await host(page, "local");
  await card(page, "daemon-card", "daemon-this-mac-dark-calm");

  const cut = await page.evaluate(
    `[...document.querySelectorAll('[data-testid="prediction-placement"] *')].some((el) => el.scrollWidth > el.clientWidth)`
  );

  if (cut) throw new Error("Run tab completion on is cut off");

  // The real This Mac, on the Daemon this script started: its sparkline advances within 3 s.
  await page.evaluate(`location.hash = ""; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings.open")?.click();
  });
  await page.getByTestId("settings").getByRole("button", { name: "Hosts", exact: true }).click();
  const real = page.getByTestId("machine-local").getByTestId("sparkline");
  const bars = async () => (await real.getAttribute("data-bars")) ?? "";
  const opened = await bars();

  await page.waitForTimeout(3_000);

  if ((await bars()) === opened) throw new Error("the real This Mac sparkline stood still for 3 s");
  console.log("hosts: the real This Mac sparkline advances");
  await shot(page, "list-real-dark");
  console.log("hosts: ok");
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
