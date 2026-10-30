#!/usr/bin/env node
/**
 * Picking an element in the Browser (ENG-618) in dark and light: pick mode over a page served
 * here, the chip it leaves in the composer, and the Turn that carries it, whose note is read
 * back from the Host's staging. The page's view is driven with native input. Needs a built app.
 *
 *   node scripts/browserPickScreens.ts <out dir>
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { APP_DIR, electronBinary, sizeWindow } from "./lib/electron.ts";
import { seedSource } from "./lib/seed.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-pick-screens");

mkdirSync(out, { recursive: true });

const PAGE = `<!doctype html><title>Todos · Acme</title>
<body style="margin:0;font:15px system-ui;background:#fafafa;color:#111">
<main style="max-width:420px;margin:56px auto;display:grid;gap:12px">
<h1 style="font-size:22px;margin:0">Today</h1>
<ul id="todos" style="list-style:none;margin:0;padding:0;display:grid;gap:8px">
<li class="item" style="background:#fff;border:1px solid #e3e3e3;border-radius:8px;padding:12px">Ship the pick mode</li>
<li class="item" style="background:#fff;border:1px solid #e3e3e3;border-radius:8px;padding:12px">Review the chip</li>
</ul>
<button class="add css-1x9q2z" style="justify-self:start;padding:10px 14px;border:0;border-radius:6px;background:#111;color:#fff" onclick="document.title='clicked'">Add a todo</button>
</main></body>`;

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));

// SAFETY: a TCP server listening on a port has an AddressInfo address.
const port = (site.address() as AddressInfo).port;

const home = mkdtempSync(join(tmpdir(), "polaris-pick-"));

const daemonHome = join(home, "local");

const daemon = await startDaemon({ home: daemonHome, benchHarness: true });

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
  await page.waitForTimeout(500);

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
  console.log(`pick-screens: saved ${name}.png`);
};

const setTheme = (page: Page, theme: "dark" | "light") =>
  page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
  );

/** Native mouse input to the visible page, at the centre of its first `selector`. */
const mouse = (app: ElectronApplication, selector: string, types: ReadonlyArray<string>) =>
  app.evaluate(
    async ({ BrowserWindow, WebContentsView }, { selector, types }) => {
      const view = (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).find(
        (child) => child instanceof WebContentsView && child.getVisible()
      );

      if (!(view instanceof WebContentsView)) throw new Error("no page on screen");

      // The page answers "x,y": the centre of the element, in its CSS px.
      const answer: unknown = await view.webContents.executeJavaScript(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return Math.round(r.left + r.width / 2) + "," + Math.round(r.top + r.height / 2); })()`
      );

      const [x = 0, y = 0] = String(answer).split(",").map(Number);

      for (const type of types)
        view.webContents.sendInputEvent({
          // SAFETY: the callers pass Electron's mouse event names.
          type: type as "mouseMove",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
    },
    { selector, types }
  );

const pageTitle = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const view = (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).find(
      (child) => child instanceof WebContentsView && child.getVisible()
    );

    return view instanceof WebContentsView ? view.webContents.getTitle() : null;
  });

/** Every staged note on the Host. */
const stagedNotes = () => {
  const found: Array<string> = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) found.push(readFileSync(path, "utf8"));
    }
  };

  walk(daemonHome);

  return found;
};

try {
  const app = await launch();
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    seedSource([
      { hostKey: "local", name: "acme", sessions: [{ title: "Todo list", state: "idle" }] },
    ])
  );
  await page.locator('[data-slot="chip"]', { hasText: "acme" }).first().click();
  await page.getByText("Todo list", { exact: true }).first().click();
  await page.getByTestId("output-panel").or(page.getByTestId("output-rail")).first().waitFor();

  const tab = page.getByTestId("output-tab-browser");

  if (await tab.isVisible()) await tab.click();
  else await page.getByTestId("output-rail-browser").click();
  await page.getByTestId("browser-empty").waitFor({ timeout: 10_000 });
  await page.getByTestId("browser-url").fill(`localhost:${port}/todos`);
  await page.getByTestId("browser-url").press("Enter");
  await page.getByTestId("browser-tab").filter({ hasText: "Todos" }).waitFor({ timeout: 10_000 });

  // Escape leaves pick mode with nothing attached.
  await page.getByTestId("browser-pick").click();
  await page.getByTestId("browser-picking").waitFor();
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow, WebContentsView }) => {
    for (const child of BrowserWindow.getAllWindows()[0]?.contentView.children ?? [])
      if (child instanceof WebContentsView && child.getVisible())
        child.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  });
  await page.getByTestId("browser-picking").waitFor({ state: "detached", timeout: 5_000 });
  assert.equal(await page.getByTestId("attachment-pick").count(), 0, "a cancel attaches nothing");

  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.getByTestId("browser-pick").click();
    await page.getByTestId("browser-picking").waitFor();
    await mouse(app, "#todos li:nth-child(2)", ["mouseMove"]);
    await shoot(app, page, `picking-${theme}`);
    await page.getByTestId("browser-pick").click();
    await page.getByTestId("browser-picking").waitFor({ state: "detached", timeout: 5_000 });
  }

  await setTheme(page, "dark");
  await page.getByTestId("browser-pick").click();
  await page.getByTestId("browser-picking").waitFor();
  await mouse(app, "button.add", ["mouseMove", "mouseDown", "mouseUp"]);
  await page.getByTestId("attachment-pick").waitFor({ timeout: 10_000 });
  assert.notEqual(await pageTitle(app), "clicked", "the page never saw the pick's click");

  const chip = page.getByTestId("attachment-pick");

  assert.equal(await chip.count(), 1, "one chip for the pick");
  assert.match((await chip.textContent()) ?? "", /button\.add/);
  assert.equal(await chip.locator("img").count(), 1, "the chip shows the screenshot");
  // The selector leaves the build's class out; the HTML keeps it.
  assert.match(
    (await chip.getAttribute("title")) ?? "",
    /^button\.add\nhttp:.*\n\n<button class="add css-1x9q2z"/
  );
  await page.getByTestId("composer-input").fill("Make this button match the list items");

  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await shoot(app, page, `chip-${theme}`);
  }

  await page.getByTestId("composer-input").press("Enter");

  const sent = page.getByTestId("sent-attachments").last();

  await sent.waitFor({ timeout: 15_000 });
  assert.equal(await sent.getByTestId("sent-image").count(), 1, "the Turn carries the screenshot");
  assert.equal(await sent.getByTestId("sent-file").count(), 1, "the Turn carries the note");

  const note = stagedNotes().find((text) => text.includes("Element picked in the Browser"));

  assert.ok(note !== undefined, "the note is staged on the Host");
  assert.match(note, /\nSelector: button\.add\n/);
  assert.match(note, new RegExp(`\\nURL: http://localhost:${port}/todos\\n`));
  assert.match(note, /\nScreenshot: .*element-button-add\.png\n/);
  assert.match(note, /untrusted page content/);
  assert.match(note, /<button class="add css-1x9q2z"/);
  console.log(`pick-screens: the staged note\n${note}`);

  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await shoot(app, page, `sent-${theme}`);
  }

  await app.close();
} finally {
  await daemon.stop();
  site.close();
  rmSync(home, { recursive: true, force: true });
}
