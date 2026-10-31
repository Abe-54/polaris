#!/usr/bin/env node
/**
 * Right-click menus (DESIGN.md, Menus; Paper M1–M5) on a real Daemon with bench sessions:
 * each surface's menu opens with the expected items, screenshotted in both themes.
 *
 *   node scripts/menuSmoke.ts --out <dir> [--build]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { type Locator, type Page } from "playwright-core";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { startDaemon } from "./lib/daemon.ts";
import { seedSource } from "./lib/seed.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const home = mkdtempSync(join(tmpdir(), "polaris-menus-"));

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const failures: Array<string> = [];

const pbpaste = () => execFileSync("pbpaste", { encoding: "utf8" });

const pbcopy = (text: string) => execFileSync("pbcopy", { input: text });

// The actions below use the real clipboard: keep what was there and put it back at the end.
const kept = pbpaste();

/** Right-clicks the target and chooses a row by its label. */
const choose = async (page: Page, target: Locator, menu: string, label: string) => {
  await target.click({ button: "right" });
  await page.getByTestId(menu).getByRole("menuitem", { name: label, exact: false }).first().click();
  await page.getByTestId(menu).waitFor({ state: "detached" });
  await page.waitForTimeout(300);
};

const expectEqual = (what: string, actual: string, expected: string) => {
  if (actual !== expected) failures.push(`${what}: ${JSON.stringify(actual)}`);
  else console.log(`menus: ${what}`);
};

const theme = async (page: Page, name: string) => {
  await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${name}" })`);
  await page.locator(`html[data-theme="${name}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(250);
};

/** Each row's label and its shortcut lane, "Approve ⇧⌘A", one per row; "—" for a separator. */
const menuRows = async (menu: Locator) => {
  const rows: Array<string> = [];

  for (const el of await menu.locator('[role="menuitem"], [role="separator"]').all()) {
    if ((await el.getAttribute("role")) === "separator") {
      rows.push("—");
      continue;
    }

    const label = (await el.locator("span").first().textContent()) ?? "";
    const lane = el.locator("kbd");
    const shortcut = (await lane.count()) > 0 ? await lane.first().textContent() : null;

    rows.push(shortcut === null ? label : `${label} ${shortcut}`);
  }

  return rows;
};

export interface MenuCheck {
  readonly name: string;
  readonly target: (page: Page) => Locator;
  readonly menu: string;
  readonly expected: ReadonlyArray<string>;
}

/** Right-clicks the target in each theme, compares its rows, and screenshots it. */
const check = async (page: Page, c: MenuCheck) => {
  for (const name of ["dark", "light"]) {
    await theme(page, name);
    await c.target(page).click({ button: "right" });
    const menu = page.getByTestId(c.menu);

    await menu.waitFor();
    await page.waitForTimeout(200);
    const rows = await menuRows(menu);

    if (JSON.stringify(rows) !== JSON.stringify(c.expected))
      failures.push(`${c.name} (${name}): ${JSON.stringify(rows)}`);
    await page.screenshot({ path: join(out, `${c.name}-${name}.png`) });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
  }

  console.log(`menus: ${c.name}`);
};

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });

const row = (title: string) => (page: Page) =>
  sidebar(page).locator("[data-session-row]", { hasText: title }).first();

const chip = (name: string) => (page: Page) =>
  page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: new RegExp(name) });

try {
  const page = await app.firstWindow();

  page.on("pageerror", (error) => {
    console.error(`menus: page error ${String(error)}`);
    failures.push(String(error));
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });

  await page.evaluate(
    seedSource([
      {
        hostKey: "local",
        name: "polaris",
        sessions: [
          { title: "Glossary first pass", state: "idle" },
          { title: "Spike GPUI review screen", state: "needs-you" },
          {
            title: "Transcript menus",
            state: "idle",
            prompt: `bench:${JSON.stringify({ items: 5, deltasPerItem: 1, deltaIntervalMs: 1 })}`,
          },
        ],
      },
    ])
  );
  await row("Glossary first pass")(page).waitFor();
  await row("Spike GPUI review screen")(page).waitFor();
  await page.waitForTimeout(1500);
  await row("Glossary first pass")(page).click();

  await check(page, {
    name: "session-row",
    target: row("Glossary first pass"),
    menu: "session-context-menu",
    expected: [
      "Open ↵",
      "Open in Review",
      "Open in terminal",
      "Rename…",
      "Fork…",
      "Pin",
      "—",
      "Archive",
      "—",
      "Copy session ID",
    ],
  });

  // ⇧F10 opens the focused row's menu, as the menu key does.
  await row("Glossary first pass")(page).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByTestId("session-context-menu").waitFor();
  console.log("menus: shift-f10");
  await page.keyboard.press("Escape");

  await check(page, {
    name: "workspace-chip",
    target: chip("polaris"),
    menu: "workspace-context-menu",
    expected: [
      "New session ⌘N",
      "Open in Edit ⌘3",
      "Open terminal here",
      "—",
      "Copy path",
      "Reveal in Finder",
    ],
  });

  await check(page, {
    name: "host-label",
    target: (p) => p.getByRole("navigation", { name: "Workspaces" }).locator("[data-host]").first(),
    menu: "host-context-menu",
    expected: ["New session on This Mac…", "—", "Host details"],
  });

  await row("Transcript menus")(page).click();
  await page.getByTestId("command").first().waitFor();
  await page.waitForTimeout(500);

  const item = (kind: string) => (p: Page) =>
    p.locator(`[data-testid="turn-item"][data-kind="${kind}"]`).first();

  await check(page, {
    name: "transcript-prompt",
    target: (p) => p.getByTestId("prompt").first().locator("p"),
    menu: "prompt-menu",
    expected: ["Copy prompt", "—", "Fold turn"],
  });
  await check(page, {
    name: "transcript-message",
    target: item("message"),
    menu: "turn-menu",
    expected: ["Copy message"],
  });
  await check(page, {
    name: "transcript-command",
    target: (p) => p.getByTestId("command").first(),
    menu: "turn-menu",
    expected: ["Copy command", "Copy output", "—", "Copy turn output"],
  });
  await check(page, {
    name: "transcript-tool",
    target: (p) => p.getByTestId("tool-call").first(),
    menu: "turn-menu",
    expected: ["Copy turn output"],
  });
  await check(page, {
    name: "transcript-file",
    target: (p) => p.getByTestId("file-change").locator("[data-menu-path]").first(),
    menu: "turn-menu",
    expected: [
      "Open in Editor",
      "Open diff",
      "—",
      "Copy path",
      "Reveal in file tree",
      "—",
      "Copy turn output",
    ],
  });
  await check(page, {
    name: "composer",
    target: (p) => p.locator("[contenteditable]").first(),
    menu: "composer-menu",
    expected: ["Cut ⌘X", "Copy ⌘C", "Paste ⌘V", "Select all ⌘A", "—", "Attach files…"],
  });

  // What the rows do: Copy path writes the file's absolute path; the composer's edits run in main.
  await choose(
    page,
    page.getByTestId("file-change").locator("[data-menu-path]").first(),
    "turn-menu",
    "Copy path"
  );
  expectEqual("copy path", pbpaste().replace(/^.*\/polaris-proof-[^/]+\//, ""), "src/index.ts");

  const composer = page.locator("[contenteditable]").first();

  pbcopy("pasted from the menu");
  await choose(page, composer, "composer-menu", "Paste");
  expectEqual("composer paste", (await composer.innerText()).trim(), "pasted from the menu");
  await choose(page, composer, "composer-menu", "Select all");
  await choose(page, composer, "composer-menu", "Cut");
  expectEqual(
    "composer cut",
    `${(await composer.innerText()).trim()}|${pbpaste()}`,
    "|pasted from the menu"
  );

  await page.keyboard.press("Control+Backquote");
  await page.getByTestId("terminal-surface").waitFor();
  await page.waitForTimeout(1500);
  await check(page, {
    name: "terminal",
    target: (p) => p.getByTestId("terminal-surface"),
    menu: "terminal-menu",
    expected: ["Copy ⌘C", "Paste ⌘V", "Select all ⌘A", "—", "Clear", "—", "Close terminal"],
  });
  await check(page, {
    name: "terminal-tab",
    target: (p) => p.getByTestId("terminal-tab").first(),
    menu: "terminal-tab-menu",
    expected: ["New terminal", "—", "Close terminal"],
  });
  await page.keyboard.press("Control+Backquote");

  // Edit: a git Workspace with a commit, one change and one new file.
  await choose(page, chip("polaris")(page), "workspace-context-menu", "Copy path");
  const root = pbpaste();

  const git = (...argv: Array<string>) =>
    execFileSync(
      "git",
      ["-c", "user.name=Polaris", "-c", "user.email=smoke@polaris.dev", ...argv],
      {
        cwd: root,
      }
    );

  for (const name of ["alpha.ts", "beta.ts", "gamma.ts"])
    writeFileSync(join(root, name), `export const ${name.slice(0, -3)} = 1;\n`);
  git("init", "-q");
  git("add", "alpha.ts", "beta.ts", "gamma.ts");
  git("commit", "-qm", "seed");
  writeFileSync(join(root, "alpha.ts"), "export const alpha = 2;\n");
  writeFileSync(join(root, "fresh.ts"), "export const fresh = 1;\n");

  await page.keyboard.press("Meta+3");

  const treeRow = (name: string) => (p: Page) =>
    p.locator(`[data-testid="tree-row"][data-path$="/${name}"]`).first();

  await treeRow("alpha.ts")(page).waitFor();
  await treeRow("alpha.ts")(page).dblclick();
  await treeRow("beta.ts")(page).dblclick();
  await page.getByTestId("editor-tab").nth(1).waitFor();

  await check(page, {
    name: "editor-tab",
    target: (p) => p.getByTestId("editor-tab").last(),
    menu: "editor-tab-menu",
    expected: [
      "Close ⌘W",
      "Close others ⌥⌘T",
      "Close saved",
      "—",
      "Copy path",
      "Copy relative path",
      "Reveal in file tree",
      "Reveal in Finder",
    ],
  });
  await check(page, {
    name: "editor-tab-inactive",
    target: (p) => p.getByTestId("editor-tab").first(),
    menu: "editor-tab-menu",
    expected: [
      "Close",
      "Close others",
      "Close to the right",
      "Close saved",
      "—",
      "Copy path",
      "Copy relative path",
      "Reveal in file tree",
      "Reveal in Finder",
    ],
  });
  await check(page, {
    name: "explorer-row",
    target: treeRow("gamma.ts"),
    menu: "explorer-menu",
    expected: [
      "New file…",
      "New folder…",
      "—",
      "Copy path",
      "Copy relative path",
      "Reveal in Finder",
      "—",
      "Rename… F2",
      "Delete ⌘⌫",
    ],
  });

  await page.getByRole("radio", { name: /Changes/ }).click();

  const stageRow = (side: string, name: string) => (p: Page) =>
    p.getByTestId(`${side}-row`).filter({ hasText: name }).first();

  await stageRow("unstaged", "alpha.ts")(page).waitFor();
  await check(page, {
    name: "changes-row",
    target: stageRow("unstaged", "alpha.ts"),
    menu: "stage-row-menu",
    expected: [
      "Open file",
      "—",
      "Stage",
      "Stage all",
      "—",
      "Copy path",
      "Reveal in file tree",
      "—",
      "Discard changes…",
    ],
  });
  await check(page, {
    name: "changes-row-untracked",
    target: stageRow("unstaged", "fresh.ts"),
    menu: "stage-row-menu",
    expected: [
      "Open file",
      "—",
      "Stage",
      "Stage all",
      "—",
      "Copy path",
      "Reveal in file tree",
      "—",
      "Move to Trash…",
    ],
  });

  // Discard changes… asks first: its popover opens with Cancel focused.
  await choose(page, stageRow("unstaged", "alpha.ts")(page), "stage-row-menu", "Discard changes…");
  await page.getByTestId("confirm-discard").waitFor();
  expectEqual("discard asks", await page.locator(":focus").innerText(), "Cancel");
  await page.keyboard.press("Escape");

  await choose(page, stageRow("unstaged", "alpha.ts")(page), "stage-row-menu", "Stage");
  await stageRow("staged", "alpha.ts")(page).waitFor();
  await check(page, {
    name: "changes-row-staged",
    target: stageRow("staged", "alpha.ts"),
    menu: "stage-row-menu",
    expected: ["Open file", "—", "Unstage", "Unstage all", "—", "Copy path", "Reveal in file tree"],
  });

  await choose(
    page,
    page.getByTestId("editor-tab").first(),
    "editor-tab-menu",
    "Close to the right"
  );
  expectEqual("close to the right", String(await page.getByTestId("editor-tab").count()), "1");
  await page.keyboard.press("Meta+1");

  await sidebar(page)
    .getByRole("radio", { name: /Needs you/ })
    .click();
  await check(page, {
    name: "needs-you-card",
    target: (p) => p.getByTestId("needs-you-card").first(),
    menu: "needs-you-context-menu",
    expected: [
      "Open session",
      "—",
      "Approve",
      "Always allow",
      "Deny",
      "—",
      "Dismiss on this Mac",
      "Archive session",
    ],
  });

  await page.evaluate(`location.hash = "#constellations/sidebar"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("worker-row").first().waitFor();
  await check(page, {
    name: "worker-row",
    target: (p) => p.getByTestId("worker-row").first(),
    menu: "worker-context-menu",
    expected: [
      "Focus worktree-setup-retry-on-reconnect",
      "Open in Review",
      "—",
      "Message the lead about this",
      "Copy task ID",
    ],
  });

  // Review on fixtures: a file's header and list row, a finding in the risk column and the diff.
  await page.evaluate(`location.hash = "#review/pull"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("risk-finding").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  await check(page, {
    name: "review-file",
    target: (p) => p.getByTestId("review-file").first().locator("span.font-mono").first(),
    menu: "review-file-menu",
    expected: ["Mark as viewed", "Collapse", "—", "Open in Editor", "Copy path"],
  });
  await check(page, {
    name: "review-file-row",
    target: (p) => p.getByTestId("review-file-row").first(),
    menu: "review-file-menu",
    expected: ["Mark as viewed", "—", "Open in Editor", "Copy path"],
  });
  await check(page, {
    name: "risk-finding",
    target: (p) => p.getByTestId("risk-finding").first(),
    menu: "finding-menu",
    expected: [
      "Comment on this…",
      "Ask about this…",
      "—",
      "Helpful",
      "Not helpful…",
      "—",
      "Copy finding",
    ],
  });

  const inDiff = page.getByTestId("finding-row").first();

  if ((await inDiff.count()) > 0)
    await check(page, {
      name: "finding-row",
      target: () => inDiff,
      menu: "finding-menu",
      expected: ["Comment on this…", "Ask about this…", "—", "Copy finding"],
    });

  await choose(page, page.getByTestId("risk-finding").first(), "finding-menu", "Copy finding");
  expectEqual(
    "copy finding",
    pbpaste().split("\n")[0] ?? "",
    "API client still sends monthly income"
  );
  await choose(page, page.getByTestId("risk-finding").first(), "finding-menu", "Not helpful…");
  await page.getByRole("button", { name: "Save verdict" }).waitFor();
  console.log("menus: not helpful asks");
  await page.screenshot({ path: join(out, "finding-not-helpful.png") });
  await page.keyboard.press("Escape");

  await page.evaluate(`location.hash = "#constellation/menu"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("constellation-tab").waitFor();
  await check(page, {
    name: "task-row",
    target: (p) =>
      p.getByRole("button", { name: "B1 actions" }).locator("xpath=ancestor::div[@data-index]"),
    menu: "task-context-menu",
    expected: [
      "Approve",
      "Accept… A",
      "Send back… S",
      "—",
      "Open in Review",
      "Focus B1 ↵",
      "Message the lead about this",
      "Copy task ID",
    ],
  });
} finally {
  pbcopy(kept);
  await app.close();
  await daemon.stop();
}

if (failures.length > 0) {
  console.error(`menus: ${failures.length} failed\n${failures.join("\n")}`);
  process.exit(1);
}

console.log("menus: ok");
