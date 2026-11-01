/**
 * Hover tooltips in the real app on Python (uv) and TypeScript fixtures:
 * node apps/desktop/scripts/hoverSmoke.ts [--out <dir>] [--prefix <name>] (build first; needs uv).
 * Screenshots each hover in both themes and saves its HTML beside them.
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

const flag = (name: string, fallback: string) => {
  const at = args.indexOf(name);

  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const evidence = flag("--out", join(REPO_ROOT, ".dagr/evidence/hover-render"));

const prefix = flag("--prefix", "after");

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-hover-")));

const userData = join(home, "user-data");

const project = join(home, "project");

for (const path of [userData, project, evidence]) mkdirSync(path, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

execFileSync("uv", ["init", "--bare", "--python", "/usr/bin/python3", "--no-python-downloads"], {
  cwd: project,
  stdio: "pipe",
});

execFileSync("uv", ["venv", "--python", "/usr/bin/python3", "--no-python-downloads"], {
  cwd: project,
  stdio: "pipe",
});

writeFileSync(
  join(project, "proof.py"),
  [
    "def greet(name: str, *, loud: bool = False) -> str:",
    '    """Return a greeting for ``name``.',
    "",
    "    The greeting is built from a template and, when ``loud`` is set,",
    "    upper-cased. This docstring is deliberately long so the hover has to",
    "    wrap and scroll.",
    "",
    "    Args:",
    "        name: Who to greet.",
    "        loud: Shout it.",
    "",
    "    Example:",
    "        >>> greet('Ada')",
    "        'Hello, Ada'",
    '    """',
    '    return f"Hello, {name}"',
    "",
    "",
    'value = str(greet("Ada"))',
    "",
  ].join("\n")
);

writeFileSync(join(project, "package.json"), '{"name":"fixture","type":"module"}\n');

writeFileSync(
  join(project, "tsconfig.json"),
  '{"compilerOptions":{"strict":true,"target":"es2022","module":"esnext","moduleResolution":"bundler"}}\n'
);

writeFileSync(
  join(project, "proof.ts"),
  [
    "/** A Host the Desktop App can reach. */",
    "export interface Host {",
    "  /** Its name, as the user wrote it. */",
    "  readonly label: string;",
    "  readonly latencyMs: number;",
    "}",
    "",
    "/**",
    " * Picks the closest Host.",
    " * @param hosts Every connected Host.",
    " * @returns The one with the lowest latency, or `undefined`.",
    " */",
    "export function closest(hosts: readonly Host[], fallback?: Host): Host | undefined {",
    "  return hosts.reduce<Host | undefined>((best, h) => (best && best.latencyMs < h.latencyMs ? best : h), fallback);",
    "}",
    "",
    "const pick = closest([], undefined);",
    "",
  ].join("\n")
);

const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });

/** The screen point of a character, by line and column in the open file. */
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

const appearance = async (page: Page, theme: string, density: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
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

/** Hovers until the tooltip holds `text` and its fences have settled. */
const hover = async (page: Page, line: number, column: number, text: string) => {
  const tooltip = page.locator(".cm-tooltip-hover").filter({ hasText: text });

  for (let attempt = 0; attempt < 20; attempt++) {
    await page.mouse.move(10, 10);
    await page.waitForTimeout(150);

    const point = await pointAt(page, line, column);

    await page.mouse.move(point.x, point.y);

    try {
      await tooltip.waitFor({ timeout: 3000 });
      await page.waitForTimeout(600);

      return tooltip;
    } catch {
      // The server is still indexing; ask again.
    }
  }

  throw new Error(`No hover with ${text}`);
};

const Look = Schema.Struct({
  code: Schema.Number,
  headers: Schema.Number,
  sideways: Schema.Number,
  mono: Schema.Boolean,
  reserved: Schema.Number,
});

/** Code in the code font, no visible block header, nothing scrolling sideways or reserving space. */
const checkLook = async (page: Page) => {
  const look = Schema.decodeUnknownSync(Look)(
    await page.evaluate(`(() => {
      const root = document.querySelector(".cm-tooltip-hover");
      const bodies = [...root.querySelectorAll('[data-streamdown="code-block-body"]')];
      const blocks = [...root.querySelectorAll('[data-streamdown="code-block"]')];
      const headers = [...root.querySelectorAll('[data-streamdown="code-block-header"]')];
      return {
        code: bodies.length,
        headers: headers.filter((header) => getComputedStyle(header).display !== "none").length,
        sideways: bodies.filter((body) => body.scrollWidth > body.clientWidth + 1).length,
        mono: bodies.every((body) => /mono|Menlo/i.test(getComputedStyle(body).fontFamily)),
        reserved: blocks.filter((block) => getComputedStyle(block).contentVisibility === "auto").length,
      };
    })()`)
  );

  assert.ok(look.code > 0, "the signature is a code block");
  assert.deepEqual(
    { headers: look.headers, sideways: look.sideways, mono: look.mono, reserved: look.reserved },
    { headers: 0, sideways: 0, mono: true, reserved: 0 }
  );
};

const shoot = async (page: Page, name: string, line: number, column: number, text: string) => {
  for (const [theme, density] of [
    ["dark", "balanced"],
    ["light", "balanced"],
    ["dark", "compact"],
    ["light", "calm"],
  ] as const) {
    await appearance(page, theme, density);

    const tooltip = await hover(page, line, column, text);

    if (prefix === "after") await checkLook(page);

    if (density === "balanced") {
      writeFileSync(join(evidence, `${prefix}-${name}.html`), await tooltip.innerHTML());
      await page.screenshot({ path: join(evidence, `${prefix}-${name}-${theme}.png`) });
    } else {
      await page.screenshot({ path: join(evidence, `${prefix}-${name}-${theme}-${density}.png`) });
    }
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
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

  const page = await app.firstWindow();

  await sizeWindow(app, 1280, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", {hostKey: "local", commandId: crypto.randomUUID(), command: {_tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "hover-proof"}})`
  );
  await page
    .getByRole("button", { name: /hover-proof/ })
    .first()
    .click();
  await page.keyboard.press("Meta+3");

  await open(page, "proof.py");
  await shoot(page, "python-str", 18, 9, "class str");
  await shoot(page, "python-function", 18, 13, "def greet");
  console.log("Python hovers captured");

  await open(page, "proof.ts");
  await shoot(page, "ts-function", 16, 15, "function closest");
  await shoot(page, "ts-interface", 12, 41, "interface Host");
  console.log("TypeScript hovers captured");

  console.log(`PASS: hover screenshots in ${evidence} (${prefix})`);
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
}
