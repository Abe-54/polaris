/**
 * The Command Palette in the real app on an isolated profile: node apps/desktop/scripts/paletteSmoke.ts
 * (build first). ⇧⌘P opens; restart the server from the palette and with ⌥⌘R; Trust, revoke and
 * ask again; bundled then project TypeScript; ⌘K lists no commands; both themes, three densities.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import * as P from "@polaris/protocol";
import { Schema } from "effect";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  stockElectronBinary,
} from "./lib/electron.ts";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-palette-")));

const userData = join(profile, "user-data");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-4a");

const name = "palette-acceptance.ts";

const path = join(REPO_ROOT, name);

const unformattedName = "palette-format-acceptance.ts";

const unformatted = join(REPO_ROOT, unformattedName);

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

assert.equal(existsSync(path), false, "Never overwrite an existing file");

assert.equal(existsSync(unformatted), false, "Never overwrite an existing file");

mkdirSync(userData);

mkdirSync(evidence, { recursive: true });

writeFileSync(unformatted, messy);

writeFileSync(path, "export const value: string = 123;\nexport const other = value;\n");

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

const call = async <S extends Schema.ConstraintDecoder<unknown>>(
  page: Page,
  method: string,
  input: typeof Schema.JsonObject.Type,
  schema: S
): Promise<S["Type"]> =>
  Schema.decodeUnknownSync(schema)(
    await page.evaluate(`(async () => {
  const result = await window.polaris.languages.request(${JSON.stringify(method)}, ${JSON.stringify({ hostKey: "local", ...input })});
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
})()`)
  );

const until = async (what: string, check: () => Promise<boolean>, ms = 90_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${what}`);
};

/** The language server processes under the Daemon: their pids change when a server restarts. */
const serverPids = (): ReadonlyArray<number> => {
  const root = daemon?.pid;

  if (root === undefined) return [];
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout;

  const rows = ps.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);

    return match === null
      ? []
      : [{ pid: Number(match[1]), ppid: Number(match[2]), cmd: match[3] ?? "" }];
  });

  const under = new Set([root]);

  for (let grew = true; grew;) {
    grew = false;

    for (const row of rows) {
      if (!under.has(row.pid) && under.has(row.ppid)) {
        under.add(row.pid);
        grew = true;
      }
    }
  }

  return rows
    .filter((r) => under.has(r.pid) && /typescript-language-server|tsserver|--lsp/.test(r.cmd))
    .map((r) => r.pid)
    .toSorted((a, b) => a - b);
};

const restartedSince = async (before: ReadonlyArray<number>, what: string) => {
  await until(what, async () => {
    const now = serverPids();

    return now.length > 0 && !now.some((pid) => before.includes(pid));
  });
};

const launch = async () => {
  if (daemon === undefined) throw new Error("Daemon missing");
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

  return page;
};

const palette = (page: Page) => page.getByTestId("command-palette");

const field = (page: Page) => page.getByTestId("palette-input");

const openPalette = async (page: Page) => {
  await page.keyboard.press("Meta+Shift+P");
  await palette(page).waitFor({ timeout: 10_000 });
};

/** Opens the palette, types the query and runs the first row; returns its title. */
const runFromPalette = async (page: Page, query: string, expected: string) => {
  await openPalette(page);
  await field(page).fill(query);

  const first = page.locator('[data-testid="palette-row"][data-selected="true"]');

  await until(
    `"${expected}" highlighted`,
    async () => (await first.textContent())?.startsWith(expected) ?? false
  );
  await page.keyboard.press("Enter");
};

const choose = async (page: Page, title: string) => {
  const row = page.getByTestId("palette-row").filter({ hasText: title });

  await row.waitFor({ timeout: 10_000 });
  await row.click();
  await palette(page).waitFor({ state: "detached", timeout: 10_000 });
};

const appearance = async (page: Page, theme: string, density: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

try {
  daemon = await startDaemon({ home: profile, benchHarness: true });
  const page = await launch();

  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(REPO_ROOT)}, name: "polaris" } })`
  );

  const workspaceId = Schema.decodeUnknownSync(P.WorkspaceId)(
    await page.evaluate(`new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); reject(new Error("Workspace snapshot deadline")); }, 20000);
    stop = window.polaris.subscribe("host", { hostKey: "local" }, { items: (items) => {
      const snapshot = items.find(item => item._tag === "Snapshot");
      const registered = items.filter(item => item._tag === "Event" && item.envelope.event._tag === "WorkspaceRegistered").map(item => item.envelope.event.workspace);
      const workspace = [...(snapshot?.workspaces ?? []), ...registered].find(workspace => workspace.path === ${JSON.stringify(REPO_ROOT)});
      if (workspace) { clearTimeout(timer); stop(); resolve(workspace.id); }
    } });
  })`)
  );

  const inspectInput = {
    checkout: P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: REPO_ROOT }),
    path,
  };

  const inspect = () => call(page, "languages.trust.inspect", inspectInput, P.LanguageTrustStatus);

  // ⌘K is navigation only: no commands, even when searched for.
  await page.keyboard.press("Meta+K");
  await page.getByPlaceholder("Jump to a session or workspace").waitFor({ timeout: 10_000 });
  await page.keyboard.type("polaris");
  await page.getByTestId("jump-item").first().waitFor({ timeout: 10_000 });
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("settings");
  await page.waitForTimeout(300);
  // Navigation may still match (a Worktree branch named …-settings); no command row may.
  const jumpRows = await page.getByTestId("jump-item").allTextContents();

  assert.equal(jumpRows.filter((t) => /^Settings|Check for updates|Toggle/.test(t)).length, 0);
  assert.equal(await page.getByText("Actions", { exact: true }).count(), 0);
  await page.screenshot({ path: join(evidence, "jump-no-commands-dark.png") });
  await page.keyboard.press("Escape");
  console.log("⌘K lists no commands");

  // Open the TypeScript file in Edit.
  await page.keyboard.press("Meta+3");
  await page.getByTestId("explorer").waitFor({ timeout: 15_000 });
  await page
    .getByTestId("tree-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click({ timeout: 15_000 });
  await page.locator(".cm-content").first().waitFor({ timeout: 15_000 });
  await page.getByTestId("trust-card").waitFor({ timeout: 60_000 });
  await until("a running TypeScript server", async () => serverPids().length > 0);

  await openPalette(page);
  assert.equal(
    await page.evaluate<string | undefined>("document.activeElement?.dataset.testid"),
    "palette-input"
  );

  // The jump menu's scrim covers everything behind the palette, the Trust card included.
  await page.waitForTimeout(400);
  assert.equal(
    await page.evaluate<string | undefined>(`(() => {
      const card = document.querySelector('[data-testid="trust-card"]').getBoundingClientRect();
      return document.elementFromPoint(card.x + card.width - 40, card.y + card.height - 20)?.dataset.slot;
    })()`),
    "dialog-overlay"
  );

  for (const theme of ["dark", "light"]) {
    for (const density of ["calm", "balanced", "compact"]) {
      await appearance(page, theme, density);
      await page.screenshot({ path: join(evidence, `palette-${theme}-${density}.png`) });
    }
  }

  await appearance(page, "dark", "calm");
  await page.keyboard.press("Escape");
  await palette(page).waitFor({ state: "detached" });
  console.log("⇧⌘P opens the palette; screenshots in both themes and three densities");

  let before = serverPids();
  await runFromPalette(page, "restart typescript", "Restart TypeScript server");
  await restartedSince(before, "restart from the palette");
  console.log("Palette: Restart TypeScript server restarted it");

  before = serverPids();
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Meta+Alt+R");
  await restartedSince(before, "restart with ⌥⌘R");
  console.log("⌥⌘R restarted it");

  await openPalette(page);
  await page.screenshot({ path: join(evidence, "palette-recent-dark.png") });
  assert.match(
    (await page.getByTestId("palette-row").first().textContent()) ?? "",
    /^Restart TypeScript server/
  );
  await page.keyboard.press("Escape");
  console.log("Recent leads with the restart");

  // Trust round trip: Trust…, Revoke, Ask again.
  await runFromPalette(page, "trust polaris", "Trust polaris…");
  await field(page).waitFor();
  assert.equal(await field(page).getAttribute("placeholder"), "Run polaris's own TypeScript?");
  await page.screenshot({ path: join(evidence, "palette-trust-follow-up-dark.png") });
  await choose(page, "Trust polaris");
  await until("trusted", async () => (await inspect()).trust.decision === "trusted");
  await page.getByTestId("trust-card").waitFor({ state: "detached", timeout: 15_000 });
  console.log("Trust polaris… trusted it");

  await runFromPalette(page, "revoke", "Revoke trust in polaris");
  await until("declined", async () => (await inspect()).trust.decision === "declined");
  console.log("Revoke trust declined it");

  await runFromPalette(page, "ask about trust", "Ask about trust again");
  await until("undecided", async () => (await inspect()).trust.decision === "undecided");
  await page.getByTestId("trust-card").waitFor({ timeout: 15_000 });
  console.log("Ask about trust again brought the card back");

  // TypeScript version: bundled, then project (which needs Trust).
  await runFromPalette(page, "trust polaris", "Trust polaris…");
  await choose(page, "Trust polaris");
  await until("trusted again", async () => (await inspect()).trust.decision === "trusted");

  await runFromPalette(page, "typescript version", "Select TypeScript version…");
  await page.screenshot({ path: join(evidence, "palette-typescript-version-dark.png") });
  await choose(page, "Use the bundled TypeScript");
  await until("bundled", async () => (await inspect()).provider === "bundled");
  console.log("Selected the bundled TypeScript");

  await appearance(page, "light", "calm");
  await runFromPalette(page, "typescript version", "Select TypeScript version…");
  await page.screenshot({ path: join(evidence, "palette-typescript-version-light.png") });
  await choose(page, "Use the project's TypeScript");
  await until("project", async () => (await inspect()).provider === "project");
  console.log("Selected the project's TypeScript");

  // After the Trust round trip, a newly opened file still reaches ready (the stale-observation
  // and stopped-context fixes), and Format document (⇧⌥F) keeps its 2-space indentation.
  await page
    .getByTestId("tree-row")
    .filter({ has: page.getByText(unformattedName, { exact: true }) })
    .click({ timeout: 15_000 });

  const code = page.locator(".cm-content").first();

  const shown = () =>
    page.evaluate<string>(`document.querySelector(".cm-content")?.innerText ?? ""`);

  await until("the messy file", async () => (await shown()).includes("return   42"));
  // The palette reads the moment it opens: reopen until the server offers formatting.
  await until("Format document offered", async () => {
    await openPalette(page);
    await field(page).fill("format document");
    await page.waitForTimeout(200);

    const offered =
      (await page.getByTestId("palette-row").filter({ hasText: "Format document" }).count()) > 0;

    await page.keyboard.press("Escape");
    await palette(page).waitFor({ state: "detached" });

    return offered;
  });

  await code.click();
  await page.keyboard.press("Shift+Alt+F");
  await until("formatted text", async () => /\n {4}return 42/.test(await shown()));
  await page.screenshot({ path: join(evidence, "format-document-light.png") });

  const formatted = await shown();

  assert.match(formatted, /\n {2}if \(true\) \{\n {4}return 42;?\n {2}\}/);
  assert.doesNotMatch(formatted, /\n {5,}\S/);

  await page.keyboard.press("Meta+Z");
  await until("undo restores the messy text", async () => (await shown()).includes("return   42"));
  await page.keyboard.press("Meta+Shift+Z");
  await until("redo reapplies it", async () => (await shown()) === formatted);
  console.log("Opened after the Trust round trip; ⇧⌥F kept 2-space indent; one ⌘Z undid it");

  console.log("PASS: Command Palette acceptance");
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(path, { force: true });
  rmSync(unformatted, { force: true });
  rmSync(profile, { recursive: true, force: true });
}
