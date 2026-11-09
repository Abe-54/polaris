#!/usr/bin/env node
/**
 * Screenshots of the Orchestrator and Settings → Appearance in Moonlit, Midnight and light
 * (DESIGN.md, Chrome redesign: Themes), switched live through `settings.setAppearance`, and
 * checks the root's computed ground in each, then archives two sessions for the toast's Undo
 * and the sidebar's archived section (ENG-679). Needs a built app.
 *
 *   node scripts/themeScreens.ts <out dir>
 */
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
import { seedSource } from "./lib/seed.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-theme-screens");

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-theme-screens-"));

const daemon = await startDaemon({ home: join(home, "local"), benchHarness: true });

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
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const THEMES = [
  { name: "moonlit", patch: { theme: "dark", darkTheme: "moonlit" }, ground: "rgb(21, 22, 24)" },
  { name: "midnight", patch: { theme: "dark", darkTheme: "midnight" }, ground: "rgb(0, 0, 0)" },
  { name: "light", patch: { theme: "light" }, ground: "rgb(241, 242, 245)" },
] as const;

/** The root's resolved `--color-ground`, read through a probe so light-dark() is resolved. */
const groundOf = (page: Page) =>
  page.evaluate(`(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--color-ground)";
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  })()`);

const shoot = async (page: Page, name: string) => {
  await page.mouse.move(1300, 860);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`theme-screens: saved ${name}.png`);
};

const eachTheme = async (page: Page, view: string) => {
  for (const theme of THEMES) {
    await page.evaluate(
      `window.polaris.request("settings.setAppearance", { patch: ${JSON.stringify(theme.patch)} })`
    );
    await page.waitForTimeout(400);
    const ground = await groundOf(page);

    if (ground !== theme.ground) throw new Error(`${theme.name}: ground is ${String(ground)}`);
    await shoot(page, `${view}-${theme.name}`);
  }
};

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    seedSource([
      {
        hostKey: "local",
        name: "polaris",
        sessions: [
          { title: "Polaris planning", state: "working" },
          { title: "Spike the review screen", state: "needs-you" },
          { title: "Glossary first pass", state: "idle" },
          { title: "Old feed spike", state: "idle" },
          { title: "Retry backoff notes", state: "idle" },
        ],
      },
    ])
  );
  await page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: /polaris/ })
    .first()
    .click();
  await page.getByText("Polaris planning", { exact: true }).first().click();
  await eachTheme(page, "orchestrator");

  await page.getByText("Glossary first pass", { exact: true }).first().click();

  // ENG-679: Archive from the row's menu shows Undo; the foot of the list folds archived sessions.
  for (const title of ["Retry backoff notes", "Old feed spike"]) {
    await page.getByText(title, { exact: true }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await page.getByText(`Archived ${title}`).first().waitFor({ timeout: 10_000 });
  }

  await page.getByTestId("archived-group").getByRole("button").first().click();
  await page.getByTestId("archived-row").nth(1).waitFor({ timeout: 5_000 });
  await page.getByTestId("archived-row").first().hover();
  await eachTheme(page, "archived");

  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings.open")?.click();
  });
  await page.getByTestId("settings").waitFor({ timeout: 5_000 });
  await eachTheme(page, "appearance");
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
