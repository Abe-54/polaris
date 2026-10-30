#!/usr/bin/env node
/**
 * The Browser end to end on a real remote Host (ENG-612), in the built app. On `<alias>` an app
 * behind Portless and a Vite dev server must already run; the Workspaces are `<app dir>` and
 * `<vite dir>` there. In order:
 *
 * 1. a Claude Code session drives a tab through agent-browser (open, snapshot, fill, click,
 *    screenshot) while the Browser shows it, "… is using this tab";
 * 2. a person opens the Portless URL and the Vite URL as Host addresses (the badge), Vite's HMR
 *    applies an edit made on the Host, and the app's cookie survives a reload and a restart in
 *    its Workspace, while the other Workspace starts without it;
 * 3. an element picked in the Browser goes to the session with the next message;
 * 4. the app quits mid-Turn while the agent waits to use the Browser, and once it is back the
 *    Turn shows "No Desktop App is connected to show this Browser.".
 *
 *   node scripts/browserRemoteCheck.ts <alias> <out dir> --remote-command "<line>" \
 *     --app-dir <dir> --app-url <url> --vite-dir <dir> --vite-url <url> [--harness claude] \
 *     [--person-only]
 *
 * `--person-only` skips 1 and 4 (a Harness that can't run a Turn still gets a Browser).
 * `--agent-only` runs 1, 3 and 4 only. With `--local-socket <path>` and the alias `local`, the
 * Host is this machine's Daemon on that socket instead (no SSH, no Portless or Vite needed).
 *
 * Uses ~/.ssh/config read only, and edits only `<vite dir>/message.js` on the Host (restored).
 * Needs a built app (`bun run build`).
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { APP_DIR, electronBinary, sizeWindow } from "./lib/electron.ts";

const args = process.argv.slice(2);

const option = (flag: string, fallback?: string): string => {
  const at = args.indexOf(flag);
  const value = at === -1 ? fallback : args[at + 1];

  if (value === undefined) throw new Error(`missing ${flag}`);

  return value;
};

const [alias, out] = args;

if (alias === undefined || out === undefined || alias.startsWith("--")) {
  console.error(
    'usage: node scripts/browserRemoteCheck.ts <alias> <out dir> --remote-command "<line>" --app-dir <dir> --app-url <url> --vite-dir <dir> --vite-url <url> [--harness claude]'
  );
  process.exit(2);
}

const agentOnly = args.includes("--agent-only");

const localSocket = args.includes("--local-socket") ? option("--local-socket") : null;

const remoteCommand = localSocket === null ? option("--remote-command") : "";

const appDir = option("--app-dir");

const appUrl = option("--app-url");

const viteDir = agentOnly ? "" : option("--vite-dir");

const viteUrl = agentOnly ? "" : option("--vite-url");

const harness = option("--harness", "claude");

const personOnly = args.includes("--person-only");

const NO_DESKTOP_APP = "No Desktop App is connected to show this Browser.";

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-browser-remote-"));

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

const fullAccess = { model: null, effort: null, permissionMode: "full-access" };

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    theme: "dark",
    welcomeSeen: true,
    ...(localSocket === null
      ? { local: { enabled: false }, hosts: [{ alias, remoteCommand }] }
      : { hosts: [] }),
    sessionDefaults: { claude: fullAccess, codex: fullAccess },
  })
);

const step = (message: string) => console.log(`remote-browser: ${message}`);

const onHost = (command: string) => {
  const run = spawnSync("ssh", ["-o", "BatchMode=yes", alias, command], { encoding: "utf8" });

  if (run.status !== 0) throw new Error(`ssh ${command}: ${run.stderr}`);

  return run.stdout;
};

const hostEnv =
  localSocket === null
    ? process.env
    : { ...process.env, POLARIS_DESKTOP_LOCAL_SOCKET: localSocket };

const launch = () =>
  electron.launch({
    executablePath: electronBinary(),
    args: ["--use-mock-keychain", APP_DIR],
    env: { ...hostEnv, POLARIS_DESKTOP_USER_DATA: userData, POLARIS_DESKTOP_HIDDEN: "1" },
  });

/** The visible page views' captures, laid over the renderer for one screenshot. */
const shoot = async (app: ElectronApplication, page: Page, name: string) => {
  await page.waitForTimeout(500);

  const shots = await app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const found: Array<{ x: number; y: number; width: number; height: number; url: string }> = [];

    for (const child of BrowserWindow.getAllWindows()[0]?.contentView.children ?? []) {
      if (!(child instanceof WebContentsView) || !child.getVisible()) continue;
      found.push({
        ...child.getBounds(),
        url: (await child.webContents.capturePage()).toDataURL(),
      });
    }

    return found;
  });

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
  step(`saved ${name}.png`);
};

/** The visible page's text, read in the page itself. */
const pageText = (app: ElectronApplication) =>
  app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const view = (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).find(
      (child) => child instanceof WebContentsView && child.getVisible()
    );

    if (!(view instanceof WebContentsView)) return null;
    const text: unknown = await view.webContents.executeJavaScript("document.body.innerText");

    return String(text);
  });

const waitForText = async (app: ElectronApplication, pattern: RegExp, what: string) => {
  const deadline = Date.now() + 20_000;
  let last: string | null = null;

  while (Date.now() < deadline) {
    last = await pageText(app);

    if (last !== null && pattern.test(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const views = await app.evaluate(({ BrowserWindow, WebContentsView }) =>
    (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).flatMap((child) =>
      child instanceof WebContentsView
        ? [{ url: child.webContents.getURL(), visible: child.getVisible(), ...child.getBounds() }]
        : []
    )
  );

  // What placement.ts treats as covering the page, if anything.
  const overlays: unknown = await app
    .windows()[0]
    ?.evaluate(
      `[...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')].map((node) => node.outerHTML.slice(0, 200))`
    );

  throw new Error(
    `${what}: the page shows ${JSON.stringify(last)}; views ${JSON.stringify(views)}; overlays ${JSON.stringify(overlays)}`
  );
};

/** Native mouse input to the visible page at the centre of `selector`. */
const click = (app: ElectronApplication, selector: string) =>
  app.evaluate(async ({ BrowserWindow, WebContentsView }, selector) => {
    const view = (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).find(
      (child) => child instanceof WebContentsView && child.getVisible()
    );

    if (!(view instanceof WebContentsView)) throw new Error("no page on screen");

    const answer: unknown = await view.webContents.executeJavaScript(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return Math.round(r.left + r.width / 2) + "," + Math.round(r.top + r.height / 2); })()`
    );

    const [x = 0, y = 0] = String(answer).split(",").map(Number);

    for (const type of ["mouseMove", "mouseDown", "mouseUp"] as const)
      view.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1 });
  }, selector);

const connected = (page: Page) =>
  page
    .locator(`[data-host="${alias}"][data-connection="connected"]`)
    .first()
    .waitFor({ timeout: 60_000 });

/** Opens `dir` on the Host with ⌘O, as a user does. */
const openWorkspace = async (page: Page, dir: string) => {
  await page.keyboard.press("Meta+O");
  await page.getByTestId("folder-path").waitFor({ timeout: 10_000 });
  await page.getByTestId("folder-path").fill(dir);
  await page.waitForTimeout(1500);
  await page.keyboard.press("Meta+Enter");
  await page.getByTestId("folder-path").waitFor({ state: "detached", timeout: 30_000 });
  step(`workspace ${dir} open on ${alias}`);
};

const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`);

const sessionState = (page: Page) => visible(page, "session-state").innerText();

const waitForState = async (page: Page, pattern: RegExp, minutes: number) => {
  const deadline = Date.now() + minutes * 60_000;

  await page.waitForTimeout(2000);

  while (!pattern.test(await sessionState(page))) {
    if (Date.now() > deadline) throw new Error(`session still ${await sessionState(page)}`);
    await page.waitForTimeout(1000);
  }

  return sessionState(page);
};

const send = async (page: Page, text: string) => {
  await visible(page, "composer-input").fill(text);
  await visible(page, "composer-input").press("Enter");
};

/** Shows the session's Browser in Output, from the panel's tab or the rail. */
const showBrowser = async (page: Page) => {
  await page.getByTestId("output-panel").or(page.getByTestId("output-rail")).first().waitFor();
  const tab = page.getByTestId("output-tab-browser");

  if (await tab.isVisible()) await tab.click();
  else await page.getByTestId("output-rail-browser").click();
  await page.getByTestId("browser").waitFor({ timeout: 10_000 });
};

const openTab = async (page: Page, url: string) => {
  const add = page.getByRole("button", { name: "New tab" });

  if (await add.isVisible()) await add.click();
  await page.getByTestId("browser-url").fill(url);
  await page.getByTestId("browser-url").press("Enter");
};

const agentDrives = async (app: ElectronApplication, page: Page) => {
  await page.keyboard.press("Meta+N");
  await page.getByTestId("new-session").waitFor({ timeout: 10_000 });
  await page.getByTestId(`harness-${harness}`).click();
  await send(
    page,
    `Use your agent-browser tools, one step at a time: open ${appUrl}, take a snapshot, fill the Name field with "Polaris", click Greet, take a screenshot, and tell me the exact text of the paragraph under the form.`
  );
  const started = Date.now();

  await showBrowser(page);
  await page.getByTestId("browser-driving").waitFor({ timeout: 180_000 });
  step(`driving strip: ${await page.getByTestId("browser-driving").innerText()}`);
  await shoot(app, page, "01-agent-driving");
  const ended = await waitForState(page, /^(Idle|Needs you|Failed)/, 6);
  const panel = await visible(page, "session-panel").innerText();

  step(`${harness} session ${ended} in ${Math.round((Date.now() - started) / 1000)} s`);
  await shoot(app, page, "02-agent-done");
  assert.match(panel, /Hello, Polaris/, "the agent read the greeting back");
  assert.match(await waitForText(app, /Hello, Polaris/, "the agent's fill and click"), /Polaris/);
};

/**
 * A session whose Turn needn't succeed: the Browser belongs to the session either way. The
 * Workspace's first session if it has one, since a Host whose Harness needs sign-in starts none.
 */
const anySession = async (page: Page, text: string) => {
  await page.waitForTimeout(1500);
  const existing = page.locator("aside [data-session-row]");

  if ((await existing.count()) > 0) {
    await existing.first().click();
    await showBrowser(page);

    return;
  }

  await page.keyboard.press("Meta+N");
  await page.getByTestId("new-session").waitFor({ timeout: 10_000 });
  await page.getByTestId(`harness-${harness}`).click();
  await send(page, text);
  await showBrowser(page);
};

const hostAddresses = async (app: ElectronApplication, page: Page) => {
  await openTab(page, viteUrl);
  await page.getByTestId("host-address-badge").waitFor({ timeout: 20_000 });
  const before = await waitForText(app, /Hello from the Pi/, "Vite's page");

  await shoot(app, page, "03-vite-host-address");
  onHost(`sed -i 's/Hello from the Pi/Edited on the Pi/' ${viteDir}/message.js`);

  try {
    const after = await waitForText(app, /Edited on the Pi/, "Vite's HMR");
    const loaded = (text: string) => /loaded at (\S+)/.exec(text)?.[1];

    assert.equal(loaded(after), loaded(before), "HMR applied the edit without a reload");
    step("vite: HMR applied the Host's edit without a reload");
    await shoot(app, page, "04-vite-hmr");
  } finally {
    onHost(`sed -i 's/Edited on the Pi/Hello from the Pi/' ${viteDir}/message.js`);
  }

  await openTab(page, appUrl);
  await page
    .getByTestId("browser-tab")
    .filter({ hasText: "Acme app" })
    .waitFor({ timeout: 20_000 });
  await page.getByTestId("host-address-badge").waitFor({ timeout: 20_000 });
  const first = await waitForText(app, /Acme app/, "Portless's app");

  step(`portless: ${/cookie: \S+/.exec(first)?.[0]} on the first load`);
  await page.getByRole("button", { name: "Reload" }).click();
  const cookie = await waitForText(app, /cookie: visit=\d+/, "Portless's cookie on reload");

  step(`portless: ${/cookie: \S+/.exec(cookie)?.[0]} after a reload`);
  await shoot(app, page, "05-portless-cookie");

  return /visit=\d+/.exec(cookie)?.[0] ?? "";
};

const pickAndSend = async (app: ElectronApplication, page: Page) => {
  await page.getByTestId("browser-pick").click();
  await page.getByTestId("browser-picking").waitFor();
  await click(app, "#greet");
  await page.getByTestId("attachment-pick").waitFor({ timeout: 10_000 });
  step(`picked: ${await page.getByTestId("attachment-pick").innerText()}`);
  await shoot(app, page, "06-picked");
  await send(page, "What is the element I picked? Answer in one sentence; don't use the browser.");
  const sent = visible(page, "sent-attachments").last();

  await sent.waitFor({ timeout: 20_000 });
  assert.equal(await sent.getByTestId("sent-image").count(), 1, "the Turn carries the screenshot");
  assert.equal(await sent.getByTestId("sent-file").count(), 1, "the Turn carries the note");
  step("the pick went out with the message: its screenshot and its note");
  await waitForState(page, /^(Idle|Needs you|Failed)/, 4);
  await shoot(app, page, "07-pick-answered");
};

let app: ElectronApplication | null = null;

let page: Page;

/** Quits mid-Turn while the agent waits, relaunches, and reads the Turn's error. */
const quitMidTurn = async () => {
  // The agent waits, so the app is gone when it next needs the Browser.
  await send(
    page,
    `Run the shell command \`sleep 25\`, then use agent-browser to take a snapshot of the current tab and tell me the result, including any error message verbatim.`
  );
  await page.waitForTimeout(8000);
  step(`quitting mid-Turn (${await sessionState(page)})`);
  await app?.close();
  await new Promise((resolve) => setTimeout(resolve, 60_000));

  const next = await launch();

  app = next;
  page = await next.firstWindow();
  await sizeWindow(next, 1440, 900);
  await connected(page);
  await waitForState(page, /^(Idle|Needs you|Failed)/, 4);
  const panelText = await visible(page, "session-panel").innerText();

  await shoot(next, page, "08-after-quit");
  assert.ok(panelText.includes(NO_DESKTOP_APP), `the Turn shows "${NO_DESKTOP_APP}"`);
  step(`after the quit the Turn shows "${NO_DESKTOP_APP}"`);
};

try {
  app = await launch();
  page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await connected(page);
  step(`${alias} connected`);
  await openWorkspace(page, appDir);

  if (personOnly) await anySession(page, "Reply with the single word ready.");
  else await agentDrives(app, page);

  if (agentOnly) {
    await pickAndSend(app, page);
    await quitMidTurn();
  } else {
    const cookie = await hostAddresses(app, page);

    await pickAndSend(app, page);

    if (personOnly) {
      await app.close();
      app = await launch();
      page = await app.firstWindow();
      await sizeWindow(app, 1440, 900);
      await connected(page);
      await page.locator('[data-slot="chip"]', { hasText: "app" }).first().click();
      await visible(page, "session-state").first().waitFor({ timeout: 20_000 });
    } else await quitMidTurn();

    // The cookie is the Workspace's: it comes back after the restart, and not in another one.
    await showBrowser(page);
    await openTab(page, appUrl);
    const kept = await waitForText(app, /cookie: /, "the app after a restart");

    assert.ok(kept.includes(cookie), `the cookie ${cookie} survived the restart`);
    step(`after a restart the app still sends ${cookie}`);
    await shoot(app, page, "09-cookie-after-restart");
    await openWorkspace(page, viteDir);
    await anySession(page, "Reply with the single word ready.");
    await openTab(page, appUrl);
    const other = await waitForText(app, /cookie: /, "the app in the other Workspace");

    assert.match(other, /cookie: none/, "another Workspace starts without the cookie");
    step("the other Workspace's Browser starts without it");
    await shoot(app, page, "10-other-workspace");
  }

  await app.close();
  app = null;
} catch (error) {
  await app?.windows()[0]?.screenshot({ path: join(out, "failure.png") });
  console.error(`remote-browser: FAILED ${String(error)}`);
  process.exitCode = 1;
  await app?.close();
} finally {
  rmSync(home, { recursive: true, force: true });
}
