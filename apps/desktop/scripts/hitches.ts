#!/usr/bin/env node
/**
 * Frame hitches with attribution: the first Harness chip menu open while a
 * Turn streams, the pointer sweeping the Working composer's dither field,
 * typing in the composer (key-to-paint latency, idle and while a Turn
 * streams), and fast scrolling through a heavy session.
 * Long frames come from rAF gaps; their causes from long-animation-frame
 * entries (script, source, duration), a main-process lag monitor, and
 * optionally a renderer CPU profile or a Chromium trace of every process.
 *
 *   node scripts/hitches.ts <chip|usage|hover|typing|scene|scroll> [--real-home] [--turns N] [--pinned]
 *     [--screenshot] [--shots <dir>] [--profile <file.cpuprofile>] [--trace <file.json>]
 *
 * Instrumentation moves the hitches it measures: judge budgets on plain runs.
 *
 * Budget: no frame over 16.7 ms on either path (120 Hz target). Needs a built app.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { frameStats, initRepo } from "./lib/sessionFlow.ts";

const args = process.argv.slice(2);

const mode = args[0];

if (
  mode !== "chip" &&
  mode !== "scroll" &&
  mode !== "usage" &&
  mode !== "hover" &&
  mode !== "typing" &&
  mode !== "scene"
)
  throw new Error("usage: hitches.ts <chip|usage|hover|typing|scene|scroll> …");

const option = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const realHome = args.includes("--real-home");

const turns = Number(option("--turns") ?? 25);

const profileOut = option("--profile");

const traceOut = option("--trace");

const log = (m: string) => console.log(`hitches: ${m}`);

const home = mkdtempSync(join(tmpdir(), "polaris-hitches-"));

const userHome = join(home, "user-home");

mkdirSync(userHome, { recursive: true });

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ welcomeSeen: true, theme: "dark" })
);

const daemon = await startDaemon({
  home,
  benchHarness: true,
  userHome: realHome ? homedir() : userHome,
});

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const bench = (script: Record<string, number>) => `bench:${JSON.stringify(script)}`;

/** Starts collecting long-animation-frame entries and rAF times; `stop()` returns both. */
const OBSERVE = `(() => {
  const loaf = [];
  const times = [];
  let on = true;
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      loaf.push({
        at: Math.round(e.startTime), duration: Math.round(e.duration),
        blocking: Math.round(e.blockingDuration ?? 0),
        render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0),
        style: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0),
        scripts: (e.scripts ?? []).map((s) => ({
          duration: Math.round(s.duration), invoker: s.invoker, fn: s.sourceFunctionName,
          src: (s.sourceURL ?? "").split("/").pop() + ":" + s.sourceCharPosition,
          layout: Math.round(s.forcedStyleAndLayoutDuration ?? 0),
        })),
      });
    }
  });
  observer.observe({ type: "long-animation-frame", buffered: false });
  const tick = (t) => { times.push(t); if (on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__hitches = {
    stop: () => { on = false; observer.disconnect(); return { loaf, times }; },
    now: () => performance.now(),
  };
})()`;

interface Loaf {
  readonly at: number;
  readonly duration: number;
  readonly blocking: number;
  readonly render: number;
  readonly style: number;
  readonly scripts: ReadonlyArray<{
    readonly duration: number;
    readonly invoker: string;
    readonly fn: string;
    readonly src: string;
    readonly layout: number;
  }>;
}

interface Observed {
  readonly loaf: ReadonlyArray<Loaf>;
  readonly times: ReadonlyArray<number>;
}

const stop = (page: Page) => page.evaluate<Observed>("window.__hitches.stop()");

interface Spike {
  readonly at: number;
  readonly lag: number;
}

declare global {
  // The main-process lag monitor between startMainLag and stopMainLag.
  var __mainLag: { readonly stop: () => ReadonlyArray<Spike> } | undefined;
}

/** Event-loop lag in Electron's main process: a blocked main thread delays every window's frames. */
const startMainLag = () =>
  app.evaluate(() => {
    const spikes: Array<Spike> = [];
    let last = performance.now();

    const timer = setInterval(() => {
      const now = performance.now();

      if (now - last > 20) spikes.push({ at: Date.now(), lag: Math.round(now - last - 5) });

      last = now;
    }, 5);

    globalThis.__mainLag = {
      stop: () => {
        clearInterval(timer);

        return spikes;
      },
    };
  });

const stopMainLag = async () => {
  const spikes = await app.evaluate(() => globalThis.__mainLag?.stop() ?? []);
  const shown = spikes.map((spike) => `${spike.lag} ms @${spike.at % 100_000}`);

  log(`main-process lag over 20 ms: ${shown.length === 0 ? "none" : shown.join(", ")}`);
};

const report = (label: string, result: Awaited<ReturnType<typeof stop>>, marks: Array<string>) => {
  const { loaf, times } = result;

  const long = times.slice(1).flatMap((t, i) => {
    const gap = t - (times[i] ?? t);

    return gap > 16.7 ? [`${gap.toFixed(1)} ms @${Math.round(t)}`] : [];
  });

  log(`${label} frames: ${JSON.stringify(frameStats(times))}`);
  log(`${label} frames over 16.7 ms: ${long.length === 0 ? "none" : long.join(", ")}`);

  if (marks.length > 0) log(`${label} marks: ${marks.join(", ")}`);

  for (const entry of loaf.filter((e) => e.duration > 16.7)) {
    const scripts = entry.scripts
      .filter((s) => s.duration > 1)
      .map((s) => `${s.invoker} ${s.fn || "(anon)"} ${s.src} ${s.duration}ms (layout ${s.layout})`)
      .join(" ; ");

    log(
      `  LoAF @${entry.at} ${entry.duration} ms (render+style ${entry.render}/${entry.style}) ${scripts}`
    );
  }
};

/** A Chromium trace of every process (renderer, GPU, compositor), via Electron's contentTracing. */
const startTrace = async () => {
  if (traceOut === null) return null;
  await app.evaluate(({ contentTracing }) =>
    contentTracing.startRecording({
      included_categories: [
        "toplevel",
        "blink",
        "cc",
        "gpu",
        "viz",
        "benchmark",
        "v8",
        "loading",
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "disabled-by-default-v8.gc",
      ],
    })
  );

  return async () => {
    const path = await app.evaluate(({ contentTracing }) => contentTracing.stopRecording());

    writeFileSync(traceOut, await import("node:fs").then((fs) => fs.readFileSync(path)));
    log(`trace at ${traceOut}`);
  };
};

const startProfile = async (page: Page) => {
  const endTrace = await startTrace();

  if (profileOut === null) return endTrace;
  const cdp = await page.context().newCDPSession(page);

  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");

  return async () => {
    await endTrace?.();
    const { profile } = await cdp.send("Profiler.stop");

    writeFileSync(profileOut, JSON.stringify(profile));
    log(`CPU profile at ${profileOut}`);
  };
};

/** The proof session, then a long streaming Turn; returns once it streams. */
const streaming = async (page: Page) => {
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("dev-proof")?.click();
  });
  await page.getByTestId("session-panel").waitFor({ timeout: 30_000 });
  await page.getByTestId("session-state").filter({ hasText: /^Idle/ }).waitFor({ timeout: 90_000 });
  await page
    .getByTestId("composer-input")
    .fill(bench({ items: 30, deltasPerItem: 100, deltaBytes: 64, deltaIntervalMs: 10 }));
  await page.keyboard.press("Enter");
  await page
    .getByTestId("session-state")
    .filter({ hasText: /^Working/ })
    .waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
};

/** While streaming: every frame's distance from the conversation's end (px); it should stay pinned. */
const pinned = async (page: Page, ms: number) => {
  const gaps = await page.evaluate<Array<number>>(`new Promise((resolve) => {
    const el = document.querySelector('[data-testid="conversation"]');
    const gaps = []; const end = performance.now() + ${ms};
    // After the frame is painted (a task after rAF), where ResizeObserver has adjusted the offset.
    const tick = (t) => setTimeout(() => { gaps.push(el.scrollHeight - el.scrollTop - el.clientHeight); if (t < end) requestAnimationFrame(tick); else resolve(gaps); }, 0);
    requestAnimationFrame(tick);
  })`);

  const off = gaps.filter((g) => g > 48);

  log(
    `pinned while streaming: ${gaps.length - off.length}/${gaps.length} frames within 48 px of the end (max ${Math.max(...gaps)} px)`
  );
};

/** Settings → Usage while a Turn streams: the first `usage.query` and `usage.watch`. */
const usage = async (page: Page) => {
  await streaming(page);
  await startMainLag();
  await page.evaluate(OBSERVE);
  const endProfile = await startProfile(page);
  const marks: Array<string> = [];

  const at = async (name: string) =>
    marks.push(
      `${name}@${Math.round(await page.evaluate<number>("window.__hitches.now()"))}/${Date.now() % 100000}`
    );

  await page.waitForTimeout(1000);
  await at("settings");
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings").waitFor({ timeout: 10_000 });
  await at("usage");
  await page.getByRole("button", { name: "Usage" }).click();
  await page.locator('[data-section="usage"]').waitFor({ timeout: 10_000 });
  await at("shown");
  await page
    .getByTestId("usage-indexing")
    .waitFor({ state: "detached", timeout: 60_000 })
    .catch(() => undefined);
  await at("indexed");
  await page.waitForTimeout(1500);
  await endProfile?.();
  await stopMainLag();
  report("usage", await stop(page), marks);
};

const chip = async (page: Page) => {
  await streaming(page);

  if (args.includes("--pinned")) await pinned(page, 3000);

  await page.evaluate(OBSERVE);
  const endProfile = await startProfile(page);

  await page.waitForTimeout(1000);
  const marks: Array<string> = [];

  const at = async (name: string) =>
    marks.push(`${name}@${Math.round(await page.evaluate<number>("window.__hitches.now()"))}`);

  await startMainLag();
  await at("click");
  await page.getByTestId("model-picker").first().click();
  await page.locator('[role="menu"]').first().waitFor({ timeout: 10_000 });
  await at("open");

  if (args.includes("--screenshot")) {
    await page.screenshot({ path: join(home, "shot.png") });
    await at("shot");
  }

  await page.waitForTimeout(2000);
  await page.keyboard.press("Escape");
  await at("closed");
  await page.waitForTimeout(800);
  await at("reopen");
  await page.getByTestId("model-picker").first().click();
  await page.locator('[role="menu"]').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  await endProfile?.();
  await stopMainLag();
  report("chip", await stop(page), marks);
};

/** Saves the Working composer in both themes: at rest, hovered after a sweep, and blooming. */
const composerShots = async (page: Page, dir: string) => {
  mkdirSync(dir, { recursive: true });
  const composer = page.locator('[data-slot="composer"][data-working]').first();
  const box = await composer.boundingBox();

  if (box === null) throw new Error("no Working composer");

  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
    await page.mouse.move(box.x - 40, box.y - 40);
    await page.waitForTimeout(1500);
    await composer.screenshot({ path: join(dir, `composer-${theme}-rest.png`) });
    await page.mouse.move(box.x + 12, box.y + 16, { steps: 4 });
    await page.mouse.move(box.x + box.width * 0.4, box.y + 14, { steps: 24 });
    await page.waitForTimeout(60);
    await composer.screenshot({ path: join(dir, `composer-${theme}-hover.png`) });
  }

  // A new Turn mounts the strip, which blooms; catch it near its peak.
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
    await page.mouse.move(box.x - 40, box.y - 40);
    await page.keyboard.press("Escape");
    await page
      .getByTestId("session-state")
      .filter({ hasText: /^Idle/ })
      .waitFor({ timeout: 30_000 });
    await page
      .getByTestId("composer-input")
      .fill(bench({ items: 30, deltasPerItem: 100, deltaBytes: 64, deltaIntervalMs: 10 }));
    await page.keyboard.press("Enter");
    await composer.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(420);
    await composer.screenshot({ path: join(dir, `composer-${theme}-bloom.png`) });
  }

  // With the Daemon gone, a steer can't be sent, which toasts (bottom-right).
  await daemon.stop();
  await page.waitForTimeout(1500);

  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
    await page.getByTestId("composer-input").fill("steer");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(dir, `window-${theme}.png`) });
  }
};

/** While a Turn streams: the pointer sweeps back and forth over the composer's dither field. */
const hover = async (page: Page) => {
  await streaming(page);
  const composer = page.locator('[data-slot="composer"][data-working]').first();
  const box = await composer.boundingBox();

  if (box === null) throw new Error("no Working composer");
  await page.mouse.move(box.x - 40, box.y - 40);
  await page.evaluate(OBSERVE);
  const endProfile = await startProfile(page);

  await startMainLag();

  for (let pass = 0; pass < 6; pass++) {
    const [from, to] = pass % 2 === 0 ? [4, box.width - 4] : [box.width - 4, 4];

    await page.mouse.move(box.x + from, box.y + 10 + pass * 4, { steps: 4 });
    await page.mouse.move(box.x + to, box.y + 30 - pass * 3, { steps: 60 });

    if (pass === 2) await page.mouse.down().then(() => page.mouse.up());
  }

  await page.mouse.move(box.x - 40, box.y - 40, { steps: 4 });
  await page.waitForTimeout(800);
  await endProfile?.();
  await stopMainLag();
  report("hover", await stop(page), []);

  const shots = option("--shots");

  if (shots !== null) await composerShots(page, shots);
};

/** From each keydown to the frame that shows it: after the next rAF, once that frame is painted. */
const KEY_LATENCY = `(() => {
  const lat = [];
  const onKey = (e) => {
    const t = e.timeStamp;
    requestAnimationFrame(() => setTimeout(() => lat.push(performance.now() - t), 0));
  };
  document.addEventListener("keydown", onKey, { capture: true });
  window.__keys = { stop: () => { document.removeEventListener("keydown", onKey, { capture: true }); return lat; } };
})()`;

const TYPED =
  "Tighten the session rows so long titles truncate cleanly, keep the state dot aligned, " +
  "and check the compact density.";

/** Types into the composer as a person would (~25 ms a key) and reports key-to-paint latency. */
const typeAndMeasure = async (page: Page, label: string) => {
  const input = page.locator('[data-testid="composer-input"]:visible');

  await input.click();
  await page.evaluate(OBSERVE);
  await page.evaluate(KEY_LATENCY);
  // Opens the / menu, picks the first match with ⇥ (a chip), then types the prompt.
  await page.keyboard.type("/com", { delay: 25 });
  const menu = await page.getByTestId("command-menu").count();

  await page.keyboard.press("Tab");
  await page.keyboard.type(TYPED, { delay: 25 });
  await page.waitForTimeout(300);

  const lat = [...(await page.evaluate<ReadonlyArray<number>>("window.__keys.stop()"))].sort(
    (a, b) => a - b
  );

  const at = (q: number) =>
    (lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? 0).toFixed(1);

  log(
    `${label} key-to-paint: p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms over ${lat.length} keys`
  );
  report(label, await stop(page), []);
  const chips = await page.locator('[data-testid="composer-input"]:visible .composer-chip').count();

  log(`${label}: / menu opened ${menu > 0 ? "yes" : "no"}, chips after ⇥ ${chips}`);
  await page.keyboard.press("Escape");
  await input.fill("");
};

/** Typing a prompt with the / menu: on an Idle session, then while a Turn streams. */
const typing = async (page: Page) => {
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("dev-proof")?.click();
  });
  await page.getByTestId("session-panel").waitFor({ timeout: 30_000 });
  await page.getByTestId("session-state").filter({ hasText: /^Idle/ }).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(500);
  await typeAndMeasure(page, "typing idle");
  await page
    .getByTestId("composer-input")
    .fill(bench({ items: 30, deltasPerItem: 100, deltaBytes: 64, deltaIntervalMs: 10 }));
  await page.keyboard.press("Enter");
  await page
    .getByTestId("session-state")
    .filter({ hasText: /^Working/ })
    .waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  const endProfile = await startProfile(page);

  await typeAndMeasure(page, "typing while streaming");
  await endProfile?.();
};

/** Every 120ms for `ms`, a window frame into `dir` (for a short recording of the scene). */
const record = async (page: Page, dir: string, name: string, ms: number) => {
  mkdirSync(dir, { recursive: true });
  const end = Date.now() + ms;

  for (let i = 0; Date.now() < end; i++) {
    await page.screenshot({
      path: join(dir, `${name}-${String(i).padStart(3, "0")}.png`),
      scale: "css",
    });
    await page.waitForTimeout(120);
  }
};

/** The first-run stage's scene: frames while it lives (twinkles, lamp, smoke) and a meteor or flock passes. */
const scene = async (page: Page) => {
  await page
    .locator('[data-slot="scene-motion"]')
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
  await page.waitForTimeout(1500);

  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
    await page.waitForTimeout(500);
    await page.evaluate(OBSERVE);
    await page.evaluate("window.__polarisScene?.summon()");
    await page.waitForTimeout(700);
    log(
      `scene ${theme} visitor: ${JSON.stringify(await page.evaluate("window.__polarisScene?.flying()"))}`
    );
    await page.waitForTimeout(theme === "dark" ? 3300 : 7300);
    report(`scene ${theme}`, await stop(page), []);
  }

  // Reduce Motion: the layer stops and clears, so only the still scene shows.
  const lit = `(() => { const c = document.querySelector('[data-slot="scene-motion"] canvas'); const d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()`;

  log(`scene lit pixels moving: ${await page.evaluate<number>(lit)}`);
  await page.evaluate(`document.documentElement.dataset.reduceMotion = "true"`);
  await page.waitForTimeout(1200);
  log(`scene lit pixels under Reduce Motion: ${await page.evaluate<number>(lit)}`);
  await page.evaluate(`delete document.documentElement.dataset.reduceMotion`);

  const shots = option("--shots");

  if (shots === null) return;

  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
    await page.waitForTimeout(400);
    await page.evaluate("window.__polarisScene?.summon()");
    await page.waitForTimeout(theme === "dark" ? 200 : 4500);
    await record(page, join(shots, "frames"), theme, theme === "dark" ? 3500 : 14_000);
  }
};

const scroll = async (page: Page) => {
  const repo = join(home, "heavy");

  initRepo(repo);
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(repo)}, name: "heavy" } })`
  );
  await page.getByRole("button", { name: /heavy/ }).first().click();
  // Let availability settle before New session (see V2 bug 1).
  await page.waitForTimeout(5000);
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.locator('[role="radiogroup"][aria-label="Harness"] [aria-checked="true"]').waitFor();

  const turn = bench({
    items: 60,
    deltasPerItem: 20,
    deltaIntervalMs: 1,
    deltaBytes: 64,
    itemBytes: 6000,
    touchFiles: 3,
  });

  const input = page.getByTestId("composer-input");

  await input.fill(turn);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByTestId("session-panel").waitFor({ timeout: 15_000 });

  for (let i = 0; i < turns; i++) {
    if (i > 0) {
      await input.fill(turn);
      await input.press("Enter");
    }

    await page
      .getByTestId("session-state")
      .filter({ hasText: /^Working/ })
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    await page
      .getByTestId("session-state")
      .filter({ hasText: /^Idle/ })
      .waitFor({ timeout: 120_000 });
  }

  log(`heavy session: ${turns} Turns × 60 items of 6 KB`);
  await page.waitForTimeout(1000);

  for (const [label, px] of [
    ["scroll 60px/frame", 60],
    ["scroll 200px/frame", 200],
  ] as const) {
    await page.evaluate(`document.querySelector('[data-testid="conversation"]').scrollTop = 1e9`);
    await page.waitForTimeout(500);
    await page.evaluate(OBSERVE);
    const endProfile = label.startsWith("scroll 60") ? await startProfile(page) : null;

    await page.evaluate(`new Promise((resolve) => {
      const el = document.querySelector('[data-testid="conversation"]');
      const end = performance.now() + 5000;
      const tick = (t) => { el.scrollTop -= ${px}; if (t < end && el.scrollTop > 0) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    })`);
    await endProfile?.();
    report(label, await stop(page), []);
  }
};

let failed = false;

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page.emulateMedia({ colorScheme: null });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .first()
    .waitFor({ timeout: 30_000 });
  await { chip, usage, hover, typing, scene, scroll }[mode](page);
} catch (error) {
  failed = true;
  console.error("hitches: FAILED", error);
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
