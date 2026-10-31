/** Opt-in real Desktop acceptance: node apps/desktop/scripts/managedLanguageSmoke.ts (build first). */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
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
import { Schema } from "effect";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-managed-desktop-")));

const userData = join(home, "user-data");

const fresh = join(home, "fresh");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-1");

const source =
  'import { answer } from "./slice1-value";\nconst local = answer;\nconst bad: string = answer;\n';

const owned: string[] = [];

mkdirSync(userData);

mkdirSync(fresh);

mkdirSync(evidence, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

execFileSync("bun", ["init", "-y"], { cwd: fresh, stdio: "pipe" });

function fixtures(root: string) {
  const files = [
    ["slice1-acceptance.ts", source],
    ["slice1-value.ts", "export const answer = 42;\n"],
  ] satisfies ReadonlyArray<readonly [string, string]>;

  for (const [name, text] of files) {
    const path = join(root, name);
    assert.equal(existsSync(path), false, "Acceptance must never overwrite existing files");
    writeFileSync(path, text);
    owned.push(path);
  }
}

async function cursor(page: Page) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Meta+ArrowLeft");

  for (let i = 0; i < 16; i++) await page.keyboard.press("ArrowRight");
}

async function verify(page: Page, root: string, name: string) {
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(root)}, name: ${JSON.stringify(name)} } })`
  );
  await page
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  await page.keyboard.press("Meta+3");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill("slice1-acceptance");
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20_000 });
  await page.keyboard.press("Enter");

  const tab = page.locator(
    '[data-testid="editor-tab"][aria-selected="true"][title$="slice1-acceptance.ts"]'
  );

  await tab.waitFor({ timeout: 20_000 });
  await page
    .locator('[data-testid="language-pill"]:is([data-kind="ready"], [data-kind="bundled"])')
    .waitFor({ timeout: 180_000 });

  const point = Schema.decodeUnknownSync(Schema.Struct({ x: Schema.Number, y: Schema.Number }))(
    await page.evaluate(`(() => {
      const line = document.querySelectorAll('.cm-line')[1];
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let offset = 16;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset >= node.textContent.length) { offset -= node.textContent.length; continue; }
        const range = document.createRange();
        range.setStart(node, offset); range.setEnd(node, offset + 1);
        const box = range.getBoundingClientRect();
        return {x: box.x + box.width / 2, y: box.y + box.height / 2};
      }
    })()`)
  );

  await page.mouse.move(point.x, point.y);
  await page.locator(".cm-tooltip-hover").filter({ hasText: "42" }).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: join(evidence, `${name}-hover.png`) });
  await cursor(page);
  await page.keyboard.press("F12");
  await page
    .locator('[data-testid="editor-tab"][aria-selected="true"][title$="slice1-value.ts"]')
    .waitFor();
  await page.keyboard.press("Control+Minus");
  await tab.waitFor();
  await page.keyboard.press("Meta+Shift+M");
  await page
    .getByRole("region", { name: "Problems" })
    .getByText(/not assignable to type 'string'/)
    .waitFor({ timeout: 20_000 });
  await page.screenshot({ path: join(evidence, `${name}-diagnostics.png`) });
  await cursor(page);
  await page.keyboard.press("F2");
  await page.getByTestId("rename-field").getByLabel("New name").fill("renamedAnswer");
  await page.keyboard.press("Enter");
  const preview = page.getByTestId("refactor-preview");
  const changed = page.locator(".cm-content").filter({ hasText: "renamedAnswer" });

  const outcome = await Promise.race([
    preview
      .getByRole("button", { name: "Accept refactor" })
      .waitFor()
      .then(() => "preview"),
    changed.waitFor().then(() => "draft"),
  ]);

  if (outcome === "preview") {
    await preview.getByLabel("Draft text").filter({ hasText: "renamedAnswer" }).first().waitFor();
    await preview.getByRole("button", { name: "Accept refactor" }).click();
  }

  await page.locator(".cm-content").filter({ hasText: "renamedAnswer" }).waitFor();
  await page.screenshot({ path: join(evidence, `${name}-rename.png`) });
  assert.equal(
    readFileSync(join(root, "slice1-acceptance.ts"), "utf8"),
    source,
    "Rename remains a draft until Save"
  );
  assert.equal(existsSync(join(root, ".polaris/languages.json")), false);
  console.log(
    `${name}: diagnostics, hover, definition, rename accepted without language settings or Trust`
  );
}

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  fixtures(REPO_ROOT);
  fixtures(fresh);
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
  await verify(page, REPO_ROOT, "slice1-current-repo");
  await verify(page, fresh, "slice1-bun-init");
  writeFileSync(
    join(evidence, "desktop.json"),
    JSON.stringify(
      {
        passed: true,
        repositories: [REPO_ROOT, "fresh bun init"],
        features: ["hover", "diagnostics", "definition", "rename acceptance"],
        trusted: false,
      },
      null,
      2
    ) + "\n"
  );
} catch (cause) {
  const page = await app?.firstWindow();

  if (page) {
    await page.screenshot({ path: join(evidence, "failure.png") });
    writeFileSync(join(evidence, "failure.txt"), await page.locator("body").innerText());
  }

  throw cause;
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();

  for (const path of owned) rmSync(path, { force: true });
  rmSync(home, { recursive: true, force: true });
}
