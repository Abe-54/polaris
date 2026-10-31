/**
 * The completion menu, its info panel, hover and signature help in the real app, on CSS,
 * TypeScript and Python (uv) fixtures, both themes:
 * node apps/desktop/scripts/completionSmoke.ts [--out <dir>] (build first; needs uv).
 * Checks no row names its server, the footnote does, and nothing overflows its box.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const evidence = at === -1 ? join(REPO_ROOT, ".dagr/evidence/comp/run-1") : String(args[at + 1]);

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-completion-")));

const userData = join(home, "user-data");

const project = join(home, "project");

for (const path of [userData, project, evidence]) mkdirSync(path, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

for (const step of [
  ["init", "--bare", "--python", "/usr/bin/python3", "--no-python-downloads"],
  ["venv", "--python", "/usr/bin/python3", "--no-python-downloads"],
])
  execFileSync("uv", step, { cwd: project, stdio: "pipe" });

writeFileSync(join(project, "style.css"), ".session-row .caption {\n  color: red;\n  \n}\n");

writeFileSync(join(project, "package.json"), '{"name":"fixture","type":"module"}\n');

writeFileSync(
  join(project, "tsconfig.json"),
  '{"compilerOptions":{"strict":true,"target":"es2022","lib":["es2022","dom"],"module":"esnext","moduleResolution":"bundler"}}\n'
);

writeFileSync(join(project, "main.ts"), "const params = new URLSearchParams();\n\n");

writeFileSync(
  join(project, "hosts.ts"),
  "export const hostLabel = (name: string): string => name.trim();\n"
);

writeFileSync(join(project, "main.py"), "import json\n\n");

/** Every server id the rows must never show. */
const SERVERS =
  /vscode-css-language-server|typescript-language-server|typescript-go|basedpyright|tsserver/;

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(250);
};

const open = async (page: Page, name: string) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill(name);
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20_000 });
  await page.keyboard.press("Enter");
  await page
    .locator(`[data-testid="editor-tab"][aria-selected="true"][title$="${name}"]`)
    .waitFor();
  await page
    .locator('[data-testid="language-pill"][data-kind="ready"]')
    .waitFor({ timeout: 180_000 });
};

/** Puts the caret at the end of `line` (0-based) and types `text`. */
const typeAt = async (page: Page, line: number, text: string) => {
  await page.locator(".cm-line").nth(line).click();
  await page.keyboard.press("End");
  await page.keyboard.type(text, { delay: 60 });
};

/** Undoes what `typeAt` typed, so each theme starts from the same text. */
const undo = async (page: Page, count: number) => {
  await page.keyboard.press("Escape");

  for (let index = 0; index < count; index++) await page.keyboard.press("Meta+Z");
};

const Menu = Schema.Struct({
  rows: Schema.Array(Schema.String),
  footnote: Schema.String,
  footnoteLast: Schema.Boolean,
  selected: Schema.String,
  fillSelected: Schema.String,
  info: Schema.Boolean,
  overflow: Schema.Array(Schema.String),
  links: Schema.Array(Schema.String),
  heavy: Schema.Array(Schema.String),
});

const inspectMenu = async (page: Page) =>
  Schema.decodeUnknownSync(Menu)(
    await page.evaluate(`(() => {
      const menu = document.querySelector(".cm-tooltip-autocomplete");
      const info = menu.querySelector(".cm-completionInfo");
      const box = (el) => el.getBoundingClientRect();
      const inside = (child, parent) => box(child).right <= box(parent).right + 1 && box(child).left >= box(parent).left - 1;
      const probe = document.createElement("div");
      probe.style.background = "var(--color-fill-selected)";
      document.body.append(probe);
      const fillSelected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const overflow = [];
      for (const el of [menu.querySelector("ul"), ...(info ? info.querySelectorAll("[data-language-docs] *") : [])])
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible") overflow.push(el.tagName + "." + el.className);
      const links = info ? [...info.querySelectorAll("a")] : [];
      for (const link of links) if (!inside(link, info)) overflow.push("link " + link.textContent);
      const selected = menu.querySelector("li[aria-selected]");
      return {
        rows: [...menu.querySelectorAll("li")].map((li) => li.textContent),
        footnote: menu.querySelector("[data-completion-footnote]")?.textContent ?? "",
        footnoteLast: box(menu.querySelector("[data-completion-footnote]")).top >= box(menu.querySelector("ul")).bottom - 1,
        selected: selected ? getComputedStyle(selected).backgroundColor : "",
        fillSelected,
        info: !!info?.querySelector("[data-language-docs]"),
        overflow,
        links: links.map((link) => link.textContent),
        heavy: info ? [...info.querySelectorAll("*")].filter((el) => el.textContent && Number(getComputedStyle(el).fontWeight) > 500).map((el) => el.tagName + " " + el.textContent.slice(0, 20)) : [],
      };
    })()`)
  );

/** Types `text` at `line`, waits for the menu and its info, checks it, and screenshots it. */
const completion = async (
  page: Page,
  name: string,
  line: number,
  text: string,
  footnote: RegExp,
  info: string
) => {
  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await typeAt(page, line, text);

    const menu = page.locator(".cm-tooltip-autocomplete");

    try {
      await menu.locator("[data-completion-footnote]").waitFor({ timeout: 30_000 });
      await menu
        .locator(".cm-completionInfo")
        .filter({ hasText: info })
        .waitFor({ timeout: 30_000 });
    } catch (error) {
      await page.screenshot({ path: join(evidence, `${name}-${theme}-missing.png`) });
      throw error;
    }

    await page.waitForTimeout(600);

    const look = await inspectMenu(page);

    writeFileSync(join(evidence, `${name}-${theme}.json`), JSON.stringify(look, null, 2));
    await page.screenshot({ path: join(evidence, `${name}-${theme}.png`) });

    assert.ok(look.rows.length > 0, `${name}: rows`);
    assert.ok(!look.rows.some((row) => SERVERS.test(row)), `${name}: a row names its server`);
    assert.match(look.footnote, footnote, `${name}: footnote`);
    assert.ok(look.footnoteLast, `${name}: the footnote is under the list`);
    assert.equal(look.selected, look.fillSelected, `${name}: selection is fill-selected`);
    assert.ok(look.info, `${name}: info uses the docs renderer`);
    assert.deepEqual(look.overflow, [], `${name}: nothing overflows`);
    assert.deepEqual(look.heavy, [], `${name}: nothing in the docs above weight 500`);
    await undo(page, 1);
  }
};

const Popup = Schema.Struct({ footnote: Schema.String, active: Schema.String, top: Schema.String });

/** Hover or signature help: the footnote names the server and nothing sits above the docs. */
const inspectPopup = async (page: Page, selector: string) =>
  Schema.decodeUnknownSync(Popup)(
    await page.evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      return {
        footnote: root.querySelector("[data-docs-footnote]")?.textContent ?? "",
        active: root.querySelector("[data-doc-active]")?.textContent ?? "",
        top: (root.querySelector("[data-language-docs] > div > section")?.textContent ?? "").slice(0, 40),
      };
    })()`)
  );

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  daemon = await startDaemon({ home, benchHarness: true });
  app = await electron.launch({
    executablePath: stockElectronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

  const page = await app.firstWindow();

  await sizeWindow(app, 1280, 860);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", {hostKey: "local", commandId: crypto.randomUUID(), command: {_tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "completion-proof"}})`
  );
  await page
    .getByRole("button", { name: /completion-proof/ })
    .first()
    .click();
  await page.keyboard.press("Meta+3");

  await open(page, "style.css");
  await completion(page, "css", 2, "disp", /vscode-css-language-server/, "Syntax");
  console.log("CSS completion checked");

  await open(page, "main.ts");
  await completion(page, "ts", 1, "params.ap", /TypeScript/, "URLSearchParams.append");

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await typeAt(page, 1, 'params.append("page",');

    const help = page.locator("[data-signature-help]");

    try {
      await help.locator("[data-doc-active]").waitFor({ timeout: 30_000 });
    } catch (error) {
      await page.screenshot({ path: join(evidence, `ts-signature-${theme}-missing.png`) });
      throw error;
    }

    await page.waitForTimeout(400);

    const look = await inspectPopup(page, "[data-signature-help]");

    await page.screenshot({ path: join(evidence, `ts-signature-${theme}.png`) });
    assert.equal(look.active, "value: string", "signature: active parameter");
    assert.match(look.footnote, /TypeScript/, "signature: footnote");
    assert.ok(look.top.startsWith("append("), "signature: the signature leads");
    await undo(page, 1);
  }

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);

    const word = page.locator(".cm-line").nth(0).getByText("URLSearchParams");
    const tooltip = page.locator(".cm-tooltip-hover [data-docs-footnote]");

    for (let attempt = 0; attempt < 20 && !(await tooltip.isVisible()); attempt++) {
      await page.mouse.move(10, 10);
      await word.hover();
      await page.waitForTimeout(1500);
    }

    const look = await inspectPopup(page, ".cm-tooltip-hover");

    await page.screenshot({ path: join(evidence, `ts-hover-${theme}.png`) });
    assert.match(look.footnote, /TypeScript/, "hover: footnote");
    assert.ok(
      look.top !== "" && !look.top.startsWith("TypeScript"),
      `hover: docs lead (${look.top})`
    );
    await page.mouse.move(10, 10);
  }

  console.log("TypeScript completion, signature help and hover checked");

  // Accepting the server's auto-import applies the resolved item: its import edit lands too.
  await appearance(page, "dark");
  await typeAt(page, 1, "hostLa");
  await page
    .locator(".cm-completionInfo")
    .filter({ hasText: /(?:Auto|Add) import from ["']\.\/hosts/ })
    .waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(evidence, "ts-auto-import-menu-dark.png") });
  await page.keyboard.press("Enter");
  await page
    .locator(".cm-line")
    .first()
    .filter({ hasText: /^import \{ hostLabel \} from "\.\/hosts(\.ts)?";$/ })
    .waitFor({ timeout: 5_000 });
  assert.equal(
    await page.locator(".cm-line").nth(2).textContent(),
    "const params = new URLSearchParams();"
  );
  await page.screenshot({ path: join(evidence, "ts-auto-import-accepted-dark.png") });
  await undo(page, 1);
  console.log("TypeScript auto-import accepted");

  await open(page, "main.py");
  await completion(page, "python", 1, "json.du", /basedpyright/, "def dump(");
  console.log("Python completion checked");

  console.log(`PASS: completion screenshots in ${evidence}`);
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
}
