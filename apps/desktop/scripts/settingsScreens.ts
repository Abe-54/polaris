#!/usr/bin/env node
/**
 * Screenshots of Settings against Paper X-J (Appearance and Usage) and the restyled pages, in
 * Moonlit, Midnight and light, with four local Daemons standing in for four machines. Needs a
 * built app.
 *
 *   node scripts/settingsScreens.ts <out dir>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _electron as electron, type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { APP_DIR, electronBinary, sizeWindow } from "./lib/electron.ts";
import { PAIR, settingsChecks, stubDevices } from "./lib/settingsChecks.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-settings-screens");

/** `--only sessions,about`: just those pages (and `checks` for the motion and keyboard checks). */
const only = process.argv.includes("--only")
  ? (process.argv[process.argv.indexOf("--only") + 1] ?? "").split(",")
  : null;

const wanted = (slug: string) => only === null || only.includes(slug);

mkdirSync(out, { recursive: true });

const MACHINES = [
  { key: "studio", label: "Mac Studio" },
  { key: "vm", label: "Linux VM" },
  { key: "pi", label: "Raspberry Pi 4" },
] as const;

// A short path: the Daemons' Unix sockets live under it.
const home = mkdtempSync("/tmp/pgs-");

/**
 * The Pi runs a real probe against a fake Claude Code 2.1.272 (what the real Pi ran): usable
 * but older than tested, so S1 shows the quiet note. Nothing else is on its PATH.
 */
const olderClaude = (root: string) => {
  const bin = join(root, "bin");
  const userHome = join(root, "user");
  mkdirSync(bin, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  writeFileSync(join(userHome, ".claude.json"), "{}");
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\ncase "$1" in --version) echo "2.1.272 (Claude Code)";; *) echo '{"loggedIn":true}';; esac\n`,
    { mode: 0o755 }
  );

  return {
    userHome,
    // Bun's own directory too: `spawn` finds the Daemon's `bun` through this PATH.
    env: {
      PATH: `${bin}:${dirname(execFileSync("which", ["bun"]).toString().trim())}:/usr/bin:/bin`,
      POLARIS_USER_PATH: "off",
    },
  };
};

/**
 * S2's figures: the Studio's HOME holds 30 days of Claude Code transcript lines on two Models
 * (`projects/**\/*.jsonl`, the shape its Usage index reads), so Usage isn't empty.
 */
const claudeLogs = (root: string) => {
  const dir = join(root, ".claude", "projects", "-Users-demo-polaris");
  const day = 86_400_000;
  const now = Date.now();

  mkdirSync(dir, { recursive: true });

  const lines = Array.from({ length: 30 }, (_, d) =>
    [0, 1, 2].map((i) => {
      const n = ((d * 7 + i * 3) % 11) + 2;
      const model = i === 2 ? "claude-sonnet-5" : "claude-opus-5";

      return JSON.stringify({
        type: "assistant",
        sessionId: `demo-${d}`,
        timestamp: new Date(now - (29 - d) * day - i * 3_600_000).toISOString(),
        version: "2.1.284",
        requestId: `req_${d}_${i}`,
        message: {
          id: `msg_${d}_${i}`,
          model,
          role: "assistant",
          content: [{ type: "text", text: "demo" }],
          usage: {
            input_tokens: n * 1_000,
            output_tokens: n * 4_000,
            cache_read_input_tokens: n * 90_000,
            cache_creation_input_tokens: n * 6_000,
          },
        },
      });
    })
  ).flat();

  writeFileSync(join(dir, "demo.jsonl"), `${lines.join("\n")}\n`);

  return root;
};

const startHost = (key: string) => {
  if (key === "pi") {
    return startDaemon({
      home: join(home, key),
      benchHarness: false,
      ...olderClaude(join(home, "pi-host")),
    });
  }

  if (key === "studio") {
    return startDaemon({
      home: join(home, key),
      benchHarness: true,
      userHome: claudeLogs(join(home, "studio-user")),
    });
  }

  return startDaemon({ home: join(home, key), benchHarness: true });
};

const daemons = await Promise.all(["local", ...MACHINES.map((m) => m.key)].map(startHost));

const [local, ...rest] = daemons;

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", welcomeSeen: true })
);

const app = await electron.launch({
  executablePath: electronBinary(),
  // A mock Keychain: the screenshots need no secrets, and a background session can't unlock it.
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: local?.socketPath ?? "",
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_LOCAL_LABEL: "MacBook Pro",
    POLARIS_DESKTOP_EXTRA_HOSTS: JSON.stringify(
      MACHINES.map((m, i) => ({ ...m, socket: rest[i]?.socketPath ?? "" }))
    ),
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const setAppearance = async (page: Page, patch: Readonly<Record<string, string>>) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: ${JSON.stringify(patch)} })`
  );
  await page.waitForTimeout(400);
};

/** The chart's tooltip: hover the busiest day, then the keyboard (focus, ←), both themes. */
const usageTooltip = async (page: Page) => {
  const chart = page.getByTestId("usage-chart");
  const box = await chart.boundingBox();

  if (box === null) throw new Error("no usage chart");
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
  await page.getByTestId("usage-tooltip").waitFor({ timeout: 5_000 });
  const tip = (await page.getByTestId("usage-tooltip").textContent()) ?? "";

  if (!tip.startsWith("Today") || !tip.includes("Total"))
    throw new Error(`the usage tooltip reads: ${tip}`);
  console.log(`settings-screens: tooltip ${tip}`);
  await shoot(page, "usage-tooltip-moonlit");
  await setAppearance(page, { theme: "light" });
  await page.mouse.move(box.x + box.width - 6, box.y + box.height - 4);
  await shoot(page, "usage-tooltip-light");
  await setAppearance(page, { theme: "dark" });
  await page.mouse.move(0, 0);
  await chart.focus();
  await page.keyboard.press("ArrowLeft");
  await page.getByTestId("usage-tooltip").waitFor({ timeout: 5_000 });
  await shoot(page, "usage-tooltip-keyboard-moonlit");
  await usagePinned(page);
};

/** ↵ pins the focused day (ENG-528): the table names it; the tooltip still shows, then esc unpins. */
const usagePinned = async (page: Page) => {
  await page.keyboard.press("Enter");
  await page.getByTestId("usage-pinned").waitFor({ timeout: 5_000 });
  await page.evaluate(`${USAGE_SCROLLER}.scrollTo(0, 400)`);
  await shoot(page, "usage-pinned-moonlit");
  await setAppearance(page, { theme: "dark", darkTheme: "midnight" });
  await page.getByTestId("usage-chart").focus();
  await shoot(page, "usage-pinned-midnight");
  await page.keyboard.press("Escape");
  await page.getByTestId("usage-pinned").waitFor({ state: "detached", timeout: 5_000 });
  await setAppearance(page, { theme: "dark", darkTheme: "moonlit" });
  await page.evaluate(`${USAGE_SCROLLER}.scrollTo(0, 0)`);
};

/** Usage → By constellation on the `#constellations/usage` fixture, each sky and density. */
const byConstellation = async (page: Page) => {
  await page.evaluate(`location.hash = "#constellations/usage"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("usage-constellation").first().waitFor({ timeout: 15_000 });

  for (const look of MATRIX) {
    await setAppearance(page, look.patch);
    await page.getByTestId("usage-by-constellation").scrollIntoViewIfNeeded();
    await shoot(page, `usage-by-constellation-${look.name}`);
  }
};

const USAGE_SCROLLER = `document.querySelector('[data-section="usage"]')`;

const attached = (page: Page, selector: string) =>
  page.locator(selector).waitFor({ state: "attached", timeout: 5_000 });

const shoot = async (page: Page, name: string) => {
  // Off every control, so no hover fill shows.
  await page.mouse.move(1430, 890);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`settings-screens: saved ${name}.png`);
};

/** A page of Settings: its nav label, its file name, and what says it has painted. */
const PAGES = [
  { nav: "Appearance", slug: "appearance" },
  { nav: "Sessions", slug: "sessions" },
  { nav: "Editor", slug: "editor" },
  { nav: "Harnesses", slug: "harnesses", ready: '[data-testid="harness-row"]' },
  { nav: "Constellations", slug: "constellations" },
  { nav: "Usage", slug: "usage", ready: '[data-testid="usage-figures"]' },
  { nav: "Hosts", slug: "hosts" },
  { nav: "Attachments", slug: "attachments" },
  { nav: "Extensions", slug: "extensions" },
  { nav: "Devices", slug: "devices", ready: '[data-testid="reach-map"]' },
  { nav: "Voice", slug: "voice" },
  { nav: "Reviewer", slug: "reviewer" },
  { nav: "GitHub accounts", slug: "github-accounts" },
] as const;

/** Moonlit and Midnight at every density, light at Calm (the ENG-573 gate). */
const MATRIX = [
  ...["calm", "balanced", "compact"].flatMap((density) =>
    ["moonlit", "midnight"].map((sky) => ({
      name: `${sky}-${density}`,
      patch: { theme: "dark", darkTheme: sky, density },
    }))
  ),
  { name: "light-calm", patch: { theme: "light", density: "calm" } },
];

/** Scrolls the page's panel to `to` ("end" or 0); says whether it's taller than the panel. */
const scroll = (page: Page, to: "end" | 0) =>
  page.evaluate(`(() => {
    const el = document.querySelector("[data-section]");
    el.scrollTo(0, ${to === "end" ? "el.scrollHeight" : 0});
    return el.scrollHeight > el.clientHeight + 40;
  })()`);

/** Each sky and density; a second shot scrolled to the end when the page is taller than the panel. */
const eachLook = async (page: Page, slug: string) => {
  for (const look of MATRIX) {
    await setAppearance(page, look.patch);
    const tall = await scroll(page, 0);

    await shoot(page, `${slug}-${look.name}`);

    if (tall === true) {
      await scroll(page, "end");
      await shoot(page, `${slug}-${look.name}-end`);
      await scroll(page, 0);
    }
  }
};

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page.emulateMedia({ colorScheme: null });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await stubDevices(app);
  await page.evaluate(PAIR);
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings.open")?.click();
  });
  await page.getByTestId("settings").waitFor({ timeout: 5_000 });

  const nav = (name: string) =>
    page.getByTestId("settings").getByRole("button", { name, exact: true }).click();

  // A Moonlit preview keeps its moon while the app is Midnight: each sky follows its own card.
  await nav("Appearance");
  await page.getByRole("radio", { name: "Midnight", exact: true }).click();
  await attached(page, 'html[data-theme-dark="midnight"]');
  await page.getByRole("radio", { name: "Moonlit", exact: true }).click();
  await attached(page, 'html[data-theme-dark="moonlit"]');
  console.log("settings-screens: the dark theme cards switched the dark theme live");

  for (const p of PAGES.filter((p) => wanted(p.slug))) {
    await nav(p.nav);

    if ("ready" in p) await page.locator(p.ready).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(p.slug === "harnesses" ? 3_000 : 1_000);
    await eachLook(page, p.slug);
  }

  // Usage: X-J's figures, then the chart's tooltip and pinned day.
  await setAppearance(page, MATRIX[0]?.patch ?? {});

  if (wanted("usage")) {
    await nav("Usage");
    const figures = (await page.getByTestId("usage-figures").innerText()).split("\n");

    if (figures.length !== 6 || !/^api-equivalent/i.test(figures[3] ?? ""))
      throw new Error(`usage figures: ${figures.join(" | ")}`);
    await usageTooltip(page);
  }

  // This Mac's page, from its row (the extra Daemons aren't saved hosts, so the list has one).
  if (wanted("host-page")) {
    await nav("Hosts");
    await page.getByTestId("machine-local").getByRole("button").first().click();
    await page.getByTestId("host-page").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(2_500);
    await eachLook(page, "host-page");
  }

  if (wanted("about")) {
    await page.getByRole("button", { name: /^About Polaris/ }).click();
    await eachLook(page, "about");
  }

  await setAppearance(page, MATRIX[0]?.patch ?? {});

  if (wanted("checks")) await settingsChecks({ app, page, nav, shoot, setAppearance });

  // Last: the window reloads into the fixture, since the Daemons here have run no constellation.
  if (wanted("usage-by-constellation")) await byConstellation(page);
} finally {
  await app.close();
  await Promise.all(daemons.map((d) => d.stop()));
  rmSync(home, { recursive: true, force: true });
}
