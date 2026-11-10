/**
 * computer-use-preview: the live preview of a TextEdit window (ENG-846), measured on the real
 * Daemon with its real capture tool. macOS only, with a compiled Daemon (`--binary`) whose
 * Polaris Computer Use.app holds Screen Recording; skipped otherwise.
 *
 * A scratch document is opened in TextEdit in the background and a letter is added to it by
 * AppleScript every 50 ms (macOS asks once to let the terminal control TextEdit).
 * Phases: nobody watching; watching at the local cap; at the remote cap; the typing over
 * (a window that no longer changes); then unsubscribed.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW_MAX_FPS, type PreviewLink, PreviewItem, SessionId } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import {
  awaitReady,
  type Client,
  connect,
  createTempDir,
  cleanup,
  type Daemon,
} from "../daemon.ts";
import { registerWorkspace, settle, startSession, waitUntil, watchSession } from "../drive.ts";
import { smallRepo } from "../fixtures.ts";
import type { Sampler } from "../sampler.ts";
import {
  count,
  cpu,
  type Metric,
  memory,
  type ScenarioRun,
  type Scenario,
  throughput,
  time,
} from "../types.ts";

const CAPABILITY = "computer-use.preview";

const EDGE_PX = 640;

const KEYSTROKE_MS = 50;

const skipped = (why: string): ScenarioRun => ({ metrics: {}, notes: [`skipped: ${why}`] });

const run = async (argv: ReadonlyArray<string>) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}: ${stdout.slice(0, 400)}`);

  return stdout;
};

const osascript = (script: string) => run(["/usr/bin/osascript", "-e", script]);

/** WindowServer's CPU seconds so far, from `ps`; null when it can't be read. */
const windowServerSeconds = async () => {
  const text = await run([
    "/bin/sh",
    "-c",
    "ps -o time= -p $(pgrep -x WindowServer | head -1)",
  ]).catch(() => "");

  const match = /(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/.exec(text);

  return match === null
    ? null
    : Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
};

interface Watched {
  frames: number;
  bytes: number;
  idles: Array<string>;
}

/** Watches the session's preview like a Client that shows it: every frame's blob is taken. */
const watch = (client: Client, sessionId: SessionId, link: PreviewLink) =>
  Effect.gen(function* () {
    const seen: Watched = { frames: 0, bytes: 0, idles: [] };

    yield* client.connection.client["computerUse.preview.watch"]({
      sessionId,
      maxEdgePx: EDGE_PX,
      link,
    }).pipe(
      Stream.runForEach((item) =>
        PreviewItem.guards.Frame(item)
          ? Effect.map(client.connection.blobs.take(item.frame.blobId), (jpeg) => {
              seen.frames += 1;
              seen.bytes += jpeg.length;
            })
          : Effect.sync(() => void seen.idles.push(item.reason))
      ),
      Effect.forkScoped
    );

    return seen;
  });

/** The Daemon's own processes besides itself: the helper's launcher and the capture tool. */
const captureProcesses = (sampler: Sampler) => sampler.sample().processes - 1;

/** Tree CPU and WindowServer's over `ms`, with whatever `seen` counted in that time. */
const measure = (sampler: Sampler, ms: number, seen: Watched | null) =>
  Effect.gen(function* () {
    const from = sampler.sample().t;
    const frames = seen?.frames ?? 0;
    const bytes = seen?.bytes ?? 0;
    const server = yield* Effect.promise(windowServerSeconds);
    yield* settle(ms);
    const after = yield* Effect.promise(windowServerSeconds);
    const report = sampler.report(from - 1, sampler.sample().t);
    const got = (seen?.frames ?? 0) - frames;

    return {
      cpuPct: report.cpuAvgPct,
      rssBytes: report.rssBytes.median,
      fps: got / (ms / 1000),
      frameBytes: got === 0 ? 0 : ((seen?.bytes ?? 0) - bytes) / got,
      windowServerPct:
        server === null || after === null ? null : ((after - server) / (ms / 1000)) * 100,
    };
  });

/** Opens a scratch document in TextEdit without bringing it forward; answers its window id. */
const openDocument = () =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = createTempDir("preview-doc");
      const name = `polaris-preview-${process.pid}.txt`;
      const running = (await run(["/bin/sh", "-c", "pgrep -x TextEdit || true"])).trim() !== "";
      writeFileSync(join(dir, name), "The Polaris bench types here.\n", { flag: "wx" });
      await run(["/usr/bin/open", "-g", "-a", "TextEdit", join(dir, name)]);

      for (let tries = 0; tries < 100; tries++) {
        // A Cocoa window's AppleScript id is its CGWindowID, which the capture tool takes.
        const id = await osascript(
          `tell application "TextEdit" to get id of (first window whose name is "${name}")`
        ).catch(() => "");

        if (id.trim() !== "") return { dir, name, window: { id: id.trim(), title: name }, running };
        await Bun.sleep(100);
      }

      throw new Error("TextEdit did not open the scratch document");
    }),
    // TextEdit is quit only when this scenario started it; else only the document is closed.
    ({ dir, name, running }) =>
      Effect.promise(() =>
        (running
          ? osascript(`tell application "TextEdit" to close document "${name}" saving no`)
          : run(["/usr/bin/pkill", "-x", "TextEdit"])
        )
          .catch(() => "")
          .finally(() => cleanup(dir))
      )
  );

/** Adds a letter to the document every `KEYSTROKE_MS` for `seconds`, in the background. */
const startTyping = (name: string, seconds: number) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(
        [
          "/usr/bin/osascript",
          "-e",
          `tell application "TextEdit"
  repeat ${Math.ceil((seconds * 1000) / KEYSTROKE_MS)} times
    make new character at end of text of document "${name}" with data "p"
    delay ${KEYSTROKE_MS / 1000}
  end repeat
end tell`,
        ],
        { stdout: "ignore", stderr: "ignore" }
      )
    ),
    (proc) => Effect.sync(() => proc.kill())
  );

const prepare = (ctx: Parameters<Scenario["run"]>[0], daemon: Daemon) =>
  Effect.gen(function* () {
    yield* awaitReady(daemon);
    const client = yield* connect(daemon, ctx.transport, "preview");

    const root = yield* Effect.acquireRelease(
      Effect.sync(() => createTempDir("preview")),
      (dir) => Effect.sync(() => cleanup(dir))
    );

    const workspaceId = yield* registerWorkspace(client, smallRepo(join(root, "ws")), "ws");
    yield* startSession(client, {
      sessionId: "preview-0",
      workspaceId,
      script: { items: 2, deltasPerItem: 2, deltaIntervalMs: 1 },
    });
    const session = yield* watchSession(client, "preview-0");
    yield* waitUntil(() => session.state === "idle", 60_000, "preview-0 idle");

    return client;
  });

export const computerUsePreview: Scenario = {
  name: "computer-use-preview",
  description: "live preview of a TextEdit window: frames/s at each cap, dedupe, CPU, teardown",
  run: (ctx) =>
    Effect.gen(function* () {
      if (process.platform !== "darwin") return skipped("macOS only");

      // A first Daemon only says whether this build can capture; the window isn't open yet.
      const live = yield* Effect.scoped(
        Effect.gen(function* () {
          const daemon = yield* ctx.launch();
          yield* awaitReady(daemon);
          const client = yield* connect(daemon, ctx.transport, "probe");

          return client.capabilities.includes(CAPABILITY);
        })
      );

      if (!live)
        return skipped(
          "needs a compiled Daemon with its helper app (--binary from scripts/build-daemon.ts)"
        );

      const localS = ctx.quick ? 6 : 15;
      const remoteS = ctx.quick ? 5 : 10;
      const baseS = ctx.quick ? 3 : 5;
      const document = yield* openDocument();

      const daemon = yield* ctx.launch({
        env: {
          POLARIS_BENCH_PREVIEW_TARGET: JSON.stringify({
            app: { id: "com.apple.TextEdit", name: "TextEdit" },
            window: { id: document.window.id, title: document.window.title },
          }),
        },
      });

      const client = yield* prepare(ctx, daemon);
      const sessionId = SessionId.make("preview-0");
      const sampler = yield* ctx.sample(daemon, 250);
      const metrics: Record<string, Metric> = {};
      const notes: Array<string> = [];
      const exact = { tolerance: { relative: 0, absolute: 0 } };

      yield* settle(2000);
      metrics.unwatched_capture_processes = count(captureProcesses(sampler), "", exact);
      // Longer than the phases need: it is stopped by hand before the still phase.
      const typing = yield* startTyping(document.name, baseS + localS + remoteS + 60);
      yield* settle(1000);
      const base = yield* measure(sampler, baseS * 1000, null);

      const local = yield* Effect.scoped(
        Effect.gen(function* () {
          const seen = yield* watch(client, sessionId, "local");
          yield* waitUntil(
            () => seen.frames > 0 || seen.idles.includes("not-ready"),
            15_000,
            "a first frame"
          );
          metrics.watched_capture_processes = count(captureProcesses(sampler), "", { info: true });

          return { seen, measured: yield* measure(sampler, localS * 1000, seen) };
        })
      );

      if (local.seen.idles.includes("not-ready"))
        return skipped("Polaris Computer Use.app beside the Daemon has no Screen Recording grant");

      const stopped = performance.now();
      yield* waitUntil(() => captureProcesses(sampler) === 0, 10_000, "the capture tool to exit");
      metrics.stop_ms = time(performance.now() - stopped, {
        tolerance: { relative: 1, absolute: 500 },
      });

      const remote = yield* Effect.scoped(
        Effect.gen(function* () {
          const seen = yield* watch(client, sessionId, "remote");
          yield* waitUntil(() => seen.frames > 0, 15_000, "a first remote frame");

          return yield* measure(sampler, remoteS * 1000, seen);
        })
      );

      // The typing stops here: the window shows the same picture from now on.
      typing.kill();
      yield* Effect.promise(() => typing.exited);
      yield* settle(2000);

      const still = yield* Effect.scoped(
        Effect.gen(function* () {
          const seen = yield* watch(client, sessionId, "local");
          yield* waitUntil(() => seen.frames > 0, 15_000, "the still window's first frame");
          yield* settle(1500);

          return yield* measure(sampler, baseS * 1000, seen);
        })
      );

      yield* waitUntil(() => captureProcesses(sampler) === 0, 10_000, "the capture tool to exit");
      metrics.after_capture_processes = count(captureProcesses(sampler), "", exact);

      metrics.local_fps = throughput(local.measured.fps, "frames/s");
      metrics.local_cpu_pct = cpu(local.measured.cpuPct);
      metrics.local_rss_mib = memory(local.measured.rssBytes);
      metrics.local_frame_kib = count(local.measured.frameBytes / 1024, "KiB", { info: true });
      metrics.remote_fps = throughput(remote.fps, "frames/s");
      metrics.remote_cpu_pct = cpu(remote.cpuPct);
      metrics.still_fps = throughput(still.fps, "frames/s", {
        better: "lower",
        tolerance: { relative: 0, absolute: 0.5 },
      });
      metrics.still_cpu_pct = cpu(still.cpuPct);
      metrics.unwatched_cpu_pct = cpu(base.cpuPct, { info: true });

      for (const [name, phase] of Object.entries({
        unwatched: base,
        local: local.measured,
        remote,
        still,
      }))
        if (phase.windowServerPct !== null)
          metrics[`${name}_windowserver_cpu_pct`] = cpu(phase.windowServerPct, { info: true });

      notes.push(
        `${EDGE_PX}px JPEG of a TextEdit window that gains a letter every ${KEYSTROKE_MS} ms; caps are ${PREVIEW_MAX_FPS.local} frames/s local and ${PREVIEW_MAX_FPS.remote} remote`,
        "CPU is the Daemon's process tree, capture tool included; WindowServer is the whole system's, for comparison with the unwatched phase"
      );

      return { metrics, notes };
    }),
};
