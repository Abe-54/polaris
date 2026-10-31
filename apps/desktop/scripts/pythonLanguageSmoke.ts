/** Opt-in real Python acceptance: node apps/desktop/scripts/pythonLanguageSmoke.ts (build first). */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-python-desktop-")));

const userData = join(home, "user-data");

const project = join(home, "project");

const missing = join(home, "missing");

const probeRoot = join(home, "no-host-python");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-5");

const source = "import os\nfrom value import answer\nbad: str = answer()\nresult=answer()\n";

for (const path of [userData, project, missing, probeRoot, evidence])
  mkdirSync(path, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

execFileSync("uv", ["init", "--bare", "--python", "/usr/bin/python3", "--no-python-downloads"], {
  cwd: project,
  stdio: "pipe",
});

execFileSync("uv", ["venv", "--python", "/usr/bin/python3", "--no-python-downloads"], {
  cwd: project,
  stdio: "pipe",
});

execFileSync("uv", ["lock", "--offline", "--no-python-downloads"], { cwd: project, stdio: "pipe" });

writeFileSync(join(project, "proof.py"), source);

writeFileSync(join(project, "value.py"), "def answer() -> int:\n    return 42\n");

writeFileSync(join(missing, "proof.py"), "value = 1\n");

async function open(page: Page, root: string, name: string) {
  await page.evaluate(
    `window.polaris.request("dispatch", {hostKey: "local", commandId: crypto.randomUUID(), command: {_tag: "RegisterWorkspace", path: ${JSON.stringify(root)}, name: ${JSON.stringify(name)}}})`
  );
  await page
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  await page.keyboard.press("Meta+3");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill("proof.py");
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20000 });
  await page.keyboard.press("Enter");
  await page
    .locator('[data-testid="editor-tab"][aria-selected="true"][title$="proof.py"]')
    .waitFor();
}

async function cursor(page: Page) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+ArrowUp");

  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Meta+ArrowLeft");

  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
}

async function everyLook(page: Page, name: string, popover = false) {
  for (const theme of ["dark", "light"])
    for (const density of ["calm", "balanced", "compact"]) {
      await page.evaluate(
        `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}" } })`
      );
      await page
        .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
        .waitFor({ state: "attached" });

      if (popover && (await page.getByTestId("language-popover").count()) === 0)
        await page.getByTestId("language-pill").click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(evidence, `${name}-${theme}-${density}.png`) });
    }
}

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  daemon = await startDaemon({
    home,
    benchHarness: true,
    env: { POLARIS_LANGUAGE_PYTHON_PROBE_ROOT: probeRoot },
  });
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
  await open(page, project, "python-uv-proof");
  await page
    .locator('[data-testid="language-pill"][data-kind="ready"]')
    .waitFor({ timeout: 180000 });
  console.log("Python ready");

  const point = Schema.decodeUnknownSync(Schema.Struct({ x: Schema.Number, y: Schema.Number }))(
    await page.evaluate(`(() => {
    const walker = document.createTreeWalker(document.querySelectorAll('.cm-line')[3], NodeFilter.SHOW_TEXT);
    let offset = 9;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (offset >= node.textContent.length) {offset -= node.textContent.length; continue;}
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
      const box = range.getBoundingClientRect(); return {x: box.x + box.width / 2, y: box.y + box.height / 2};
    }
  })()`)
  );

  await page.mouse.move(point.x, point.y);
  await page.locator(".cm-tooltip-hover").filter({ hasText: "int" }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(evidence, "python-hover.png") });
  await cursor(page);
  await page.keyboard.press("F12");
  await page
    .locator('[data-testid="editor-tab"][aria-selected="true"][title$="value.py"]')
    .waitFor();
  await page.keyboard.press("Control+Minus");
  await page
    .locator('[data-testid="editor-tab"][aria-selected="true"][title$="proof.py"]')
    .waitFor();
  await page.keyboard.press("Meta+Shift+M");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByText(/not assignable/).waitFor({ timeout: 20000 });
  await problems.getByText(/imported but unused/).waitFor({ timeout: 20000 });
  assert.match(await problems.innerText(), /basedpyright/);
  assert.match(await problems.innerText(), /ruff/);
  await page.screenshot({ path: join(evidence, "python-diagnostics.png") });
  await cursor(page);
  await page.keyboard.press("F2");
  await page.getByTestId("rename-field").getByLabel("New name").fill("renamedAnswer");
  await page.keyboard.press("Enter");
  const preview = page.getByTestId("rename-preview");
  const changed = page.locator(".cm-content").filter({ hasText: "renamedAnswer" });

  const outcome = await Promise.race([
    preview
      .getByRole("button", { name: "Rename in 2 files" })
      .waitFor()
      .then(() => "preview"),
    changed.waitFor().then(() => "draft"),
  ]);

  if (outcome === "preview")
    await preview.getByRole("button", { name: "Rename in 2 files" }).click();
  await changed.waitFor();
  assert.equal(readFileSync(join(project, "proof.py"), "utf8"), source, "Rename remains unsaved");
  await page.screenshot({ path: join(evidence, "python-rename.png") });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+s");
  await page.waitForFunction(
    `() => !document.querySelector('[data-testid="editor-tab"][aria-selected="true"]')?.textContent.includes('●')`
  );

  for (
    const deadline = Date.now() + 15000;
    Date.now() < deadline &&
    !readFileSync(join(project, "proof.py"), "utf8").includes("result = renamedAnswer()");
  )
    await page.waitForTimeout(100);
  assert.match(readFileSync(join(project, "proof.py"), "utf8"), /result = renamedAnswer\(\)/);
  console.log("Hover, both diagnostics, definition, rename and Ruff save formatting passed");
  assert.equal(await page.getByTestId("trust-card").count(), 0);
  await open(page, missing, "python-missing-proof");
  await page
    .getByTestId("language-pill")
    .filter({ hasText: "Python · needs Python" })
    .waitFor({ timeout: 60000 });
  await page.getByTestId("language-pill").click();
  await page.getByText("uv python install 3.13", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "python-needs-python.png") });
  await everyLook(page, "needs-python", true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "Editor" }).first().click();
  await page.getByRole("switch", { name: "Python language tools" }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(evidence, "python-settings.png") });
  await everyLook(page, "settings");
  writeFileSync(
    join(evidence, "desktop.json"),
    JSON.stringify(
      {
        passed: true,
        fixture: "uv init/venv/lock using existing Host Python; no downloads",
        features: [
          "hover",
          "labelled type and lint diagnostics",
          "definition",
          "rename draft",
          "Ruff format on save",
          "needs Python with install command",
          "Settings Python row",
        ],
        trusted: false,
      },
      null,
      2
    ) + "\n"
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
