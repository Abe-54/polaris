#!/usr/bin/env node
/**
 * The Editor's budgets (spec §7) and behaviour on the `#editor/...` preview
 * (in-memory files, no Daemon; the Daemon's read cost is M3-FILES' `editor`
 * bench scenario):
 *  - opening a 1 MB file: renderer time from openFile to the first painted lines;
 *  - typing: each key paints on the display's next frame, with about 1 ms of work per key,
 *    in a small and the 1 MB file, with and without vim (key-to-paint ms is a diagnostic);
 *  - 20 open tabs: the app's memory against an empty editor;
 *  - ⌘S and vim's :w save, and ⌘S still saves from vim's insert mode.
 *
 *   node scripts/editorBench.ts [--build] [--json <path>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Page } from "playwright-core";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { takeScriptLease } from "../../../tooling/leases.ts";

await takeScriptLease("bench");

const args = process.argv.slice(2);

const jsonAt = args.indexOf("--json");

const jsonOut = jsonAt === -1 ? null : (args[jsonAt + 1] ?? null);

if (args.includes("--build")) {
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });
}

const log = (m: string) => console.log(`editor-bench: ${m}`);

const ROOT = "/Users/lucas/code/polaris";

const SMALL = `${ROOT}/daemon/src/hosts/reconnect.ts`;

const BIG = `${ROOT}/bench/big.ts`;

/**
 * Per key: key-to-paint ms; its work, from keydown until the last of its handlers (and their
 * microtasks) ends; and how many frames it painted late after the frame that followed that work.
 */
const KEY_PROBE = `(() => {
  const keys = [];
  let vsync = 0;
  let live = true;
  let current = null;
  const loop = (now) => { vsync = now; if (live) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const after = () => {
    const key = current;
    if (key !== null) queueMicrotask(() => { key.end = performance.now(); key.frameBefore = vsync; });
  };
  const content = document.querySelector(".cm-content");
  const targets = [[window, ["keydown", "keypress", "beforeinput", "input"]], [content?.editContext ?? null, ["textupdate"]]];
  for (const [target, types] of targets) for (const type of types) target?.addEventListener(type, after);
  const onKey = (e) => {
    const t0 = performance.now();
    const key = { latency: 0, work: 0, late: 0, end: t0, frameBefore: vsync };
    current = key;
    after();
    requestAnimationFrame((now) => {
      current = null;
      key.work = key.end - t0;
      key.late = Math.max(0, Math.round((now - key.frameBefore) / window.__frame) - 1);
      setTimeout(() => { key.latency = performance.now() - e.timeStamp; keys.push(key); }, 0);
    });
  };
  window.addEventListener("keydown", onKey, { capture: true });
  window.__keys = { stop: () => {
    live = false;
    window.removeEventListener("keydown", onKey, { capture: true });
    for (const [target, types] of targets) for (const type of types) target?.removeEventListener(type, after);
    return keys;
  } };
})()`;

/** The display's frame interval: the median rAF gap while idle. */
const FRAME = `new Promise((resolve) => {
  const gaps = [];
  let last = performance.now();
  const tick = (now) => {
    gaps.push(now - last);
    last = now;
    if (gaps.length < 90) requestAnimationFrame(tick);
    else resolve(gaps.sort((a, b) => a - b)[45]);
  };
  requestAnimationFrame(tick);
})`;

const TYPED = "const retries = attempts.filter((a) => a.ok).length; // count the successes";

interface Result {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly budget: number | null;
}

const results: Array<Result> = [];

const record = (name: string, value: number, unit: string, budget: number | null) => {
  results.push({ name, value, unit, budget });
  const verdict = budget === null ? "" : value <= budget ? " ok" : ` OVER (budget ${budget})`;

  log(`${name}: ${value.toFixed(1)} ${unit}${verdict}`);
};

const quantile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

const ready = (page: Page) =>
  page
    .evaluate<boolean>(`document.readyState === "complete" && "__polarisEditor" in window`)
    .catch(() => false);

const scene = async (page: Page, name: string) => {
  await page.evaluate(`window.__polarisEditor = undefined; delete window.__polarisEditor`);
  await page
    .evaluate(`location.hash = "#editor/${name}"; location.reload()`)
    .catch(() => undefined);
  await page.waitForLoadState("domcontentloaded");

  while (!(await ready(page))) await page.waitForTimeout(50);

  await page.waitForTimeout(400);
};

/** Renderer time from openFile to its lines painted, in the page (the preview's `__polarisEditor`). */
const openTimed = (page: Page, path: string) =>
  page.evaluate<number>(`(async () => {
    const start = performance.now();
    window.__polarisEditor.openFile({ hostKey: "studio", workspaceId: "ws-polaris", path: ${JSON.stringify(path)} });
    const shown = () =>
      document.querySelectorAll(".cm-content .cm-line").length > 10 &&
      document.querySelector('[data-testid="editor-tab"][aria-selected="true"]')?.getAttribute("title") === ${JSON.stringify(path)};
    while (!shown()) await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    return performance.now() - start;
  })()`);

/** Per-key work the typing budget allows (spec §7). */
const KEY_WORK_MS = 1;

interface Key {
  readonly latency: number;
  readonly work: number;
  readonly late: number;
}

const typing = async (page: Page, label: string, frame: number) => {
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.evaluate(`window.__frame = ${frame}`);
  await page.evaluate(KEY_PROBE);
  await page.keyboard.type(TYPED, { delay: 25 });
  await page.waitForTimeout(300);
  const keys = await page.evaluate<ReadonlyArray<Key>>("window.__keys.stop()");
  const latency = keys.map((k) => k.latency);
  const late = keys.map((k) => k.late);
  const work = keys.map((k) => k.work);
  const onNext = late.filter((l) => l === 0).length;

  record(`${label} frames late p95`, quantile(late, 0.95), "frames", 0);
  record(`${label} keys on the next frame`, (100 * onNext) / keys.length, "%", null);
  record(`${label} work per key p50`, quantile(work, 0.5), "ms", null);
  record(`${label} work per key p95`, quantile(work, 0.95), "ms", KEY_WORK_MS);
  record(`${label} key-to-paint p50`, quantile(latency, 0.5), "ms", null);
  record(`${label} key-to-paint p95`, quantile(latency, 0.95), "ms", null);
  record(`${label} key-to-paint p95 in frames`, quantile(latency, 0.95) / frame, "frames", null);
  record(`${label} key-to-paint max`, quantile(latency, 1), "ms", null);
};

const memory = (app: ElectronApplication): number => {
  const pid = app.process().pid;

  if (pid === undefined) return Number.NaN;

  const out = execFileSync(
    "bun",
    [join(APP_DIR, "scripts/lib/sampleTree.ts"), "3000", `app=${pid}`],
    {
      encoding: "utf8",
    }
  );
  // SAFETY: sampleTree.ts prints one JSON object per line with footprintMiB / rssMiB.

  const row = JSON.parse(out.trim().split("\n")[0] ?? "{}") as {
    footprintMiB: number | null;
    rssMiB: number;
  };

  return row.footprintMiB ?? row.rssMiB;
};

const savedText = (page: Page, path: string) =>
  page.evaluate<string | null>(
    `window.__polarisEditor.files.text("studio", ${JSON.stringify(path)})`
  );

/** Opening a path that isn't there toasts why and leaves the tabs as they were. */
const checkMissing = async (page: Page) => {
  await scene(page, "e1");
  const before = await tabCount(page);

  await page.evaluate(
    `window.__polarisEditor.openFile({ hostKey: "studio", workspaceId: "ws-polaris", path: "${ROOT}/daemon/gone.ts" })`
  );
  const toast = page.getByText("Couldn't open daemon/gone.ts");

  await toast.waitFor({ timeout: 5000 }).catch(() => undefined);
  const shown = (await toast.count()) > 0;
  const kept = (await tabCount(page)) === before;

  log(
    `open a missing file: toast ${shown ? "shown" : "MISSING"}, tabs ${kept ? "unchanged" : "CHANGED"}`
  );

  return shown && kept;
};

const tabCount = (page: Page) => page.getByTestId("editor-tab").count();

/** Closing a dirty tab asks: Cancel keeps it, Save saves then closes, Don't save drops the edits. */
const checkClose = async (page: Page) => {
  const close = () => page.locator('[aria-label="Close reconnect.ts"]').dispatchEvent("click");
  const dialog = page.getByTestId("editor-close-dialog");

  await scene(page, "e1");
  const before = await tabCount(page);

  await close();
  await dialog.waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  const kept = (await tabCount(page)) === before;

  await close();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(300);

  const saved =
    ((await savedText(page, SMALL))?.includes("// ms") ?? false) &&
    (await tabCount(page)) === before - 1;

  await scene(page, "e1");
  await close();
  await page.getByRole("button", { name: "Don't save" }).click();
  await page.waitForTimeout(300);

  const dropped =
    !((await savedText(page, SMALL))?.includes("// ms") ?? true) &&
    (await tabCount(page)) === before - 1;

  log(
    `close a dirty tab: Cancel keeps it ${kept ? "yes" : "NO"}, Save saves and closes ${saved ? "yes" : "NO"}, Don't save closes unsaved ${dropped ? "yes" : "NO"}`
  );

  return kept && saved && dropped;
};

/** Unsaved edits survive a restart (here a reload of the window, with the drafts in localStorage). */
const checkRestart = async (page: Page) => {
  await page.evaluate("localStorage.clear()");
  await scene(page, "empty?persist");
  await page.evaluate(
    `window.__polarisEditor.openFile({ hostKey: "studio", workspaceId: "ws-polaris", path: ${JSON.stringify(SMALL)} })`
  );
  await page.locator(".cm-content").click();
  await page.keyboard.type("// kept across a restart");
  await page.waitForTimeout(800);
  await scene(page, "empty?persist");
  await page.locator(".cm-content").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const text = await page.locator(".cm-content").textContent();
  const dot = await page.locator('[data-testid="editor-tab"][data-dirty]').count();
  const ok = (text?.includes("// kept across a restart") ?? false) && dot === 1;

  log(`after a restart: the edit ${ok ? "is back, with its unsaved dot" : "is LOST"}`);
  await page.evaluate("localStorage.clear()");

  return ok;
};

const openPath = (page: Page, path: string) =>
  page.evaluate(
    `window.__polarisEditor.openFile({ hostKey: "studio", workspaceId: "ws-polaris", path: ${JSON.stringify(path)} })`
  );

/** A 3 MB unsaved edit survives a restart (QCHECK: drafts past 2M characters were lost). */
const checkBigRestart = async (page: Page) => {
  await page.evaluate("localStorage.clear()");
  await scene(page, "empty?persist");
  await openPath(page, BIG);
  await page.locator(".cm-content").waitFor({ timeout: 10_000 });
  await page.evaluate(
    `window.__polarisEditor.activeView().dispatch({ changes: { from: 0, insert: "/* big */".repeat(300000) } })`
  );
  await page.waitForTimeout(2000);
  await scene(page, "empty?persist");
  await page.locator(".cm-content").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);

  const length = await page.evaluate<number>(
    "window.__polarisEditor.activeView().state.doc.length"
  );

  const dot = await page.locator('[data-testid="editor-tab"][data-dirty]').count();
  const ok = length > 3_500_000 && dot === 1;

  log(
    `a 3 MB edit after a restart: ${ok ? "back, with its unsaved dot" : `LOST (${length} chars)`}`
  );
  await page.evaluate("localStorage.clear()");

  return ok;
};

/** Renaming a file with unsaved edits keeps them, at the new path (QCHECK). */
const checkRename = async (page: Page) => {
  await scene(page, "e1");
  const renamed = `${ROOT}/daemon/src/hosts/renamed.ts`;

  await page.evaluate(`(async () => {
    const e = window.__polarisEditor;
    e.files.agentWrite("studio", ${JSON.stringify(renamed)}, e.files.text("studio", ${JSON.stringify(SMALL)}));
    await e.renameFile("studio", ${JSON.stringify(SMALL)}, ${JSON.stringify(renamed)});
    e.files.remove("studio", ${JSON.stringify(SMALL)});
  })()`);
  await page.waitForTimeout(800);

  const title = await page
    .locator('[data-testid="editor-tab"][aria-selected="true"]')
    .getAttribute("title");

  const dirty = await page
    .locator('[data-testid="editor-tab"][aria-selected="true"][data-dirty]')
    .count();

  const text = await page.locator(".cm-content").textContent();
  const ok = title === renamed && dirty === 1 && (text?.includes("// ms") ?? false);

  log(
    `rename a dirty file: ${ok ? "its edits follow it" : `edits LOST (tab ${title ?? "none"}, dirty ${dirty})`}`
  );

  return ok;
};

/** vim's :q closes the tab without an uncaught error (QCHECK: searchState_). */
const checkVimQuit = async (page: Page) => {
  const errors: Array<string> = [];
  const onError = (error: Error) => errors.push(error.message);

  page.on("pageerror", onError);
  await scene(page, "vim");
  const before = await tabCount(page);

  await page.locator(".cm-content").click();
  await page.keyboard.press("Escape");
  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  page.off("pageerror", onError);
  const ok = errors.length === 0 && (await tabCount(page)) === before - 1;

  log(
    `vim :q: ${ok ? "closes the tab, no errors" : `FAILED (${errors.join("; ") || "tab still open"})`}`
  );

  return ok;
};

/** An LF file rewritten to CRLF on disk reloads without blank lines and saves CRLF (QCHECK). */
const checkLineEndings = async (page: Page) => {
  const transport = `${ROOT}/daemon/src/hosts/transport.ts`;

  await scene(page, "empty");
  await openPath(page, transport);
  await page.locator(".cm-content").waitFor({ timeout: 10_000 });
  const lines = await page.evaluate<number>("window.__polarisEditor.activeView().state.doc.lines");

  await page.evaluate(`(() => {
    const f = window.__polarisEditor.files;
    f.agentWrite("studio", ${JSON.stringify(transport)}, f.text("studio", ${JSON.stringify(transport)}).replaceAll("\\n", "\\r\\n"));
  })()`);
  await page.waitForTimeout(500);
  const after = await page.evaluate<number>("window.__polarisEditor.activeView().state.doc.lines");

  await page.locator(".cm-content").click();
  await page.keyboard.type("// crlf");
  await page.keyboard.press("Meta+S");
  await page.waitForTimeout(300);
  const saved = (await savedText(page, transport)) ?? "";
  const ok = after === lines && saved.includes("// crlf") && !/[^\r]\n/.test(saved);

  log(`LF → CRLF on disk: ${ok ? "same lines, saved CRLF" : `FAILED (${lines} → ${after} lines)`}`);

  return ok;
};

const docLines = (page: Page) =>
  page.evaluate<number>("window.__polarisEditor.activeView().state.doc.lines");

const caretLine = (page: Page) =>
  page.evaluate<number>(
    "(() => { const s = window.__polarisEditor.activeView().state; return s.doc.lineAt(s.selection.main.head).number; })()"
  );

const switchTab = async (page: Page, key: string) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(300);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Escape");
};

/** Registers are app-wide as in real vim (the lead's call); marks stay per tab. */
const checkRegisters = async (page: Page) => {
  await scene(page, "vim");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Escape");
  await page.keyboard.type('gg"ayy5Gma');
  await switchTab(page, "Control+Tab");
  const before = await docLines(page);

  await page.keyboard.type('gg"ap');
  await page.waitForTimeout(200);
  const pasted = await docLines(page);

  await page.keyboard.type("G'a");
  await page.waitForTimeout(200);
  const elsewhere = await caretLine(page);

  await switchTab(page, "Control+Shift+Tab");
  await page.keyboard.type("G'a");
  await page.waitForTimeout(200);
  const home = await caretLine(page);
  const shared = pasted === before + 1;
  const marks = elsewhere !== 5 && home === 5;
  const ok = shared && marks;

  log(
    `vim registers ${shared ? "shared across tabs" : "NOT shared"}, marks ${marks ? "per tab" : `NOT per tab (other tab ${elsewhere}, own ${home})`}`
  );

  return ok;
};

/** E3: the Working strip, the agent's line marks and caret, and "Following … · Ln N". */
const checkAgent = async (page: Page) => {
  await scene(page, "e3");
  await page.getByTestId("agent-strip").waitFor({ timeout: 5000 });
  await page.waitForTimeout(2500);
  const marks = await page.locator(".cm-agentLine").count();

  const flag = await page
    .locator(".cm-agentFlag")
    .textContent()
    .catch(() => null);

  const following = await page
    .getByTestId("following")
    .textContent()
    .catch(() => null);

  const ok =
    marks > 0 &&
    flag === "Claude Code" &&
    (following?.startsWith("Following Claude Code · Ln") ?? false);

  log(
    `agent editing the file: ${marks} marked lines, flag ${flag ?? "none"}, status "${following ?? ""}"${ok ? "" : " FAILED"}`
  );

  return ok;
};

const checkSaves = async (page: Page) => {
  await scene(page, "e1");
  await page.locator(".cm-content").click();
  await page.keyboard.type("// saved by ⌘S");
  await page.keyboard.press("Meta+S");
  await page.waitForTimeout(300);
  const viaShortcut = (await savedText(page, SMALL))?.includes("// saved by ⌘S") ?? false;

  log(`⌘S saves: ${viaShortcut ? "yes" : "NO"}`);

  await scene(page, "vim");
  await page.locator(".cm-content").click();
  await page.keyboard.type("Go// saved by :w");
  await page.keyboard.press("Escape");
  const mode = await page.getByTestId("vim-mode").textContent();

  await page.keyboard.type(":w");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const viaVim = (await savedText(page, SMALL))?.includes("// saved by :w") ?? false;

  log(`vim mode shown after esc: ${mode ?? "none"}; :w saves: ${viaVim ? "yes" : "NO"}`);

  await page.keyboard.type("o// saved by ⌘S in insert");
  const insert = await page.getByTestId("vim-mode").textContent();

  await page.keyboard.press("Meta+S");
  await page.waitForTimeout(300);
  const fromInsert = (await savedText(page, SMALL))?.includes("in insert") ?? false;

  log(`vim ${insert ?? "?"}: ⌘S saves: ${fromInsert ? "yes" : "NO"}`);

  const restored = await checkRestart(page);
  const closing = await checkClose(page);
  const missing = await checkMissing(page);
  const big = await checkBigRestart(page);
  const rename = await checkRename(page);
  const quit = await checkVimQuit(page);
  const agent = await checkAgent(page);
  const endings = await checkLineEndings(page);
  const registers = await checkRegisters(page);

  return (
    endings &&
    registers &&
    big &&
    rename &&
    quit &&
    agent &&
    missing &&
    closing &&
    viaShortcut &&
    viaVim &&
    fromInsert &&
    mode === "NORMAL" &&
    insert === "INSERT" &&
    restored
  );
};

const home = mkdtempSync(join(tmpdir(), "polaris-editor-bench-"));

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ welcomeSeen: true, theme: "dark", local: { enabled: false } })
);

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR, "--use-mock-keychain"],
  env: { ...process.env, HOME: home, POLARIS_DESKTOP_USER_DATA: userData },
});

let failed = false;

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  await scene(page, "empty");
  const frame = await page.evaluate<number>(FRAME);

  record("display frame interval", frame, "ms", null);

  const opens: Array<number> = [];

  for (let i = 0; i < 5; i++) {
    await scene(page, "empty");
    opens.push(await openTimed(page, BIG));
  }

  record("open 1 MB file (renderer, median of 5)", quantile(opens, 0.5), "ms", 150);

  await typing(page, "typing, 1 MB file", frame);
  await scene(page, "empty");
  await openTimed(page, SMALL);
  await typing(page, "typing, small file", frame);

  await scene(page, "vim");
  await page.locator(".cm-content").click();
  await page.keyboard.press("o");
  await typing(page, "typing, vim insert", frame);

  await scene(page, "empty");
  await page.waitForTimeout(1500);
  const before = memory(app);

  await scene(page, "tabs20");
  await page.waitForTimeout(1500);
  // Visit every tab, so each one's editor has rendered.

  for (let i = 0; i < 20; i++) await page.keyboard.press("Control+Tab");
  await page.waitForTimeout(1500);
  const after = memory(app);

  record("app memory, empty editor", before, "MiB", null);
  record("app memory, 20 open tabs", after, "MiB", 1024);
  record("20 tabs over the empty editor", after - before, "MiB", null);

  failed =
    !(await checkSaves(page)) || results.some((r) => r.budget !== null && r.value > r.budget);
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}

if (jsonOut !== null) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);

log(failed ? "FAILED" : "ok");

process.exitCode = failed ? 1 : 0;
