#!/usr/bin/env node
/**
 * Review on Pierre Diffs under load (ENG-218 / ENG-230), on the built app against a real
 * Daemon: generated repositories diffed through `git.diff` exactly as a Review Checkout
 * serves them (`#review/bench`). Scenes (full / `--quick` sizes):
 *
 * - `full`: 2,000 / 300 files, three hunks each, every file expanded (the largest full-scale Review);
 * - `collapsed`: 5,000 / 2,100 files, past the 2,000-file threshold: every file opens collapsed;
 * - `list-only`: 12,000 / 10,100 files, past 10,000: the list scrolls, one file opens;
 * - `huge`: one file of 100,000 / 20,000 lines, every 25th edited.
 *
 * Each reports the time to the first file and to the last parsed batch, scroll frames
 * against the display's own interval, the app's memory (Electron's `getAppMetrics`) and
 * the Daemon's peak RSS while it diffs. Budgets: frame p95 at most 1.5 intervals, at most
 * 2% dropped, the app under 1 GB.
 *
 *   node scripts/reviewBench.ts [--quick] [--scenes full,huge] [--json <path>] [--profile <prefix>]
 *
 * Build the app first (`bun run --cwd apps/desktop build`). Exits 1 when a budget is missed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { type ElectronApplication, type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const option = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const quick = args.includes("--quick");

const BUDGET = { frameP95Intervals: 1.5, droppedShare: 0.02, appMiB: 1024 } as const;

type SceneName = "full" | "collapsed" | "list-only" | "huge";

const SIZES: Readonly<Record<SceneName, number>> = quick
  ? { full: 300, collapsed: 2100, "list-only": 10_100, huge: 20_000 }
  : { full: 2000, collapsed: 5000, "list-only": 12_000, huge: 100_000 };

const isScene = (name: string): name is SceneName => name in SIZES;

const scenes = (option("--scenes")?.split(",") ?? Object.keys(SIZES)).filter(isScene);

// ── Repositories ────────────────────────────────────────────────────────────

const tsLine = (i: number) => {
  switch (i % 5) {
    case 0:
      return `export function handler${i}(input: Request): Promise<Response> {`;
    case 1:
      return `  const value${i} = await fetch("https://example.com/${i}"); // fetch it`;
    case 2:
      return `  if (value${i}.status !== ${i % 500}) throw new Error("bad ${i}");`;
    case 3:
      return `  return new Response(JSON.stringify({ id: ${i}, ok: true }));`;
    default:
      return "}";
  }
};

/** A file of `lines` lines; `edited` rewrites the lines `edit` picks. */
const fileText = (lines: number, edited: boolean, edit: (i: number) => boolean) =>
  `${Array.from({ length: lines }, (_, i) => (edited && edit(i) ? `${tsLine(i)} // edited` : tsLine(i))).join("\n")}\n`;

interface Change {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

const changesFor = (scene: SceneName, size: number): ReadonlyArray<Change> => {
  if (scene === "huge") {
    return [
      {
        path: "big.ts",
        before: fileText(size, false, () => false),
        after: fileText(size, true, (i) => i % 25 === 0),
      },
    ];
  }

  // Three hunks of a 120-line file for expanded Reviews; one line of a small one past them.
  const lines = scene === "full" ? 120 : 12;
  const edit = scene === "full" ? (i: number) => i % 40 >= 3 && i % 40 < 7 : (i: number) => i === 3;

  return Array.from({ length: size }, (_, f) => ({
    path: `src/module${Math.floor(f / 50)}/file${f}.ts`,
    before: fileText(lines, false, edit),
    after: fileText(lines, true, edit),
  }));
};

/** Two commits through `git fast-import`: thousands of files in a second. */
const makeRepo = (dir: string, changes: ReadonlyArray<Change>) => {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);

  const parts: Array<string> = [];

  const blob = (mark: number, text: string) =>
    parts.push(`blob\nmark :${mark}\ndata ${Buffer.byteLength(text)}\n${text}\n`);

  const commit = (mark: number, from: number | null, files: ReadonlyArray<[string, number]>) =>
    parts.push(
      `commit refs/heads/main\nmark :${mark}\ncommitter Bench <bench@polaris> 1790000000 +0000\ndata 5\nbench\n${from === null ? "" : `from :${from}\n`}${files.map(([path, m]) => `M 100644 :${m} ${path}`).join("\n")}\n\n`
    );

  changes.forEach((c, i) => {
    blob(2 * i + 1, c.before);
    blob(2 * i + 2, c.after);
  });

  const base = 2 * changes.length + 1;

  commit(
    base,
    null,
    changes.map((c, i) => [c.path, 2 * i + 1])
  );
  commit(
    base + 1,
    base,
    changes.map((c, i) => [c.path, 2 * i + 2])
  );
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: dir,
    input: parts.join(""),
    maxBuffer: 1 << 30,
  });

  const [head = "", parent = ""] = execFileSync("git", ["rev-parse", "main", "main~1"], {
    cwd: dir,
  })
    .toString()
    .trim()
    .split("\n");

  return { base: parent, head };
};

// ── Measuring ───────────────────────────────────────────────────────────────

/** The page answers with frame intervals in ms. */
const framesOf = Schema.decodeUnknownSync(Schema.Array(Schema.Number));

const pct = (xs: ReadonlyArray<number>, p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

const appMiB = async (app: ElectronApplication) =>
  app.evaluate(
    ({ app: electronApp }) =>
      electronApp.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024
  );

/** Each process's working set, for the notes: `type pid MiB`. */
const processBreakdown = async (app: ElectronApplication) =>
  app.evaluate(({ app: electronApp }) =>
    electronApp
      .getAppMetrics()
      .map(
        (m) =>
          `${m.type}${m.serviceName === undefined ? "" : `:${m.serviceName}`} ${Math.round(m.memory.workingSetSize / 1024)}`
      )
      .join(", ")
  );

const rssMiB = (pid: number | undefined) => {
  if (pid === undefined) return 0;

  const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)])
    .stdout.toString()
    .trim();

  return Number(out) / 1024;
};

/** Frame intervals (ms) while scrolling `selector` by 240 px a frame (about 40k px/s at 180 Hz). */
const scrollFrames = async (page: Page, selector: string, frames: number) =>
  framesOf(
    await page.evaluate(`(async () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) throw new Error("no ${selector}");
      const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const deltas = [];
      let last = await raf();
      for (let i = 0; i < ${frames}; i++) {
        el.scrollTop += 240;
        const now = await raf();
        deltas.push(now - last);
        last = now;
      }
      return deltas;
    })()`)
  );

/** The display's own frame interval: the median of 120 idle frames. */
const idleInterval = async (page: Page) =>
  pct(
    framesOf(
      await page.evaluate(`(async () => {
        const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const deltas = [];
        let last = await raf();
        for (let i = 0; i < 120; i++) {
          const now = await raf();
          deltas.push(now - last);
          last = now;
        }
        return deltas;
      })()`)
    ),
    50
  );

interface SceneResult {
  readonly files: number;
  readonly patchMiB: number;
  readonly firstFileMs: number;
  readonly completeMs: number;
  readonly frameP50Ms: number;
  readonly frameP95Ms: number;
  readonly frameP99Ms: number;
  readonly frameMaxMs: number;
  readonly droppedShare: number;
  /** The whole app, settled with the Review open. */
  readonly appMiB: number;
  /** The whole app after scrolling 144,000 px (freed pages the renderer keeps included). */
  readonly appScrolledMiB: number;
  readonly daemonPeakRssMiB: number;
  readonly ok: boolean;
}

const home = mkdtempSync(join(tmpdir(), "polaris-review-bench-"));

const daemon = await startDaemon({ home, benchHarness: true });

/** A fresh app per scene, as the spike measured: a reload keeps the renderer's pages. */
const launch = () =>
  electron.launch({
    executablePath: electronBinary(),
    args: ["--js-flags=--expose-gc", APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, `user-data-${Date.now()}`)),
      POLARIS_DESKTOP_HIDDEN: "0",
    },
  });

const peakRss = () => {
  let peak = rssMiB(daemon.pid);

  const timer = setInterval(() => {
    peak = Math.max(peak, rssMiB(daemon.pid));
  }, 50);

  return () => {
    clearInterval(timer);

    return peak;
  };
};

const runScene = async (scene: SceneName): Promise<SceneResult> => {
  const dir = join(home, scene);
  const changes = changesFor(scene, SIZES[scene]);
  const { base, head } = makeRepo(dir, changes);

  const patchBytes = Number(
    execFileSync("sh", ["-c", `git -C '${dir}' diff ${base} ${head} | wc -c`])
      .toString()
      .trim()
  );

  const app = await launch();

  try {
    const page = await app.firstWindow();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(1500);

    const interval = await idleInterval(page);
    const idle = await appMiB(app);
    const daemonBefore = rssMiB(daemon.pid);
    const stopPeak = peakRss();
    const started = Date.now();

    await page.evaluate(
      `location.hash = "#review/bench?cwd=${encodeURIComponent(dir)}&base=${base}&head=${head}"; location.reload()`
    );
    await page.waitForLoadState("domcontentloaded");
    await page
      .getByTestId(scene === "list-only" ? "review-file-row" : "review-file")
      .first()
      .waitFor({ timeout: 120_000 });

    const firstFileMs = Date.now() - started;

    await page.locator("[data-testid=review-diff][data-complete]").waitFor({ timeout: 300_000 });

    const completeMs = Date.now() - started;
    const daemonPeak = stopPeak();

    await page.waitForTimeout(2000);

    if (scene === "list-only") {
      await page.getByTestId("review-file-row").nth(5).locator("button").click();
      await page.getByTestId("review-file").first().waitFor({ timeout: 30_000 });
    }

    const settled = await appMiB(app);

    const target =
      scene === "list-only" ? "[data-testid=review-files] .overflow-y-auto" : ".review-diff";

    const profile = option("--profile");
    const cdp = profile === null ? null : await page.context().newCDPSession(page);

    await cdp?.send("Profiler.enable");
    await cdp?.send("Profiler.start");

    const deltas = await scrollFrames(page, target, 600);

    if (cdp !== null && profile !== null) {
      const { profile: cpu } = await cdp.send("Profiler.stop");

      writeFileSync(`${profile}-${scene}.cpuprofile`, JSON.stringify(cpu));
      console.log(`review-bench ${scene}: CPU profile at ${profile}-${scene}.cpuprofile`);
    }

    await page.waitForTimeout(2000);

    const scrolledRaw = await appMiB(app);

    // Garbage the renderer hasn't collected yet isn't kept: collect it before measuring.
    await page.evaluate("globalThis.gc?.()");
    await page.waitForTimeout(2000);

    const scrolled = await appMiB(app);

    console.log(
      `review-bench ${scene}: scrolled ${Math.round(scrolledRaw)} MiB before a GC, ${Math.round(scrolled)} after; main heap ${Math.round(Number(await page.evaluate("performance.memory.usedJSHeapSize")) / 1048576)} MiB`
    );
    const dropped = deltas.filter((d) => d > interval * 2).length / deltas.length;
    const p95 = pct(deltas, 95);

    console.log(
      `review-bench ${scene}: ${changes.length} files (${(patchBytes / 1048576).toFixed(1)} MiB patch), first file ${firstFileMs} ms, parsed ${completeMs} ms; frames p50/p95/p99/max ${pct(deltas, 50).toFixed(1)}/${p95.toFixed(1)}/${pct(deltas, 99).toFixed(1)}/${pct(deltas, 100).toFixed(1)} ms (interval ${interval.toFixed(1)}), dropped ${(dropped * 100).toFixed(1)}%; app ${Math.round(idle)} idle → ${Math.round(settled)} open → ${Math.round(scrolled)} MiB scrolled (${await processBreakdown(app)}); daemon ${Math.round(daemonBefore)} → peak ${Math.round(daemonPeak)} MiB while diffing`
    );

    return {
      files: changes.length,
      patchMiB: patchBytes / 1048576,
      firstFileMs,
      completeMs,
      frameP50Ms: pct(deltas, 50),
      frameP95Ms: p95,
      frameP99Ms: pct(deltas, 99),
      frameMaxMs: pct(deltas, 100),
      droppedShare: dropped,
      appMiB: settled,
      appScrolledMiB: scrolled,
      daemonPeakRssMiB: daemonPeak,
      ok:
        p95 <= interval * BUDGET.frameP95Intervals &&
        dropped <= BUDGET.droppedShare &&
        settled < BUDGET.appMiB,
    };
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const results: Partial<Record<SceneName, SceneResult>> = {};

try {
  for (const scene of scenes) results[scene] = await runScene(scene);
} finally {
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}

const json = option("--json");

if (json !== null) writeFileSync(json, JSON.stringify({ quick, scenes: results }, null, 2));

if (Object.values(results).some((r) => !r.ok)) {
  console.log("review-bench: a budget was missed");
  process.exitCode = 1;
}
