/**
 * Real isolated Electron acceptance for Go and PHP (build first):
 * POLARIS_SMOKE_PHP=<php 8.2+> POLARIS_SMOKE_GOPLS=<gopls> POLARIS_SMOKE_PHP_CS_FIXER=<phar>
 * node apps/desktop/scripts/goPhpLanguageSmoke.ts
 */
import { strict as assert } from "node:assert";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Page } from "playwright-core";
import { Schema } from "effect";
import { startDaemon } from "./lib/daemon.ts";
import { seenUserData } from "./lib/userData.ts";
import { assertStatusBarShown, longFile } from "./lib/statusBar.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";

const required = (name: string) => {
  const value = process.env[name];

  if (value === undefined || !existsSync(value)) throw new Error(`Set ${name} to a file`);

  return value;
};

const php = required("POLARIS_SMOKE_PHP");

const gopls = required("POLARIS_SMOKE_GOPLS");

const fixer = required("POLARIS_SMOKE_PHP_CS_FIXER");

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-go-php-desktop-")));

const userHome = join(home, "user");

const userData = seenUserData(join(home, "user-data"));

const project = join(home, "project");

const runs = join(REPO_ROOT, ".dagr/evidence/s8b");

/** Each run keeps its own folder, run-1, run-2…, so evidence is never overwritten. */
const evidence = (() => {
  let run = 1;

  while (existsSync(join(runs, `run-${run}`))) run++;

  return join(runs, `run-${run}`);
})();

/** Any Composer file PHP loads leaves this behind. */
const sentinel = join(project, "COMPOSER_RAN");

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(join(project, path), text);
};

const PHP_MAIN =
  "<?php\n\nnamespace App;\n\n$greeter = new Greeter();\necho $greeter->greet('x');\n$greeter->missing();\n";

const GO_MAIN =
  'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(Greet("x"))\n\tvar wrong int = "text"\n\t_ = wrong\n}\n';

for (const path of [evidence, project, join(userHome, ".local/bin")])
  mkdirSync(path, { recursive: true });

copyFileSync(php, join(userHome, ".local/bin/php"));

chmodSync(join(userHome, ".local/bin/php"), 0o755);

const run = `<?php file_put_contents(${JSON.stringify(sentinel)}, __FILE__); return [];\n`;

put("php/composer.json", '{"autoload": {"psr-4": {"App\\\\": "src/"}}}\n');

put(
  "php/src/Greeter.php",
  "<?php\n\nnamespace App;\n\nclass Greeter\n{\n    /** Says hello. */\n    public function greet(string $name): string\n    {\n        return 'Hello ' . $name;\n    }\n}\n"
);

put("php/src/main.php", PHP_MAIN);

put("php/src/Long.php", "<?php\n" + longFile((index) => `$value${index} = ${index};`));

put("php/vendor/autoload.php", run);

put("php/vendor/composer/autoload_psr4.php", run);

put("php/vendor/composer/autoload_classmap.php", run);

put("php/.phpactor.json", '{"composer.enable": true}\n');

mkdirSync(join(project, "php/vendor/bin"), { recursive: true });

copyFileSync(fixer, join(project, "php/vendor/bin/php-cs-fixer"));

chmodSync(join(project, "php/vendor/bin/php-cs-fixer"), 0o755);

put("go/go.mod", "module example.com/fixture\n\ngo 1.22\n");

put(
  "go/greet.go",
  'package main\n\n// Greet says hello.\nfunc Greet(name string) string {\n\treturn "Hello " + name\n}\n'
);

put("go/main.go", GO_MAIN);

const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });

/** The screen point of a line's first `needle`, one character in. */
const pointOf = async (page: Page, line: number, needle: string) =>
  Schema.decodeUnknownSync(Point)(
    await page.evaluate(`(() => {
    const element = document.querySelectorAll('.cm-line')[${line}];
    let offset = element.textContent.indexOf(${JSON.stringify(needle)}) + 1;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (offset >= node.textContent.length) { offset -= node.textContent.length; continue; }
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
      const box = range.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
  })()`)
  );

const tab = (page: Page, name: string) =>
  page.locator(`[data-testid="editor-tab"][aria-selected="true"][title$="${name}"]`);

async function open(page: Page, path: string) {
  await page.keyboard.press("Meta+3");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill(path);
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20000 });
  await page.keyboard.press("Enter");
  await tab(page, path.split("/").at(-1) ?? path).waitFor();
}

const pill = (page: Page) => page.getByTestId("language-pill");

async function ready(page: Page) {
  await page
    .locator('[data-testid="language-pill"]:is([data-kind="ready"], [data-kind="bundled"])')
    .waitFor({ timeout: 300000 });
}

/** Hovers until the server has indexed enough to answer with `text`. */
async function hover(page: Page, line: number, needle: string, text: RegExp, name: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const point = await pointOf(page, line, needle);
    await page.mouse.move(point.x - 40, point.y - 40);
    await page.waitForTimeout(200);
    await page.mouse.move(point.x, point.y);

    const shown = await page
      .locator(".cm-tooltip-hover")
      .filter({ hasText: text })
      .waitFor({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);

    if (shown) break;
  }

  await page.locator(".cm-tooltip-hover").filter({ hasText: text }).waitFor({ timeout: 1000 });
  await page.screenshot({ path: join(evidence, `${name}-hover.png`) });
  await page.mouse.move(5, 5);
}

async function definition(page: Page, line: number, needle: string, target: string, back: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const point = await pointOf(page, line, needle);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press("F12");

    const jumped = await tab(page, target)
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    if (jumped) break;
    await page.keyboard.press("Escape");
  }

  await tab(page, target).waitFor({ timeout: 1000 });
  await page.keyboard.press("Control+Minus");
  await tab(page, back).waitFor();
}

/** Phpactor checks a file on open and on edits, not when its first index ends: one edit, undone. */
async function nudge(page: Page) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" ");
  await page.keyboard.press("Backspace");
}

async function problems(page: Page, text: RegExp, name: string) {
  const region = page.getByRole("region", { name: "Problems" });

  for (let attempt = 0; attempt < 90; attempt++) {
    if (await region.isVisible())
      await region.getByRole("button", { name: "Close", exact: true }).click();
    await page.keyboard.press("Meta+Shift+M");
    await page.waitForTimeout(1000);

    if (await region.getByText(text).first().isVisible()) break;
  }

  await region.getByText(text).first().waitFor({ timeout: 1000 });
  await page.screenshot({ path: join(evidence, `${name}-diagnostics.png`) });
  await region.getByRole("button", { name: "Close", exact: true }).click();
}

/** ⌃Space after `typed` on a new line below `line`; the docs panel shows `docs`; then it goes. */
async function completion(page: Page, line: number, typed: string, docs: RegExp, name: string) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+ArrowUp");

  for (let down = 0; down < line; down++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.type(typed);
  await page.keyboard.press("Control+Space");
  await page.locator(".cm-tooltip-autocomplete").waitFor({ timeout: 30000 });
  await page.locator('[data-language-docs="panel"]').filter({ hasText: docs }).waitFor({
    timeout: 30000,
  });
  await page.screenshot({ path: join(evidence, `${name}-completion.png`) });
  await page.keyboard.press("Escape");

  for (let undo = 0; undo < 3; undo++) await page.keyboard.press("Meta+Z");
}

async function menu(page: Page, line: number, needle: string, name: string) {
  const point = await pointOf(page, line, needle);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const rows = page.getByRole("menu");
  await rows.waitFor();
  const text = await rows.innerText();
  await page.screenshot({ path: join(evidence, `${name}-menu.png`) });
  await page.keyboard.press("Escape");

  return text;
}

/** Types an unformatted line at the end, saves, and waits for the formatter's output on disk. */
async function formatOnSave(page: Page, path: string, messy: string, formatted: string) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(messy);
  await page.keyboard.press("Meta+S");

  for (
    const deadline = Date.now() + 60000;
    Date.now() < deadline && !readFileSync(join(project, path), "utf8").includes(formatted);
  )
    await page.waitForTimeout(200);
  assert(
    readFileSync(join(project, path), "utf8").includes(formatted),
    `${path} was not formatted on save:\n${readFileSync(join(project, path), "utf8")}`
  );
}

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

const result: Record<string, string> = {};

try {
  daemon = await startDaemon({ home, userHome, benchHarness: true });
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
    .waitFor({ timeout: 20000 });
  await page.evaluate(
    `window.polaris.request("dispatch", {hostKey: "local", commandId: crypto.randomUUID(), command: {_tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "go-php-proof"}})`
  );
  await page
    .getByRole("button", { name: /go-php-proof/ })
    .first()
    .click();

  // PHP before Trust: managed Phpactor, no project code.
  await open(page, "php/src/main.php");
  await ready(page);
  await page.getByTestId("trust-card").waitFor({ timeout: 60000 });
  result.trustCard = await page.getByTestId("trust-card").innerText();
  await page.screenshot({ path: join(evidence, "php-untrusted-trust-card.png") });
  await hover(page, 5, "greet(", /Says hello/, "php-untrusted");
  await definition(page, 5, "greet(", "Greeter.php", "main.php");
  await nudge(page);
  await problems(page, /Method "missing" does not exist/, "php-untrusted");
  await completion(page, 6, "$greeter->gr", /Says hello/, "php-untrusted");
  result.phpUntrustedMenu = await menu(page, 5, "greet(", "php-untrusted");
  assert.equal(existsSync(sentinel), false, "Composer files ran before Trust");
  console.log("PHP untrusted subset passed; no Composer file ran");

  // Go: gopls missing, the go install command, then Check again.
  await open(page, "go/main.go");
  await pill(page).filter({ hasText: "needs gopls" }).waitFor({ timeout: 120000 });
  await pill(page).click();
  await page
    .getByText("go install golang.org/x/tools/gopls@latest", { exact: true })
    .waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(evidence, "go-needs-gopls.png") });
  mkdirSync(join(userHome, "go/bin"), { recursive: true });
  copyFileSync(gopls, join(userHome, "go/bin/gopls"));
  chmodSync(join(userHome, "go/bin/gopls"), 0o755);
  await page.getByTestId("language-popover").getByText("Check again", { exact: true }).click();
  await pill(page).filter({ hasText: "needs Trust" }).waitFor({ timeout: 60000 });
  await page.screenshot({ path: join(evidence, "go-needs-trust.png") });
  await page.keyboard.press("Escape");
  console.log("gopls found by Check again; awaiting Trust");

  await page.getByTestId("trust-card").getByRole("button", { name: "Trust go-php-proof" }).click();
  await page.getByTestId("trust-card").waitFor({ state: "detached", timeout: 30000 });
  await ready(page);
  await hover(page, 5, "Greet(", /Greet says hello/, "go");
  await definition(page, 5, "Greet(", "greet.go", "main.go");
  await problems(page, /cannot use "text"/, "go");
  await completion(page, 7, "fmt.Pr", /Print\w* formats/, "go");
  result.goMenu = await menu(page, 5, "Greet(", "go");
  await formatOnSave(page, "go/main.go", "func  spare( ) {   }\n", "func spare() {}");
  console.log("Go hover, definition, diagnostics, completion and gofmt on save passed");

  // PHP after Trust: Composer, project config and php-cs-fixer.
  await open(page, "php/src/main.php");
  await ready(page);
  await hover(page, 5, "greet(", /Says hello/, "php-trusted");
  await nudge(page);
  await problems(page, /Method "missing" does not exist/, "php-trusted");
  result.phpTrustedMenu = await menu(page, 5, "greet(", "php-trusted");

  // Two PHP files, the second taller than the window: the status bar shows on both.
  for (const path of ["php/src/Long.php", "php/src/main.php"]) {
    await open(page, path);
    await assertStatusBarShown(page, path);
  }

  await formatOnSave(page, "php/src/main.php", "function  f( ){return 1;}\n", "function f()\n{");

  for (const deadline = Date.now() + 30000; Date.now() < deadline && !existsSync(sentinel);)
    await page.waitForTimeout(200);
  assert(existsSync(sentinel), "Composer class maps did not load after Trust");
  console.log("PHP after Trust: Composer loaded and php-cs-fixer formatted on save");

  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "Editor" }).first().click();
  await page.getByRole("switch", { name: "Go language tools" }).waitFor({ timeout: 30000 });
  await page.getByRole("switch", { name: "PHP language tools" }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(evidence, "settings.png"), fullPage: true });

  writeFileSync(
    join(evidence, "desktop.json"),
    JSON.stringify({ passed: true, ...result }, null, 2) + "\n"
  );
  console.log("PASS");
} catch (cause) {
  const page = await app?.firstWindow();

  if (page) {
    await page.screenshot({ path: join(evidence, "desktop-failure.png") });
    writeFileSync(join(evidence, "desktop-failure.txt"), await page.locator("body").innerText());
  }

  throw cause;
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
}
