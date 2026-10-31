/**
 * The Editor's language tools after the renderer reloads, on the Vite dev server as in
 * `bun run dev`: node apps/desktop/scripts/devReloadSmoke.ts (build first, for main). Opens a TypeScript file,
 * edits Editor modules (HMR), then reloads the window; each time the server must answer again.
 * POLARIS_EVIDENCE=<dir> keeps screenshots there, in both themes.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { createServer } from "vite";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  stockElectronBinary,
} from "./lib/electron.ts";
import { startDaemon } from "./lib/daemon.ts";

const PORT = 5297;

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-dev-reload-")));

const userData = join(profile, "user-data");

const evidence = process.env.POLARIS_EVIDENCE ?? null;

const file = "apps/desktop/vite.config.ts";

mkdirSync(userData);

if (evidence !== null) mkdirSync(evidence, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

const until = async (what: string, check: () => Promise<boolean>, seen: () => Promise<string>) => {
  for (const end = Date.now() + 120_000; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${what}`, { cause: await seen() });
};

const pill = (page: Page) => page.getByTestId("language-pill");

const pillText = async (page: Page) =>
  (await pill(page).count()) === 0
    ? "(no pill)"
    : `${await pill(page).getAttribute("data-kind")}: ${await pill(page).textContent()}`;

const popover = async (page: Page) => {
  if ((await page.getByTestId("language-popover").count()) === 0) await pill(page).click();
  await page.getByTestId("language-popover").waitFor({ timeout: 5_000 });
  const text = (await page.getByTestId("language-popover").textContent()) ?? "";
  await page.keyboard.press("Escape");

  return text;
};

/** The Host's language server answers for the file: the pill reads ready or bundled. */
const connected = async (page: Page, when: string) => {
  await until(
    `language tools ${when}`,
    async () => {
      const kind =
        (await pill(page).count()) === 0 ? "" : await pill(page).getAttribute("data-kind");

      return kind === "ready" || kind === "bundled";
    },
    async () => `${await pillText(page)} / ${await popover(page).catch(() => "")}`
  );
  const text = await popover(page);
  console.log(`${when}: ${await pillText(page)}`);
  assert.ok(!text.includes("once it's connected"), `${when}: ${text}`);
};

const shots = async (page: Page, name: string) => {
  if (evidence === null) return;

  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
    );
    await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
    await pill(page).click();
    await page.getByTestId("language-popover").waitFor({ timeout: 5_000 });
    await page.screenshot({ path: join(evidence, `${name}-${theme}.png`) });
    await page.keyboard.press("Escape");
  }
};

const openFile = async (page: Page) => {
  await page.keyboard.press("Meta+3");
  await page.getByTestId("explorer").waitFor({ timeout: 15_000 });

  if ((await page.locator(".cm-content").count()) > 0) return;

  for (const name of file.split("/"))
    await page
      .getByTestId("tree-row")
      .filter({ has: page.getByText(name, { exact: true }) })
      .first()
      .click({ timeout: 15_000 });
  await page.locator(".cm-content").first().waitFor({ timeout: 15_000 });
};

/** Appends a comment to an Editor module and puts it back: a Vite HMR update, as an edit makes. */
const touch = async (page: Page, module: string) => {
  const path = join(APP_DIR, "src/renderer/features/editor", module);
  const source = readFileSync(path, "utf8");

  try {
    writeFileSync(path, `${source}\n// dev reload smoke\n`);
    await page.waitForTimeout(1500);
  } finally {
    writeFileSync(path, source);
  }

  await page.waitForTimeout(1500);
};

const server = await createServer({
  configFile: join(APP_DIR, "vite.config.ts"),
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
});

const daemon = await startDaemon({ home: profile, benchHarness: true });

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  await server.listen();
  app = await electron.launch({
    executablePath: stockElectronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: `http://127.0.0.1:${PORT}/`,
      POLARIS_DESKTOP_DEV: "1",
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });
  app.process().stderr?.on("data", (chunk: Buffer) => {
    if (process.env.POLARIS_SMOKE_MAIN_LOG === "1") process.stderr.write(chunk);
  });
  const page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`console: ${message.text()}`);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 30_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(REPO_ROOT)}, name: "polaris" } })`
  );
  await openFile(page);
  await connected(page, "first open");
  await shots(page, "1-first-open");

  for (const module of ["lsp/bindings.ts", "lsp/integration.ts", "runtime/app.ts"]) {
    await touch(page, module);
    await page
      .locator('[data-host="local"][data-connection="connected"]')
      .waitFor({ timeout: 30_000 });
    await openFile(page);
    await connected(page, `after editing ${module}`);
  }

  await shots(page, "2-after-hmr");

  await page.reload();
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 30_000 });
  await openFile(page);
  await connected(page, "after a window reload");
  await shots(page, "3-after-reload");
  console.log("PASS");
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon.stop();
  await server.close();
  rmSync(profile, { recursive: true, force: true });
}
