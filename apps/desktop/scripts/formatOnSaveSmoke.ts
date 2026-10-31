/**
 * Format on save in the real app on an isolated profile: node apps/desktop/scripts/formatOnSaveSmoke.ts
 * (build first). In a repo with no formatter of its own and none chosen, saving a badly indented
 * TypeScript file formats it on disk through the file's own server, with Vim mode off (⌘S) and on
 * (:w); one undo restores it.
 */
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  stockElectronBinary,
} from "./lib/electron.ts";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-format-on-save-")));

const userData = join(profile, "user-data");

/** A repo with no formatter config or dependency, so the TypeScript server formats. */
const workspace = join(profile, "plain");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-4a");

const messy = [
  "export function answer(){",
  "  const a = 1;",
  "  if (a) {",
  "    const b = 2;",
  "  }",
  "  if (true) {",
  "        return   42",
  "  }",
  "  return a;",
  "}",
  "",
].join("\n");

const files = ["format-on-save-plain.ts", "format-on-save-vim.ts"].map((name) => ({
  name,
  path: join(workspace, name),
}));

mkdirSync(userData);

mkdirSync(workspace);

for (const file of files) assert.equal(existsSync(file.path), false, "Never overwrite a file");

mkdirSync(evidence, { recursive: true });

for (const file of files) writeFileSync(file.path, messy);

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 90_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${what}`);
};

const shown = (page: Page) =>
  page.evaluate<string>(`document.querySelector(".cm-content")?.innerText ?? ""`);

/** Formatted by the server with the file's own 2-space indentation. */
const formatted = (text: string) =>
  /\n {2}if \(true\) \{\n {4}return 42;?\n {2}\}/.test(text) && !text.includes("return   42");

const open = async (page: Page, name: string) => {
  await page
    .getByTestId("tree-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click({ timeout: 15_000 });
  await until(`${name} shown`, async () => (await shown(page)).includes("return   42"));
  // The file's server formats once the palette offers Format document for it.
  await until(`${name}'s server formats`, async () => {
    await page.keyboard.press("Meta+Shift+P");
    await page.getByTestId("palette-input").fill("format document");
    await page.waitForTimeout(200);

    const offered =
      (await page.getByTestId("palette-row").filter({ hasText: "Format document" }).count()) > 0;

    await page.keyboard.press("Escape");
    await page.getByTestId("command-palette").waitFor({ state: "detached" });

    return offered;
  });
};

const savedFormatted = async (path: string, what: string) => {
  await until(what, () => formatted(readFileSync(path, "utf8")));
};

try {
  daemon = await startDaemon({ home: profile, benchHarness: true });
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

  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(workspace)}, name: "plain" } })`
  );
  await page.keyboard.press("Meta+3");
  await page.getByTestId("explorer").waitFor({ timeout: 30_000 });

  const [plain, vim] = files;

  if (plain === undefined || vim === undefined) throw new Error("Fixture files missing");

  // Vim mode off: edit, ⌘S.
  await open(page, plain.name);
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("// saved\n");
  await page.keyboard.press("Meta+S");
  await savedFormatted(plain.path, "⌘S formatted the file on disk");
  await until("the editor shows the formatted text", async () => formatted(await shown(page)));
  await page.screenshot({ path: join(evidence, "format-on-save-plain.png") });
  await page.keyboard.press("Meta+Z");
  await until("one undo restores the typed text", async () =>
    (await shown(page)).includes("return   42")
  );
  console.log("Vim off: ⌘S formatted the file on disk; one ⌘Z restored the text");

  // Vim mode on: o, type, esc, :w.
  await page.evaluate(
    `window.polaris.request("settings.setSessions", { patch: { editorVim: true } })`
  );
  await until(
    "vim mode",
    async () => (await page.getByText("NORMAL", { exact: true }).count()) > 0,
    20_000
  );
  await open(page, vim.name);
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("Go// saved");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":w");
  await page.keyboard.press("Enter");
  await savedFormatted(vim.path, ":w formatted the file on disk");
  await until("the editor shows the formatted text", async () => formatted(await shown(page)));
  await page.screenshot({ path: join(evidence, "format-on-save-vim.png") });
  await page.keyboard.press("u");
  await until("one u restores the typed text", async () =>
    (await shown(page)).includes("return   42")
  );
  console.log("Vim on: :w formatted the file on disk; one u restored the text");
  console.log("PASS: Format on save");
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();

  for (const file of files) rmSync(file.path, { force: true });
  rmSync(profile, { recursive: true, force: true });
}
