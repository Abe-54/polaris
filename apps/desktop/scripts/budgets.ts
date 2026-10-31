#!/usr/bin/env node
import { modelServerMemory } from "./lib/modelServerMemory.ts";
/**
 * The Desktop App's M1 budgets, measured on the built app against a throwaway
 * Daemon on the bench Harness (PRODUCT.md, DESIGN.md Performance):
 *
 * - memory: a heavy session (25 Turns × 60 items × 6 KB, 3 files each) open,
 *   the whole app (Electron's tree) plus the Daemon under 1 GB;
 * - Workspace switch: p95 under 100 ms, between two ordinary Workspaces (gated),
 *   and into the heavy session (reported only: it runs ~60 ms on a Mac today, see
 *   .dagr/reports/FX-ci.md, and would flap on a 2-core runner);
 * - frames while streaming: paced to the display. The 120 Hz budget means
 *   frames no longer than the refresh interval, so the check is relative to
 *   the display's own interval (idle median): 8.3 ms on a 120 Hz Mac, 16.7 ms
 *   under Xvfb in CI. p95 at most 1.5 intervals, and at most 2% of frames
 *   over two intervals (a dropped frame).
 *
 *   node scripts/budgets.ts [--json <path>] [--markdown <path>] [--show]
 *
 * Runs under Node (Playwright's Electron launcher), on macOS or Linux (in CI
 * under `xvfb-run`). Build the app first: `bun run --cwd apps/desktop build`.
 * Exits 1 when a budget is missed.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { initRepo } from "./lib/sessionFlow.ts";

const args = process.argv.slice(2);

const option = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

/** The M1 budgets. */
const BUDGET = {
  memoryMiB: 1024,
  switchP95Ms: 100,
  /** Frame p95, in display refresh intervals. */
  frameP95Intervals: 1.5,
  /** Share of frames longer than two refresh intervals. */
  droppedShare: 0.02,
  /** Slower than 30 Hz idle means rAF is throttled (a hidden window): frames can't be judged. */
  maxIntervalMs: 34,
} as const;

/** V2's heavy session: 25 Turns of 60 items of ~6 KB, 3 files touched per Turn. */
const HEAVY_TURNS = 25;

const bench = (script: Record<string, number>) => `bench:${JSON.stringify(script)}`;

const HEAVY_TURN = bench({
  items: 60,
  itemBytes: 6000,
  deltasPerItem: 1,
  deltaIntervalMs: 0,
  touchFiles: 3,
});

const LIGHT_TURN = bench({ items: 4, deltasPerItem: 2, deltaIntervalMs: 0 });

/** About eight seconds of streaming, as in the smoke test. */
const STREAMING_TURN = bench({ items: 8, deltasPerItem: 100, deltaBytes: 64, deltaIntervalMs: 10 });

const step = (message: string) => console.log(`budgets: ${message}`);

const home = mkdtempSync(join(tmpdir(), "polaris-budgets-"));

const userData = join(home, "user-data");

const userHome = join(home, "user-home");

mkdirSync(userData, { recursive: true });

mkdirSync(userHome, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

const daemon = await startDaemon({ home, benchHarness: true, userHome });

const app = await electron.launch({
  executablePath: electronBinary(),
  // CI's Ubuntu forbids the unprivileged user namespaces Chromium's sandbox needs.
  args: [APP_DIR, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: userData,
    // Linux throttles a hidden window's frames to 1 Hz; under Xvfb a shown one is off-screen anyway.
    POLARIS_DESKTOP_HIDDEN: args.includes("--show") || process.platform === "linux" ? "0" : "1",
  },
});

const percentile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
};

/** Frame intervals (ms) over `ms`, from rAF timestamps in the renderer. */
const frameGaps = async (page: Page, ms: number) => {
  const times = await page.evaluate<ReadonlyArray<number>>(`new Promise((resolve) => {
    const times = [];
    const end = performance.now() + ${ms};
    const tick = (t) => { times.push(t); if (t < end) requestAnimationFrame(tick); else resolve(times); };
    requestAnimationFrame(tick);
  })`);

  return times.slice(1).map((t, i) => t - (times[i] ?? t));
};

/** Registers a git Workspace and starts a session in it from the new-session page. */
const startSession = async (page: Page, name: string, prompt: string) => {
  const repo = join(home, name);

  initRepo(repo);
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(repo)}, name: ${JSON.stringify(name)} } })`
  );
  await page
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByTestId("new-session").waitFor();
  // Start is enabled once a ready Harness (the bench one) is pre-selected.
  await page
    .locator('[role="radiogroup"][aria-label="Harness"] [aria-checked="true"]')
    .waitFor({ timeout: 30_000 });
  await page.getByTestId("composer-input").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByTestId("session-panel").waitFor({ timeout: 15_000 });
};

/** The visible session's state line (earlier views stay mounted, hidden). */
const state = (page: Page) => page.locator('[data-testid="session-state"]:visible');

const idleAfter = async (page: Page, turn: number) => {
  await state(page)
    .filter({ hasText: new RegExp(`^Idle · turn ${turn}$`) })
    .waitFor({ timeout: 120_000 });
};

const send = async (page: Page, prompt: string) => {
  const input = page.locator('[data-testid="composer-input"]:visible');

  await input.fill(prompt);
  await input.press("Enter");
};

/** Every switch time routes/switchTimer.ts recorded so far (input → the second frame after it). */
const recorded = (page: Page) =>
  page.evaluate<ReadonlyArray<number>>("window.__polaris.switchTimes()");

/** `a` / `b` (⌃ digits) back and forth 40 times; the times of these switches only. */
const switchTimes = async (page: Page, a: string, b: string) => {
  const before = (await recorded(page)).length;

  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(`Control+Digit${i % 2 === 0 ? b : a}`);
    await page.waitForTimeout(40);
  }

  await page.waitForTimeout(200);

  return (await recorded(page)).slice(before);
};

interface TreeMemory {
  readonly label: string;
  readonly rssMiB: number;
  readonly footprintMiB: number | null;
  readonly processes: number;
}

/** Peak memory of the app's tree and the Daemon's, sampled by `lib/sampleTree.ts` under Bun. */
const memory = (appPid: number, daemonPid: number): ReadonlyArray<TreeMemory> => {
  const out = execFileSync(
    "bun",
    [join(APP_DIR, "scripts/lib/sampleTree.ts"), "3000", `app=${appPid}`, `daemon=${daemonPid}`],
    { encoding: "utf8" }
  );

  // SAFETY: sampleTree.ts prints one TreeMemory JSON object per line.
  return out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TreeMemory);
};

interface Check {
  readonly name: string;
  readonly value: string;
  readonly budget: string;
  readonly ok: boolean;
  /** Reported, not gated. */
  readonly info?: boolean;
}

const checks: Array<Check> = [];

const check = (name: string, value: string, budget: string, ok: boolean) => {
  checks.push({ name, value, budget, ok });
  step(`${ok ? "ok  " : "FAIL"} ${name}: ${value} (budget ${budget})`);
};

/** A measurement against a budget that doesn't fail the run. */
const report = (name: string, value: string, budget: string, ok: boolean) => {
  checks.push({ name, value, budget, ok, info: true });
  step(`${ok ? "ok  " : "WARN"} ${name}: ${value} (budget ${budget}, not gated)`);
};

let failed = false;

interface SwitchSummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly times?: ReadonlyArray<number>;
}

/** What was measured, for the --json output. */
interface Measured {
  switch?: SwitchSummary;
  heavySwitch?: SwitchSummary;
  frames?: {
    readonly intervalMs: number;
    readonly frames: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
    readonly droppedShare: number;
  };
  memory?: {
    readonly trees: ReadonlyArray<TreeMemory>;
    readonly modelServers: ReadonlyArray<TreeMemory>;
    readonly footprintMiB: number;
    readonly rssMiB: number;
  };
}

const measured: Measured = {};

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 30_000 });
  // A fresh probe, so New session pre-selects a ready Harness at once (V2 bug 1: an early
  // probe interrupted by its first caller could stay cached; fixed on fx/session).
  await page.evaluate(
    `window.polaris.request("harness.availability", { hostKey: "local", refresh: true })`
  );

  // The heavy session: the first Turn starts it, the rest follow it.
  const started = Date.now();

  await startSession(page, "heavy", HEAVY_TURN);
  await idleAfter(page, 1);

  for (let turn = 2; turn <= HEAVY_TURNS; turn++) {
    await send(page, HEAVY_TURN);
    await idleAfter(page, turn);
  }

  step(`heavy session: ${HEAVY_TURNS} Turns in ${Math.round((Date.now() - started) / 1000)} s`);

  await startSession(page, "light", LIGHT_TURN);
  await idleAfter(page, 1);
  await startSession(page, "other", LIGHT_TURN);
  await idleAfter(page, 1);

  // Workspace switch between two ordinary Workspaces (⌃2 light, ⌃3 other): the M1 budget.
  const switches = await switchTimes(page, "2", "3");
  const switchP95 = percentile(switches, 0.95);

  // Into the heavy session and out (⌃1 heavy, ⌃2 light): reported, not gated.
  const heavySwitches = await switchTimes(page, "2", "1");
  const heavyP95 = percentile(heavySwitches, 0.95);

  measured.switch = { count: switches.length, p50: percentile(switches, 0.5), p95: switchP95 };
  measured.heavySwitch = {
    count: heavySwitches.length,
    p50: percentile(heavySwitches, 0.5),
    p95: heavyP95,
    times: heavySwitches,
  };
  check(
    `Workspace switch p95 (${switches.length} switches)`,
    `${switchP95.toFixed(1)} ms`,
    `< ${BUDGET.switchP95Ms} ms`,
    switches.length >= 20 && switchP95 < BUDGET.switchP95Ms
  );
  report(
    "Switch into and out of the heavy session, p95 (reported only)",
    `${heavyP95.toFixed(1)} ms`,
    `< ${BUDGET.switchP95Ms} ms`,
    heavyP95 < BUDGET.switchP95Ms
  );

  // Frames: the display's interval while idle, then a streaming Turn in the light session.
  await page.keyboard.press("Control+Digit2");
  await page.waitForTimeout(500);
  const interval = percentile(await frameGaps(page, 1500), 0.5);

  await send(page, STREAMING_TURN);
  await page.locator('[data-testid="live-item"]:visible').first().waitFor({ timeout: 15_000 });
  const gaps = await frameGaps(page, 5000);
  const p95 = percentile(gaps, 0.95);
  const dropped = gaps.filter((g) => g > 2 * interval).length / Math.max(1, gaps.length);

  measured.frames = {
    intervalMs: interval,
    frames: gaps.length,
    p50: percentile(gaps, 0.5),
    p95,
    p99: percentile(gaps, 0.99),
    max: percentile(gaps, 1),
    droppedShare: dropped,
  };
  check(
    "Display paced (idle frame interval; else the window is throttled)",
    `${interval.toFixed(2)} ms`,
    `≤ ${BUDGET.maxIntervalMs} ms`,
    interval <= BUDGET.maxIntervalMs
  );
  check(
    `Streaming frame p95 (display interval ${interval.toFixed(2)} ms)`,
    `${p95.toFixed(2)} ms`,
    `≤ ${(BUDGET.frameP95Intervals * interval).toFixed(2)} ms`,
    p95 <= BUDGET.frameP95Intervals * interval
  );
  check(
    "Dropped frames while streaming (> 2 intervals)",
    `${(dropped * 100).toFixed(2)}%`,
    `≤ ${BUDGET.droppedShare * 100}%`,
    dropped <= BUDGET.droppedShare
  );
  await idleAfter(page, 2);
  // Memory with the heavy session open, the light one mounted behind it.
  await page.keyboard.press("Control+Digit1");
  await page.waitForTimeout(1500);

  const trees = memory(app.process().pid ?? 0, daemon.pid ?? 0);

  const total = (field: "rssMiB" | "footprintMiB") =>
    trees.reduce((sum, tree) => sum + (tree[field] ?? tree.rssMiB), 0);

  const modelServers = await modelServerMemory(APP_DIR);
  measured.memory = {
    trees,
    modelServers,
    footprintMiB: total("footprintMiB"),
    rssMiB: total("rssMiB"),
  };

  for (const server of modelServers) {
    report(
      "Model servers (outside Desktop App budget)",
      `${(server.footprintMiB ?? server.rssMiB).toFixed(0)} MiB`,
      "reported separately",
      true
    );
  }

  for (const tree of trees) {
    step(
      `${tree.label}: footprint ${tree.footprintMiB?.toFixed(0) ?? "?"} MiB, RSS ${tree.rssMiB.toFixed(0)} MiB, ${tree.processes} processes`
    );
  }

  check(
    `Memory, heavy session open (app + Daemon, footprint)`,
    `${total("footprintMiB").toFixed(0)} MiB`,
    `< ${BUDGET.memoryMiB} MiB`,
    total("footprintMiB") < BUDGET.memoryMiB
  );
  failed = checks.some((c) => !c.ok && c.info !== true);
} catch (error) {
  failed = true;
  console.error("budgets: FAILED", error);
  const page = app.windows()[0];

  if (page !== undefined) {
    console.error(`budgets: screen text:\n${await page.locator("body").innerText()}`);
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}

const json = option("--json");

if (json !== null) {
  writeFileSync(json, `${JSON.stringify({ budget: BUDGET, checks, measured }, null, 2)}\n`);
}

const markdown = option("--markdown");

if (markdown !== null) {
  appendFileSync(
    markdown,
    [
      "## Desktop budgets",
      "",
      "| Budget | Measured | Limit | |",
      "|---|---|---|---|",
      ...checks.map(
        (c) =>
          `| ${c.name} | ${c.value} | ${c.budget} | ${c.ok ? "✅" : c.info === true ? "⚠️ not gated" : "❌"} |`
      ),
      "",
    ].join("\n")
  );
}

process.exit(failed ? 1 : 0);
