/**
 * Markdown source highlighting and the preview in the real app on an isolated profile:
 * node apps/desktop/scripts/markdownSmoke.ts (build first). Opens apps/desktop/README.md and
 * DESIGN.md in both themes, checks every construct is styled, ⇧⌘V, following and the palette.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-markdown-")));

const userData = join(profile, "user-data");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-4b");

const sampleName = "markdown-acceptance.md";

const sample = join(REPO_ROOT, sampleName);

const SAMPLE = [
  "# Heading one",
  "## Heading two",
  "### Heading three",
  "",
  "Some *emphasis*, **strong**, ~~struck~~ and `inline code`.",
  "",
  "A [link](https://polaris.dev) and <https://example.com>.",
  "",
  "> A quote with **strong** inside.",
  "",
  "- bullet",
  "1. numbered",
  "- [x] task",
  "",
  "---",
  "",
  "```ts",
  "export const greet = (name: string) => `hello ${name}`; // comment",
  "```",
  "",
  "```",
  "plain fence",
  "```",
  "",
  "<details><summary>HTML</summary></details>",
  "<!-- a comment -->",
  "",
  "| Column | Other |",
  "| --- | --- |",
  "| cell | cell |",
  "",
].join("\n");

assert.equal(existsSync(sample), false, "Never overwrite an existing file");

mkdirSync(userData);

mkdirSync(evidence, { recursive: true });

writeFileSync(sample, SAMPLE);

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

const until = async (what: string, check: () => Promise<boolean>, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${what}`);
};

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

const openPath = async (page: Page, query: string, file: string) => {
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill(query);

  const item = page.getByTestId("finder-item").filter({ hasText: file }).first();

  await item.waitFor({ timeout: 15_000 });
  await item.click();
  await until(`${file} active`, async () =>
    page.evaluate(
      `[...document.querySelectorAll('[role=tab][aria-selected=true]')].some(t => t.textContent.includes(${JSON.stringify(file)}))`
    )
  );
};

type Look = { color: string; weight: string; style: string; text: string };

/** Computed looks of the visible editor's highlighted spans, by their text. */
const looks = (page: Page): Promise<ReadonlyArray<Look>> =>
  page.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.cm-editor')].find(e => e.offsetParent !== null);
    return [...(editor?.querySelectorAll('.cm-line span') ?? [])].map(span => {
      const style = getComputedStyle(span);
      return { text: span.textContent, color: style.color, weight: style.fontWeight, style: style.fontStyle };
    });
  })()`);

const plainColour = (page: Page) =>
  page.evaluate<string>(`(() => {
    const editor = [...document.querySelectorAll('.cm-editor')].find(e => e.offsetParent !== null);
    return getComputedStyle(editor.querySelector('.cm-content')).color;
  })()`);

const find = (all: ReadonlyArray<Look>, text: string) => {
  const look = all.find((entry) => entry.text === text);

  assert.ok(look, `no highlighted span for ${JSON.stringify(text)}`);

  return look;
};

const checkSample = async (page: Page) => {
  await until("the fence's TypeScript grammar", async () =>
    (await looks(page)).some((entry) => entry.text === "export")
  );

  const all = await looks(page);
  const plain = await plainColour(page);

  assert.equal(find(all, " Heading one").weight, "700");
  assert.equal(find(all, " Heading two").weight, "600");
  assert.equal(find(all, " Heading three").weight, "500");
  assert.equal(find(all, "emphasis").style, "italic");
  assert.equal(find(all, "strong").weight, "600");

  const mark = find(all, "#");

  assert.equal(mark.weight, "400");
  assert.notEqual(mark.color, plain);
  assert.notEqual(find(all, "**").color, plain);
  assert.notEqual(find(all, "link").color, plain);
  assert.notEqual(find(all, "https://polaris.dev").color, plain);
  assert.notEqual(find(all, "inline code").color, plain);
  assert.notEqual(find(all, "plain fence").color, plain);
  assert.notEqual(find(all, "export").color, find(all, "plain fence").color);
  assert.notEqual(find(all, "<!-- a comment -->").color, plain);
  assert.notEqual(find(all, "ts").color, plain);
  assert.equal(find(all, " A quote with ").style, "italic");
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
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(REPO_ROOT)}, name: "polaris" } })`
  );
  await page.keyboard.press("Meta+3");
  await page.getByTestId("explorer").waitFor({ timeout: 15_000 });

  await openPath(page, sampleName, sampleName);
  await checkSample(page);

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await checkSample(page);
    await page.screenshot({ path: join(evidence, `constructs-${theme}.png`) });
  }

  console.log("Every construct is styled in both themes");

  for (const [query, file, shot] of [
    ["apps/desktop/README.md", "README.md", "readme"],
    ["DESIGN.md", "DESIGN.md", "design"],
  ] as const) {
    await openPath(page, query, file);
    await until(`${file} highlighted`, async () => (await looks(page)).length > 20);

    for (const theme of ["dark", "light"]) {
      await appearance(page, theme);
      await page.screenshot({ path: join(evidence, `${shot}-${theme}.png`) });
    }
  }

  console.log("README.md and DESIGN.md highlighted in both themes");

  // ⇧⌘V renders DESIGN.md, then follows the active Markdown file.
  await page.locator(".cm-content").filter({ visible: true }).first().click();
  await page.keyboard.press("Meta+Shift+V");
  await page.getByTestId("editor-markdown-preview").waitFor({ timeout: 20_000 });
  await page.locator(".markdown-preview h1").first().waitFor({ timeout: 20_000 });
  await page.screenshot({ path: join(evidence, "preview-design-light.png") });

  await openPath(page, sampleName, sampleName);
  await page.keyboard.press("Meta+Shift+V");
  await page.getByRole("heading", { name: "Heading one" }).waitFor({ timeout: 20_000 });

  const previewLook = (selector: string) =>
    page.evaluate<{ weight: string; style: string; family: string }>(`(() => {
      const node = document.querySelector('.markdown-preview ${selector}');
      const style = getComputedStyle(node);
      return { weight: style.fontWeight, style: style.fontStyle, family: style.fontFamily };
    })()`);

  assert.equal((await previewLook('[data-streamdown="strong"]')).weight, "600");
  assert.equal((await previewLook("h1")).weight, "600");
  assert.equal((await previewLook("em")).style, "italic");
  assert.match((await previewLook('[data-streamdown="inline-code"]')).family, /mono/i);
  await appearance(page, "dark");
  await page.screenshot({ path: join(evidence, "preview-follows-dark.png") });
  console.log("⇧⌘V renders, and the preview follows the active Markdown file");

  // The palette's command opens it too.
  await openPath(page, "apps/desktop/README.md", "README.md");
  await page.keyboard.press("Meta+Shift+P");
  await page.getByTestId("palette-input").fill("markdown preview");

  const row = page.getByTestId("palette-row").filter({ hasText: "Open Markdown preview" });

  await row.waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(evidence, "palette-preview-dark.png") });
  await row.click();
  await page.getByRole("heading", { name: "@polaris/desktop" }).first().waitFor({
    timeout: 20_000,
  });
  await page.screenshot({ path: join(evidence, "preview-readme-dark.png") });
  console.log("The palette's Open Markdown preview renders README.md");

  console.log("PASS: Markdown acceptance");
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(sample, { force: true });
  rmSync(profile, { recursive: true, force: true });
}
