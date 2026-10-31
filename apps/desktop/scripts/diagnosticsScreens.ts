/**
 * Editor diagnostics in the real app on TypeScript and Prisma fixtures:
 * node apps/desktop/scripts/diagnosticsScreens.ts --out <dir> (build first).
 * Hovers a long diagnostic and screenshots the editor in both themes, with the tooltip's size,
 * then inline diagnostics: turned off from the palette, and held under an open completion.
 * The gutter carries no diagnostic mark.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const evidence = at === -1 ? null : (args[at + 1] ?? null);

if (evidence === null) throw new Error("--out <dir> is required");

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-diagnostics-")));

const project = join(home, "project");

for (const path of [project, join(project, "prisma"), evidence])
  mkdirSync(path, { recursive: true });

writeFileSync(join(project, "package.json"), '{"name":"fixture","type":"module"}\n');

writeFileSync(
  join(project, "tsconfig.json"),
  '{"compilerOptions":{"strict":true,"target":"es2022","module":"esnext","moduleResolution":"bundler"}}\n'
);

writeFileSync(
  join(project, "proof.ts"),
  [
    "interface Host {",
    "  readonly label: string;",
    "  readonly latencyMs: number;",
    "}",
    "",
    "const hosts: Map<string, Array<{ id: number; label: string }>> = new Map<string, Set<{ id: string }>>();",
    "const count: number = 'three'",
    "function unused(host: Host) {",
    "  const spare = host.label;",
    "  return host.latencyMs.toFixed(2).padStart(8, ' ').toUpperCase().length",
    "}",
    "",
    "export const total = hosts.size + count + missing;",
    "",
  ].join("\n")
);

writeFileSync(
  join(project, "prisma/schema.prisma"),
  [
    "datasource db {",
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    "}",
    "",
    "model User {",
    "  id    Int     @id @default(autoincrement())",
    "  email String  @unique",
    "}",
    "",
  ].join("\n")
);

const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });

const pointAt = async (page: Page, line: number, column: number) =>
  Schema.decodeUnknownSync(Point)(
    await page.evaluate(`(() => {
      const walker = document.createTreeWalker(document.querySelectorAll('.cm-line')[${line}], NodeFilter.SHOW_TEXT);
      let offset = ${column};
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset >= node.textContent.length) { offset -= node.textContent.length; continue; }
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        const box = range.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
    })()`)
  );

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
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
  await page.locator(".cm-lintRange").first().waitFor({ timeout: 180_000 });
  await page.waitForTimeout(1500);
};

const hover = async (page: Page, line: number, column: number) => {
  const tooltip = page.locator(".cm-tooltip-hover").filter({ has: page.locator(".cm-diagnostic") });

  for (let attempt = 0; attempt < 10; attempt++) {
    await page.mouse.move(10, 10);
    await page.waitForTimeout(150);
    const point = await pointAt(page, line, column);
    await page.mouse.move(point.x, point.y);

    try {
      await tooltip.waitFor({ timeout: 3000 });
      await page.waitForTimeout(400);

      return tooltip;
    } catch {
      // Diagnostics may still be arriving; ask again.
    }
  }

  throw new Error(`No diagnostic hover at ${line}:${column}`);
};

const palette = async (page: Page, command: string) => {
  await page.keyboard.press("Shift+Meta+P");
  await page.keyboard.type(command);
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
};

const inline = async (page: Page) => {
  const shown = await page.locator(".cm-inlineDiagnostic").count();
  assert.equal(await page.locator(".cm-gutters [class*=diagnostic]").count(), 0, "no gutter mark");
  assert.ok(shown > 0, "no inline diagnostics");
  await palette(page, "Toggle inline diagnostics");
  assert.equal(await page.locator(".cm-inlineDiagnostic").count(), 0);
  assert.ok((await page.locator(".cm-lintRange").count()) > 0, "squiggles stay without messages");
  await page.screenshot({ path: join(evidence, "ts-inline-off-dark.png") });
  await palette(page, "Toggle inline diagnostics");
  assert.equal(await page.locator(".cm-inlineDiagnostic").count(), shown);

  for (const theme of ["light", "dark"]) {
    await appearance(page, theme);
    const point = await pointAt(page, 12, 27);
    await page.mouse.click(point.x, point.y);
    await page.mouse.move(10, 10);
    await page.keyboard.press("Control+Space");
    await page.locator(".cm-tooltip-autocomplete").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".cm-inlineDiagnostic").count(), shown - 1);
    await page.screenshot({ path: join(evidence, `ts-completion-${theme}.png`) });
    await page.keyboard.press("Escape");
  }
};

const shoot = async (page: Page, name: string, line: number, column: number) => {
  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(evidence, `${name}-lines-${theme}.png`) });
    const tooltip = await hover(page, line, column);
    const box = await tooltip.boundingBox();
    const editor = await page.locator(".cm-editor").boundingBox();
    console.log(
      `${name} ${theme}: tooltip ${JSON.stringify(box)} editor ${JSON.stringify(editor)}`
    );

    if (!args.includes("--before"))
      assert.ok(box && box.width <= 560, `${name} tooltip is ${box?.width}px wide`);

    await page.screenshot({ path: join(evidence, `${name}-hover-${theme}.png`) });
  }
};

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
      POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

  const page = await app.firstWindow();

  await sizeWindow(app, 1280, 800);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", {hostKey: "local", commandId: crypto.randomUUID(), command: {_tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "diagnostics-proof"}})`
  );
  await page
    .getByRole("button", { name: /diagnostics-proof/ })
    .first()
    .click();
  await page.keyboard.press("Meta+3");

  await open(page, "proof.ts");
  await shoot(page, "ts", 5, 8);
  await page.mouse.move(10, 10);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Shift+Meta+M");
  await page.getByRole("heading", { name: "Problems" }).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(evidence, "ts-problems.png") });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await inline(page);

  if (!args.includes("--no-prisma")) {
    await open(page, "schema.prisma");
    await shoot(page, "prisma", 2, 3);
  }

  console.log(`PASS: diagnostics screenshots in ${evidence}`);
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
}
