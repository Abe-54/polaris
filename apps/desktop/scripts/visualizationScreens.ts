#!/usr/bin/env node
/**
 * Visualizations in the real app (ENG-598), on the `#preview/visualizations` fixtures: each state's
 * screenshot, the sandbox checks (origin, network, navigation, WebRTC, foreign messages), live
 * theme and pv.state, then the 30-frame budget and scroll performance. Prints one JSON report.
 *
 *   node scripts/visualizationScreens.ts --out <dir> [--build]
 */
import { spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { Schema } from "effect";
import { type Frame, type Page } from "playwright-core";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { startDaemon } from "./lib/daemon.ts";
import { frameStats } from "./lib/sessionFlow.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

mkdirSync(out, { recursive: true });

/** Each check's outcome, and the measurements. */
const report = new Map<string, Schema.Json>();

const check = (name: string, pass: boolean, detail: Schema.Json = null) => {
  report.set(name, { pass, detail });
  console.log(
    `${pass ? "ok  " : "FAIL"} ${name}${detail === null ? "" : ` ${JSON.stringify(detail)}`}`
  );
};

// A short path: the Daemon's Unix socket lives under it.
const home = mkdtempSync("/tmp/pv-");

const daemon = await startDaemon({ home: join(home, "d"), benchHarness: true });

// Any UDP packet here means WebRTC got out of a frame.
const stun = createSocket("udp4");

let udpPackets = 0;

stun.on("message", () => (udpPackets += 1));

await new Promise<void>((resolve) => stun.bind(0, "127.0.0.1", resolve));

const stunPort = stun.address().port;

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: join(home, "u"),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

/** Every request the app's session starts, except its own pages and frame documents. */
await app.evaluate(({ session }) => {
  const seen: Array<string> = [];

  // SAFETY: a test-only global on the main process, read back by `outside`.
  const holder = globalThis as typeof globalThis & { pvSeen?: Array<string> };

  holder.pvSeen = seen;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!/^(app|devtools|chrome-extension|http:\/\/localhost|ws:\/\/localhost):/.test(details.url))
      seen.push(details.url);
    callback({});
  });
});

const outside = () =>
  app.evaluate(() => {
    // SAFETY: set above, before any page loads.
    const holder = globalThis as typeof globalThis & { pvSeen?: Array<string> };

    return holder.pvSeen?.slice() ?? [];
  });

const shot = (page: Page, name: string) => page.screenshot({ path: join(out, `${name}.png`) });

const card = (page: Page, id: string) => page.locator(`[data-visualization="viz_${id}"]`);

const frameOf = async (page: Page, id: string): Promise<Frame> => {
  const element = card(page, id).locator("iframe");

  await card(page, id).scrollIntoViewIfNeeded();
  await element.waitFor({ state: "attached" });
  await card(page, id).locator("iframe:not(.opacity-0)").waitFor();
  const handle = await element.elementHandle();
  const frame = await handle?.contentFrame();

  if (frame === null || frame === undefined) throw new Error(`no frame for ${id}`);
  await frame.waitForLoadState("load");

  return frame;
};

const open = async (page: Page, scene: string) => {
  await page.evaluate(`location.hash = "#preview/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("session-panel").first().waitFor();
};

const setTheme = (page: Page, theme: "dark" | "light") =>
  page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${theme}" })`);

const liveFrames = (page: Page) => page.locator('[data-testid="visualization-frame"]').count();

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await setTheme(page, "dark");
  await open(page, "visualizations");
  await page.waitForTimeout(1000);

  // V1: shown, inline, sized to its content.
  await card(page, "v3").scrollIntoViewIfNeeded();
  const loan = await frameOf(page, "v3");

  await page.waitForTimeout(800);
  await shot(page, "v1-shown");

  const height = await card(page, "v3")
    .locator("iframe")
    .evaluate((el: { readonly clientHeight: number }) => el.clientHeight);

  check("frame sized to its content", height !== 320 && height >= 80, { height });

  // The sandbox.
  const sandbox = await loan.evaluate<Schema.Json>(`(async () => {
    const result = { origin: String(origin) };
    try { void parent.document; result.parentDocument = "readable"; } catch { result.parentDocument = "blocked"; }
    try { result.bridge = typeof parent.polaris; } catch { result.bridge = "blocked"; }
    try { await fetch("https://example.com/?leak=fetch"); result.fetch = "sent"; } catch { result.fetch = "blocked"; }
    result.image = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve("loaded");
      img.onerror = () => resolve("blocked");
      img.src = "https://example.com/leak.png";
    });
    result.rtc = typeof RTCPeerConnection;
    return result;
  })()`);

  check(
    "frame is sandboxed and offline",
    JSON.stringify(sandbox) ===
      JSON.stringify({
        origin: "null",
        parentDocument: "blocked",
        bridge: "blocked",
        fetch: "blocked",
        image: "blocked",
        rtc: "undefined",
      }),
    sandbox
  );

  // WebRTC from a nested frame, past the bootstrap: the host policy must stop the STUN packets.
  await loan.evaluate(`(() => {
    const inner = document.createElement("iframe");
    inner.srcdoc = "<script>try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stunPort}' }] }); pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)); } catch {}<" + "/script>";
    document.body.append(inner);
  })()`);
  await page.waitForTimeout(3000);
  check("no UDP leaves a frame (WebRTC)", udpPackets === 0, { udpPackets });

  // A foreign window's message is ignored: the app's own window posting a link.
  await page.evaluate(
    `window.postMessage({ type: "pv:open-link", url: "https://example.com/foreign" }, "*")`
  );
  await page.waitForTimeout(300);
  check(
    "a message from another window is ignored",
    (await page.getByTestId("visualization-link").count()) === 0
  );

  // Non-https links never ask.
  await loan.evaluate(
    `parent.postMessage({ type: "pv:open-link", url: "http://example.com/plain" }, "*")`
  );
  await page.waitForTimeout(300);
  check(
    "an http link is dropped without a dialog",
    (await page.getByTestId("visualization-link").count()) === 0
  );

  // V5: an https link asks.
  await loan.evaluate(
    `parent.postMessage({ type: "pv:open-link", url: "https://www.consumerfinance.gov/owning-a-home/loan-options/" }, "*")`
  );
  await page.getByTestId("visualization-link").waitFor();
  await shot(page, "v5-open-link");
  await page.getByRole("button", { name: "Cancel" }).click();

  // Live theme: tokens change in the same document, no remount.
  const bgBefore = await loan.evaluate<string>(
    `getComputedStyle(document.documentElement).getPropertyValue("--pv-bg").trim()`
  );

  const urlBefore = loan.url();

  await setTheme(page, "light");
  await page.waitForTimeout(600);

  const bgAfter = await loan.evaluate<string>(
    `getComputedStyle(document.documentElement).getPropertyValue("--pv-bg").trim()`
  );

  check(
    "live theme reaches the frame without a remount",
    bgBefore !== bgAfter && loan.url() === urlBefore && !loan.isDetached(),
    {
      bgBefore,
      bgAfter,
    }
  );
  await shot(page, "v1-shown-light");
  await setTheme(page, "dark");
  await page.waitForTimeout(400);

  // V4: Expand, then Esc.
  await card(page, "v3").getByTestId("visualization-expand").click();
  await page.getByTestId("visualization-expanded").locator("iframe").waitFor();
  await page.waitForTimeout(1000);
  await shot(page, "v4-expanded");
  await page.keyboard.press("Escape");
  check("Esc closes Expanded", (await page.getByTestId("visualization-expanded").count()) === 0);

  // V3: the revised one collapses; a click opens it in place.
  await page.locator('[data-phase="revised"]').first().scrollIntoViewIfNeeded();
  await shot(page, "v3-revised-below");
  check(
    "the replaced Visualization is revised below",
    (await page.locator('[data-phase="revised"]').count()) === 1
  );

  // Navigation: a frame that sends itself away is refused before any request.
  const flow = await frameOf(page, "v4");

  await flow
    .evaluate(`location.href = "https://example.com/?leak=navigate"`)
    .catch(() => undefined);
  await card(page, "v4")
    .locator('[data-testid="visualization-stopped"]')
    .waitFor({ timeout: 10_000 });
  check(
    "a frame that tries to navigate is refused, then removed",
    !(await outside()).some((url) => url.includes("leak=navigate")) &&
      (await card(page, "v4").locator("iframe").count()) === 0
  );

  // V6: a frame that loads a second page is stopped.
  await card(page, "v5").scrollIntoViewIfNeeded();
  await card(page, "v5")
    .locator('[data-testid="visualization-stopped"]')
    .waitFor({ timeout: 10_000 });
  check("a second load stops the frame", (await card(page, "v5").locator("iframe").count()) === 0);
  await shot(page, "v6-stopped");

  // V2: the drawing placeholder at the end of the working Turn.
  await page.locator('[data-phase="drawing"]').scrollIntoViewIfNeeded();
  await shot(page, "v2-drawing");

  const reserved = await page
    .locator('[data-phase="drawing"]')
    .evaluate((el: { readonly clientHeight: number }) => el.clientHeight);

  check("drawing reserves its space", reserved >= 320, { reserved });

  // pv.state: the timeline's choice survives a reload, from this device's storage.
  const timeline = await frameOf(page, "v6");

  await timeline.locator("li").nth(1).click();
  await page.waitForTimeout(300);
  await open(page, "visualizations");
  await card(page, "v6").scrollIntoViewIfNeeded();
  const again = await frameOf(page, "v6");

  await page.waitForTimeout(500);
  const restored = await again.locator('li[aria-current="true"]').count();

  const index = await again.evaluate<number>(
    `[...document.querySelectorAll("li")].findIndex((li) => li.getAttribute("aria-current") === "true")`
  );

  check("pv.state comes back after a reload", restored === 1 && index === 1, { index });

  const leaked = (await outside()).filter(
    (url) => url.includes("example.com") || url.includes("127.0.0.1")
  );

  check("no request left the app", leaked.length === 0, leaked);

  const metrics = () =>
    app.evaluate(({ app: electronApp }) => {
      const all = electronApp.getAppMetrics();

      return {
        processes: all.length,
        workingSetMB: Math.round(all.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024),
      };
    });

  await open(page, "polaris");
  await page.waitForTimeout(2500);
  report.set("baselineNoVisualizations", await metrics());

  // Thirty Visualizations: the frame budget and scrolling.
  await open(page, "visualizations-30");
  await page.waitForTimeout(2500);
  const atRest = await liveFrames(page);

  const scroll = await page.evaluate<{
    times: Array<number>;
    maxLive: number;
    height: number;
  }>(`new Promise((resolve) => {
    const el = document.querySelector('[data-testid="conversation"]');
    el.scrollTop = 0;
    const times = [];
    let maxLive = 0;
    const start = performance.now();
    const tick = (t) => {
      times.push(t);
      maxLive = Math.max(maxLive, document.querySelectorAll('[data-testid="visualization-frame"]').length);
      el.scrollTop = ((t - start) / 1000) * 3000;
      if (t - start < 6000) requestAnimationFrame(tick); else resolve({ times, maxLive, height: el.scrollHeight });
    };
    requestAnimationFrame(tick);
  })`);

  await page.waitForTimeout(1500);
  const memory = await metrics();

  const perf30 = {
    liveAtRest: atRest,
    maxLiveWhileScrolling: scroll.maxLive,
    scrollHeight: scroll.height,
    frames: frameStats(scroll.times),
    afterScroll: memory,
  };

  check("at most four live frames", atRest <= 4 && scroll.maxLive <= 4, perf30);
  report.set("perf30", perf30);
  await shot(page, "perf-30");
} finally {
  console.log(`report ${JSON.stringify(Object.fromEntries(report))}`);
  await app.close();
  stun.close();
  await daemon.stop();
}
