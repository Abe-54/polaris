#!/usr/bin/env node
/**
 * The Browser in Output (ENG-615) in dark and light: no tabs yet, then a Host address page
 * served here, and the tabs again after a restart. A page lives in a WebContentsView over the
 * renderer, so each shot lays the view's own capture over the renderer's. Needs a built app.
 *
 *   node scripts/browserScreens.ts <out dir>
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { APP_DIR, electronBinary, sizeWindow } from "./lib/electron.ts";
import { seedSource } from "./lib/seed.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-browser-screens");

mkdirSync(out, { recursive: true });

const PAGE = `<!doctype html><title>Sign in · Acme</title>
<body style="margin:0;font:15px system-ui;background:#fff;color:#111;display:grid;place-items:center;height:100vh">
<form style="width:280px;display:grid;gap:12px">
<h1 style="font-size:22px;margin:0 0 8px">Sign in to Acme</h1>
<input placeholder="Email" style="padding:10px;border:1px solid #ccc;border-radius:6px">
<input placeholder="Password" type="password" style="padding:10px;border:1px solid #ccc;border-radius:6px">
<button style="padding:10px;border:0;border-radius:6px;background:#111;color:#fff">Continue</button>
</form></body>`;

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));

// SAFETY: a TCP server listening on a port has an AddressInfo address.
const port = (site.address() as AddressInfo).port;

const home = mkdtempSync(join(tmpdir(), "polaris-browser-"));

const daemon = await startDaemon({ home: join(home, "local"), benchHarness: true });

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

/** The visible Browser views' captures, where they sit in the window. */
const viewShots = (app: ElectronApplication) =>
  app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const shots: Array<{ x: number; y: number; width: number; height: number; url: string }> = [];

    for (const child of BrowserWindow.getAllWindows()[0]?.contentView.children ?? []) {
      if (!(child instanceof WebContentsView) || !child.getVisible()) continue;

      const image = await child.webContents.capturePage();

      shots.push({ ...child.getBounds(), url: image.toDataURL() });
    }

    return shots;
  });

const shoot = async (app: ElectronApplication, page: Page, name: string) => {
  await page.mouse.move(10, 880);
  await page.waitForTimeout(800);

  const shots = await viewShots(app);

  await page.evaluate(`(() => {
    for (const shot of ${JSON.stringify(shots)}) {
      const img = document.createElement("img");
      img.src = shot.url;
      img.dataset.shot = "";
      img.style.cssText = "position:fixed;z-index:2147483647;left:" + shot.x + "px;top:" + shot.y +
        "px;width:" + shot.width + "px;height:" + shot.height + "px";
      document.body.append(img);
    }
  })()`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(out, `${name}.png`) });
  await page.evaluate(`document.querySelectorAll("img[data-shot]").forEach((n) => n.remove())`);
  console.log(`browser-screens: saved ${name}.png (${shots.length} view)`);
};

const bothThemes = async (app: ElectronApplication, page: Page, name: string) => {
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(
      `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
    );
    await shoot(app, page, `${name}-${theme}`);
  }
};

const openSession = async (page: Page) => {
  await page.locator('[data-slot="chip"]', { hasText: "acme" }).first().click();
  await page.getByText("Sign-in flow", { exact: true }).first().click();
  // Output reopens as it was left: the panel, or the rail.
  const tab = page.getByTestId("output-tab-browser");

  await page.getByTestId("output-panel").or(page.getByTestId("output-rail")).first().waitFor();

  if (await tab.isVisible()) await tab.click();
  else await page.getByTestId("output-rail-browser").click();
  await page.getByTestId("browser").waitFor({ timeout: 10_000 });
};

try {
  let app = await launch();
  let page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    seedSource([
      {
        hostKey: "local",
        name: "acme",
        sessions: [{ title: "Sign-in flow", state: "idle" }],
      },
    ])
  );
  await openSession(page);
  await page.getByTestId("browser-empty").waitFor({ timeout: 10_000 });
  await bothThemes(app, page, "empty");

  await page.getByTestId("browser-url").fill(`localhost:${port}/sign-in`);
  await page.getByTestId("browser-url").press("Enter");
  await page.getByTestId("host-address-badge").waitFor({ timeout: 10_000 });
  await page.getByTestId("browser-tab").filter({ hasText: "Sign in" }).waitFor({ timeout: 10_000 });
  await bothThemes(app, page, "host-address");

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await openSession(page);
  await page.getByTestId("browser-tab").first().waitFor({ timeout: 10_000 });
  assert.equal(await page.getByTestId("browser-tab").count(), 1, "the tab came back");
  await page.getByTestId("browser-tab").filter({ hasText: "Sign in" }).waitFor({ timeout: 10_000 });
  await shoot(app, page, "after-restart-light");
  await app.close();
} finally {
  await daemon.stop();
  site.close();
  rmSync(home, { recursive: true, force: true });
}
