#!/usr/bin/env node
/**
 * Screenshots of Settings → GitHub accounts → Add account when GitHub can't be reached
 * (a closed port) and when its certificate isn't trusted (a self-signed server), both
 * themes. One local Daemon, no real network or account. Needs a built app.
 *
 *   node scripts/githubSignInErrorScreens.ts <out dir>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
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
import { MOCK_KEYCHAIN } from "./lib/githubFlow.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-github-sign-in-errors");

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-sign-in-errors-"));

const [keyPath, certPath] = [join(home, "key.pem"), join(home, "cert.pem")];

const certArgs = "-x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1".split(" ");

execFileSync("openssl", ["req", ...certArgs, "-keyout", keyPath, "-out", certPath]);

const untrusted = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (_req, res) => res.end("{}")
);

await new Promise<void>((resolve) => untrusted.listen(0, "127.0.0.1", resolve));

// SAFETY: a TCP server listening on a port has an AddressInfo address.
const untrustedUrl = `https://127.0.0.1:${(untrusted.address() as AddressInfo).port}`;

const closed = createServer();

await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));

// SAFETY: a TCP server listening on a port has an AddressInfo address.
const closedUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;

closed.close();

const daemon = await startDaemon({ home: join(home, "local"), benchHarness: true });

const shoot = async (page: Page, name: string) => {
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`github-sign-in-error-screens: saved ${name}.png`);
};

/** Opens the app with GitHub at `webUrl`, adds an account, and shoots the card in both themes. */
const scene = async (name: string, webUrl: string) => {
  const userData = join(home, `user-data-${name}`);

  mkdirSync(userData, { recursive: true });
  writeFileSync(
    join(userData, "settings.json"),
    JSON.stringify({ theme: "dark", welcomeSeen: true })
  );

  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [APP_DIR, MOCK_KEYCHAIN],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
      POLARIS_GITHUB_WEB_URL: webUrl,
      POLARIS_GITHUB_API_URL: webUrl,
    },
  });

  try {
    const page = await app.firstWindow();

    await sizeWindow(app, 1440, 900);
    await page
      .locator('[data-host="local"][data-connection="connected"]')
      .waitFor({ timeout: 20_000 });
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("settings.open")?.click();
    });
    await page.getByTestId("settings").waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "GitHub accounts", exact: true }).click();
    await page.getByRole("button", { name: "Add account" }).click();
    await page.getByRole("button", { name: "Try again" }).waitFor({ timeout: 15_000 });
    await shoot(page, `${name}-dark`);
    await page.evaluate(
      `window.polaris.request("settings.setAppearance", { patch: { theme: "light" } })`
    );
    await shoot(page, `${name}-light`);
  } finally {
    await app.close();
  }
};

try {
  await scene("unreachable", closedUrl);
  await scene("untrusted-certificate", untrustedUrl);
} finally {
  untrusted.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
