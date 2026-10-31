#!/usr/bin/env node
/**
 * GitHub Enterprise end to end on fakes (no real network or account): github.com's fake
 * and a GHE Server fake reached as `https://ghe.acme.test` (`/api/v3`, `/api/graphql`).
 * Signs in to github.com, then adds the server in Settings, signs in there, and lists and
 * approves its pull request; screenshots in both themes. Needs a built app.
 *
 *   node scripts/githubEnterpriseScreens.ts <out dir>
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
import {
  githubEnterpriseFlow,
  MOCK_KEYCHAIN,
  serveGitHubEnterpriseFake,
  serveGitHubFake,
} from "./lib/githubFlow.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-github-enterprise-screens");

const home = mkdtempSync(join(tmpdir(), "polaris-ghe-screens-"));

const userData = join(home, "user-data");

mkdirSync(out, { recursive: true });

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", welcomeSeen: true })
);

const daemon = await startDaemon({ home: join(home, "local"), benchHarness: true });

const github = await serveGitHubFake();

const enterprise = await serveGitHubEnterpriseFake();

const step = (message: string) => console.log(`ghe-screens: ${message}`);

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR, MOCK_KEYCHAIN],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
    ...github.env,
    ...enterprise.env,
  },
});

const setTheme = async (page: Page, theme: "dark" | "light") => {
  await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${theme}" })`);
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(400);
};

const shoot = async (page: Page, name: string) => {
  // A pointer left over a ghost button would draw its hover fill.
  await page.mouse.move(0, 0);

  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
    step(`saved ${name}-${theme}.png`);
  }

  await setTheme(page, "dark");
};

let failed = false;

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });

  const started = await page.evaluate<{ userCode: string }>(
    'window.polaris.request("github.signIn.start", {}).then((r) => r.value)'
  );

  github.fake.approveDevice(started.userCode, "mona");
  step(`github.com: approved ${started.userCode} for mona`);
  await githubEnterpriseFlow({
    page,
    fake: enterprise.fake,
    step,
    shoot: (name) => shoot(page, name),
  });
  step("ok");
} catch (error) {
  failed = true;
  console.error("ghe-screens: FAILED", error);
} finally {
  await app.close();
  await daemon.stop();
  await github.close();
  await enterprise.close();
  rmSync(home, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
