/**
 * The Editor's right-click menu in the real app, both themes (Paper 19–19c):
 * node apps/desktop/scripts/editorMenuSmoke.ts [--out <dir>] (build first).
 * Rows follow the file's servers, the caret moves to the click unless it is inside the
 * selection, rows run (definition, rename, copy, paste, paths, terminal), and vim keeps its mode.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Page } from "playwright-core";
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

const evidence = at === -1 ? join(REPO_ROOT, ".dagr/evidence/edmenu/run-9") : String(args[at + 1]);

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-editor-menu-")));

const userData = join(home, "user-data");

const project = join(home, "project");

for (const path of [userData, project, evidence]) mkdirSync(path, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

writeFileSync(join(project, "package.json"), '{"name":"fixture","type":"module"}\n');

writeFileSync(
  join(project, "tsconfig.json"),
  '{"compilerOptions":{"strict":true,"target":"es2022","lib":["es2022","dom"]}}\n'
);

writeFileSync(
  join(project, "main.ts"),
  'const params = new URLSearchParams();\nparams.append("page", "1");\nexport { params };\n'
);

writeFileSync(join(project, "notes.md"), "# Release notes\n\nThe right-click menu\n");

writeFileSync(join(project, "plain.txt"), "alpha beta gamma\ndelta\n");

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
};

const menu = (page: Page) => page.getByTestId("editor-menu");

/** The menu's rows as it reads them: "Label  chord" or "(Label)  reason" when dimmed. */
const rowsOf = async (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(`[...document.querySelectorAll('[data-testid="editor-menu"] [data-slot="menu-item"]')]
    .map((item) => {
      const [label, trailing] = [...item.children].map((child) => child.textContent ?? "");
      const shown = item.hasAttribute("data-disabled") ? "(" + label + ")" : label;

      return trailing === undefined ? shown : shown + "  " + trailing;
    })`);

/** Right-clicks `text` on code line `line` (0-based), at `offset` characters into it. */
const rightClick = async (page: Page, line: number, text: string, offset = 1) => {
  const box: { x: number; y: number } = await page.evaluate(`(() => {
    const line = document.querySelectorAll(".cm-line")[${line}];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const index = node.textContent.indexOf(${JSON.stringify(text)});

      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index + ${offset});
      range.setEnd(node, index + ${offset} + 1);
      const rect = range.getBoundingClientRect();

      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }

    throw new Error("no ${text} on line ${line}");
  })()`);

  await page.mouse.click(box.x, box.y, { button: "right" });
  await menu(page).waitFor();
  await page.waitForTimeout(250);
};

const choose = async (page: Page, testId: string) => {
  await menu(page).getByTestId(testId).click();
  await menu(page).waitFor({ state: "detached" });
  await page.waitForTimeout(250);
};

const status = (page: Page) => page.getByTestId("editor-status").innerText();

const clipboardText = (app: ElectronApplication) =>
  app.evaluate(({ clipboard }) => clipboard.readText());

const shot = (page: Page, name: string) => page.screenshot({ path: join(evidence, `${name}.png`) });

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: ElectronApplication | undefined;

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
    `window.polaris.request("dispatch", {hostKey: "local", commandId: crypto.randomUUID(), command: {_tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "editor-menu"}})`
  );
  await page
    .getByRole("button", { name: /editor-menu/ })
    .first()
    .click();
  await page.keyboard.press("Meta+3");

  // While TypeScript starts its rows dim, the first saying why (Paper 19c).
  await appearance(page, "dark");
  await open(page, "main.ts");
  const pill = page.locator('[data-testid="language-pill"]');
  let early: ReadonlyArray<string> = [];

  for (let tries = 0; tries < 60 && !early.includes("(Go to definition)  Starting"); tries++) {
    if ((await pill.getAttribute("data-kind")) === "ready") break;
    await rightClick(page, 1, "append");
    early = await rowsOf(page);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }

  console.log(`before ready: ${early.join(" | ")}`);

  if (early.includes("(Go to definition)  Starting")) {
    await rightClick(page, 1, "append");
    await shot(page, "ts-starting-dark");
    await page.keyboard.press("Escape");
  }

  await page
    .locator('[data-testid="language-pill"][data-kind="ready"]')
    .waitFor({ timeout: 180_000 });

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await rightClick(page, 1, "append");
    const rows = await rowsOf(page);
    assert.match(await status(page), /^Ln 2, Col 9/, "the caret moved to the click");

    for (const row of ["Go to definition  F12", "Rename symbol…  F2", "Show completions  ⌃Space"])
      assert.ok(rows.includes(row), `ts ${theme}: ${row} in ${rows.join(" | ")}`);
    assert.ok(rows.includes("Copy  ⌘C") && rows.includes("Open in terminal"), "file rows");
    assert.ok(rows.includes("Edit or ask…  ⌘I"), "Edit or ask asks for input");
    assert.ok(rows.includes("Reveal in Finder"), "this Mac's file: Reveal in Finder");
    await shot(page, `ts-ready-${theme}`);
    await page.keyboard.press("Escape");
  }

  // ⇧F10 opens the menu at the caret and leaves it there.
  const before = await status(page);
  await page.keyboard.press("Shift+F10");
  await menu(page).waitFor();
  assert.equal(await status(page), before, "⇧F10: the caret stays");
  await page.waitForTimeout(300);
  await shot(page, "ts-shift-f10-light");
  await page.keyboard.press("Escape");

  // Go to definition from a use lands on the declaration.
  await rightClick(page, 1, "params", 2);
  await choose(page, "editor-menu-definition");
  assert.match(await status(page), /^Ln 1, Col 7/, "definition: on the declaration");

  // Rename symbol… opens its field on the symbol.
  await rightClick(page, 2, "params", 2);
  await choose(page, "editor-menu-rename");
  await page.getByTestId("rename-field").waitFor();
  await shot(page, "ts-rename-field-light");
  await page.keyboard.press("Escape");

  // A right-click inside the selection keeps it; Copy copies it.
  await page.locator(".cm-line").nth(0).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await rightClick(page, 0, "URLSearch", 3);
  assert.match(await status(page), /selected/, "the selection is kept");
  await shot(page, "ts-selection-kept-light");
  await choose(page, "editor-menu-copy");
  assert.equal(await clipboardText(app), "const params = new URLSearchParams();", "copied");

  // Paste at the end of the last line, then undo it.
  await rightClick(page, 2, ";", 0);
  await choose(page, "editor-menu-paste");
  assert.match(
    (await page.locator(".cm-line").nth(2).textContent()) ?? "",
    /const params = new URLSearchParams\(\);/,
    "pasted"
  );
  await page.keyboard.press("Meta+Z");

  await rightClick(page, 0, "params");
  await choose(page, "editor-menu-copy-relative-path");
  assert.equal(await clipboardText(app), "main.ts", "relative path");

  // Reveal in file tree selects the file's row.
  await rightClick(page, 0, "params");
  await choose(page, "editor-menu-reveal-in-tree");
  await page
    .locator('[data-testid="tree-row"][aria-selected="true"]', { hasText: "main.ts" })
    .waitFor({ timeout: 10_000 });

  // Open in terminal: a new tab titled by the file's folder, in Edit's drawer; the mode stays.
  const folder = project.split("/").at(-1) ?? project;
  await rightClick(page, 0, "params");
  await choose(page, "editor-menu-open-in-terminal");
  await page
    .locator('[data-testid="terminal-tab"][aria-selected="true"]', { hasText: folder })
    .waitFor({ timeout: 20_000 });
  await page.getByTestId("terminal-drawer").waitFor();
  assert.ok(await page.getByTestId("edit-mode").isVisible(), "Open in terminal stays in Edit");
  await page.waitForTimeout(1000);
  await shot(page, "ts-open-in-terminal-light");
  await appearance(page, "dark");
  await shot(page, "ts-open-in-terminal-dark");
  await page.keyboard.press("Control+Backquote");
  await page.getByTestId("terminal-toggle").waitFor();

  // Markdown: no server, so only the file's own rows (Paper 19c).
  await open(page, "notes.md");

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await rightClick(page, 2, "menu");
    const rows = await rowsOf(page);
    assert.ok(rows.includes("Open Markdown preview  ⇧⌘V"), `md: ${rows.join(" | ")}`);
    assert.ok(!rows.some((row) => row.startsWith("Go to definition")), "md: no definition");
    await shot(page, `md-${theme}`);
    await page.keyboard.press("Escape");
  }

  // Vim: a visual selection survives the menu, and the mode stays.
  await page.evaluate(
    `window.polaris.request("settings.setSessions", { patch: { editorVim: true } })`
  );
  await page.waitForTimeout(1500);
  await open(page, "plain.txt");

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.locator(".cm-line").nth(0).click();
    await page.keyboard.press("Escape");
    await page.keyboard.type("0wve");
    await rightClick(page, 0, "beta", 2);
    assert.match(await page.getByTestId("vim-mode").innerText(), /VISUAL/i, "vim: still visual");
    await shot(page, `txt-vim-visual-${theme}`);
    await choose(page, "editor-menu-copy");
    assert.equal(await clipboardText(app), "beta", "vim: copied the visual selection");
    await page.keyboard.press("Escape");
    await rightClick(page, 1, "delta");
    assert.match(await page.getByTestId("vim-mode").innerText(), /NORMAL/i, "vim: normal");
    assert.match(await status(page), /Ln 2, Col 2/, "vim: the caret moved to the click");
    await page.keyboard.press("Escape");
  }

  console.log(`editor menu checked; evidence in ${evidence}`);
} finally {
  await app?.close();
  await daemon?.stop();
}
