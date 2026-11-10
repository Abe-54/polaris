/** The live preview's capture processes, with scripted tools standing in for the helper app's. */
import { expect, test } from "bun:test";
import { AppId, AppRef, AppWindow, SessionId } from "@polaris/protocol";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { captureLayer, EXIT_NOT_READY, windowNumber } from "./capture.ts";
import { fakeHelper, frameRecord, idleRecord, textRecord } from "./capture.testing.ts";
import { PreviewEvent, PreviewSource } from "./source.ts";
import { PreviewTargets } from "./targets.ts";

const session = SessionId.make("s1");

const textEdit = new AppRef({ id: AppId.make("com.apple.TextEdit"), name: "TextEdit" });

const windowOf = (id: number) => new AppWindow({ id: String(id), title: "Untitled" });

const local = { sessionId: session, edge: 640, link: "local" } as const;

const jpegOf = (byte: number) => new Uint8Array([0xff, 0xd8, byte, 0xff, 0xd9]);

const frame = (window: number, byte: number, width = 640) =>
  frameRecord({ window, width, height: 400, capturedAt: 1_794_000_000_000 + byte }, jpegOf(byte));

type Helper = ReturnType<typeof fakeHelper>;

const until = (what: string, done: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400 && !done(); tries++) yield* Effect.sleep("5 millis");

    if (!done()) return yield* Effect.die(`timed out waiting for ${what}`);
  });

/** Runs with a fresh helper, the capture layer over it (short retries) and empty targets. */
const run = <A>(
  body: (helper: Helper) => Effect.Effect<A, never, PreviewSource | PreviewTargets>
) => {
  const helper = fakeHelper();

  const layer = captureLayer({ retryNotReady: "30 millis", retryStopped: "30 millis" }).pipe(
    Layer.provideMerge(PreviewTargets.layer),
    Layer.provide(helper.layer)
  );

  return Effect.runPromise(Effect.scoped(body(helper).pipe(Effect.provide(layer))));
};

const act = (window: number) =>
  Effect.gen(function* () {
    const targets = yield* PreviewTargets;
    yield* targets.acted(session, { app: textEdit, window: windowOf(window), screenshot: null });
  });

/** What a watcher has seen so far, collected in the background until its fiber is interrupted. */
const watching = (request: Parameters<PreviewSource["Service"]["watch"]>[0] = local) =>
  Effect.gen(function* () {
    const source = yield* PreviewSource;
    const seen: Array<PreviewEvent> = [];

    const fiber = yield* source.watch(request).pipe(
      Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
      Effect.forkChild
    );

    return { seen, stop: Fiber.interrupt(fiber) };
  });

const bytesSeen = (seen: ReadonlyArray<PreviewEvent>) =>
  seen.map(
    PreviewEvent.$match({
      Frame: ({ image }) => image.jpeg[2],
      Idle: ({ reason }) => reason,
    })
  );

test("no tool runs until someone watches, watchers share one, and the last leaving kills it", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      yield* Effect.sleep("30 millis");
      expect(helper.tools).toHaveLength(0);

      const first = yield* watching();
      const second = yield* watching();
      yield* until(
        "the tool",
        () => helper.tools.length > 0 && helper.tools[0]!.commands.length > 0
      );
      yield* Effect.sleep("30 millis");
      expect(helper.tools).toHaveLength(1);
      expect(helper.tools[0]!.commands).toEqual([{ window: 7, edge: 640, fps: 10 }]);

      helper.tools[0]!.emit(frame(7, 1));
      yield* until("both to see it", () => first.seen.length > 0 && second.seen.length > 0);
      expect(first.seen).toEqual(second.seen);

      yield* first.stop;
      yield* Effect.sleep("30 millis");
      expect(helper.running()).toBe(1);

      yield* second.stop;
      expect(helper.running()).toBe(0);
    })
  ));

test("a frame carries the session's app and window; one of an older window is dropped", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const watcher = yield* watching();
      yield* until("the tool", () => helper.tools.length > 0);

      helper.tools[0]!.emit(frame(6, 1));
      helper.tools[0]!.emit(frame(7, 2));
      yield* until("a frame", () => watcher.seen.length > 0);

      expect(watcher.seen).toEqual([
        PreviewEvent.Frame({
          image: {
            jpeg: jpegOf(2),
            width: 640,
            height: 400,
            capturedAt: 1_794_000_000_002,
            app: textEdit,
            window: windowOf(7),
          },
        }),
      ]);
      yield* watcher.stop;
    })
  ));

test("a remote link captures at the remote rate, in a tool of its own", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const near = yield* watching();
      const far = yield* watching({ ...local, link: "remote" });
      yield* until(
        "both tools",
        () => helper.tools.filter((tool) => tool.commands.length > 0).length === 2
      );

      expect(
        helper.tools
          .flatMap((tool) => tool.commands)
          .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      ).toEqual([
        { window: 7, edge: 640, fps: 10 },
        { window: 7, edge: 640, fps: 2 },
      ]);
      yield* near.stop;
      yield* far.stop;
      expect(helper.running()).toBe(0);
    })
  ));

test("with no window yet the watcher is told so and no tool runs; acting starts one", () =>
  run((helper) =>
    Effect.gen(function* () {
      const watcher = yield* watching();
      yield* until("the idle", () => watcher.seen.length > 0);
      expect(bytesSeen(watcher.seen)).toEqual(["no-window"]);
      expect(helper.tools).toHaveLength(0);

      yield* act(7);
      yield* until(
        "the tool",
        () => helper.tools.length > 0 && helper.tools[0]!.commands.length > 0
      );
      expect(helper.tools[0]!.commands).toEqual([{ window: 7, edge: 640, fps: 10 }]);
      yield* watcher.stop;
    })
  ));

test("acting on another window retargets the running tool", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const watcher = yield* watching();
      yield* until(
        "the tool",
        () => helper.tools.length > 0 && helper.tools[0]!.commands.length > 0
      );

      yield* act(8);
      yield* until("the new target", () => helper.tools[0]!.commands.length > 1);
      helper.tools[0]!.emit(frame(8, 3));
      yield* until("its frame", () => watcher.seen.length > 0);

      expect(helper.tools).toHaveLength(1);
      expect(helper.tools[0]!.commands.at(-1)).toEqual({ window: 8, edge: 640, fps: 10 });
      expect(
        watcher.seen.map(
          PreviewEvent.$match({ Frame: ({ image }) => image.window?.id, Idle: () => null })
        )
      ).toEqual(["8"]);
      yield* watcher.stop;
    })
  ));

test("a slow watcher gets the newest frame, never a backlog", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const source = yield* PreviewSource;
      const busy = yield* Deferred.make<void>();
      const free = yield* Deferred.make<void>();
      const seen: Array<PreviewEvent> = [];

      // Takes one event, then is busy with it (a frame still being sent) until freed.
      const fiber = yield* source.watch(local).pipe(
        Stream.mapEffect((event) =>
          Effect.gen(function* () {
            seen.push(event);
            yield* Deferred.succeed(busy, undefined);
            yield* Deferred.await(free);
          })
        ),
        Stream.take(2),
        Stream.runDrain,
        Effect.forkChild
      );

      yield* until("the tool", () => helper.tools.length > 0);
      helper.tools[0]!.emit(frame(7, 1));
      yield* Deferred.await(busy);

      for (const byte of [2, 3, 4]) {
        helper.tools[0]!.emit(frame(7, byte));
        yield* Effect.sleep("10 millis");
      }

      yield* Deferred.succeed(free, undefined);
      yield* Fiber.join(fiber);
      expect(bytesSeen(seen)).toEqual([1, 4]);
    })
  ));

test("without the Screen Recording grant the watcher is told, and the tool is tried again", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const watcher = yield* watching();
      yield* until("the tool", () => helper.tools.length > 0);
      helper.tools[0]!.exit(EXIT_NOT_READY);

      yield* until("the second try", () => helper.tools.length > 1);
      expect(bytesSeen(watcher.seen)).toEqual(["not-ready"]);

      helper.tools[1]!.emit(frame(7, 5));
      yield* until("a frame", () => watcher.seen.length > 1);
      expect(bytesSeen(watcher.seen)).toEqual(["not-ready", 5]);
      yield* watcher.stop;
      expect(helper.running()).toBe(0);
    })
  ));

test("the tool's own idle reasons reach the watcher", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const watcher = yield* watching();
      yield* until("the tool", () => helper.tools.length > 0);
      helper.tools[0]!.emit(idleRecord("screen-locked"));
      yield* until("the idle", () => watcher.seen.length > 0);

      expect(bytesSeen(watcher.seen)).toEqual(["screen-locked"]);
      yield* watcher.stop;
    })
  ));

test("a tool whose output makes no sense is killed and replaced", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const watcher = yield* watching();
      yield* until("the tool", () => helper.tools.length > 0);
      helper.tools[0]!.emit(textRecord("Segmentation fault\n"));

      yield* until("its replacement", () => helper.tools.length > 1);
      expect(helper.tools[0]!.running()).toBe(false);
      expect(bytesSeen(watcher.seen)).toEqual(["no-window"]);
      yield* watcher.stop;
    })
  ));

test("latest answers a watched session's newest frame without a second tool", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const source = yield* PreviewSource;
      const watcher = yield* watching();
      yield* until("the tool", () => helper.tools.length > 0);
      helper.tools[0]!.emit(frame(7, 9));
      yield* until("a frame", () => watcher.seen.length > 0);

      const image = yield* source.latest({ sessionId: session, edge: 640 });

      expect(Option.map(image, (found) => found.jpeg)).toEqual(Option.some(jpegOf(9)));
      expect(helper.tools).toHaveLength(1);
      yield* watcher.stop;
    })
  ));

test("latest takes one image from a tool of its own, then kills it", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const source = yield* PreviewSource;
      const asked = yield* Effect.forkChild(source.latest({ sessionId: session, edge: 320 }));
      yield* until(
        "the tool",
        () => helper.tools.length > 0 && helper.tools[0]!.commands.length > 0
      );
      expect(helper.tools[0]!.commands).toEqual([{ window: 7, edge: 320, fps: 1 }]);
      helper.tools[0]!.emit(frame(7, 4, 320));

      const image = yield* Fiber.join(asked);

      expect(Option.map(image, (found) => [found.jpeg, found.width, found.window?.id])).toEqual(
        Option.some([jpegOf(4), 320, "7"])
      );
      expect(helper.running()).toBe(0);
    })
  ));

test("latest does not answer a watched frame larger than was asked for", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const source = yield* PreviewSource;
      const watcher = yield* watching();
      yield* until("the tool", () => helper.tools.length > 0);
      helper.tools[0]!.emit(frame(7, 9));
      yield* until("a frame", () => watcher.seen.length > 0);

      const asked = yield* Effect.forkChild(source.latest({ sessionId: session, edge: 320 }));
      yield* until("a second tool", () => helper.tools.length > 1);
      helper.tools[1]!.emit(frame(7, 4, 320));

      expect(Option.map(yield* Fiber.join(asked), (found) => found.width)).toEqual(
        Option.some(320)
      );
      yield* watcher.stop;
    })
  ));

test("latest is none, with no tool started, for a session that has not acted", () =>
  run((helper) =>
    Effect.gen(function* () {
      const source = yield* PreviewSource;

      expect(yield* source.latest({ sessionId: session, edge: 640 })).toEqual(Option.none());
      expect(helper.tools).toHaveLength(0);
    })
  ));

test("latest is none when the tool has nothing to show", () =>
  run((helper) =>
    Effect.gen(function* () {
      yield* act(7);
      const source = yield* PreviewSource;
      const asked = yield* Effect.forkChild(source.latest({ sessionId: session, edge: 640 }));
      yield* until("the tool", () => helper.tools.length > 0);
      helper.tools[0]!.emit(idleRecord("no-window"));

      expect(yield* Fiber.join(asked)).toEqual(Option.none());
      expect(helper.running()).toBe(0);
    })
  ));

test.each([
  ["4242", Option.some(4242)],
  ["w-4242", Option.some(4242)],
  ["window 7", Option.none()],
  ["-3", Option.none()],
  ["99999999999", Option.none()],
  ["", Option.none()],
])("the window id %p is the CGWindowID %p", (id, expected) => {
  expect(windowNumber(id)).toEqual(expected);
});

test("agent-desktop's own window ids name the same window to the tool and in its frames", () =>
  run((helper) =>
    Effect.gen(function* () {
      const targets = yield* PreviewTargets;
      const named = new AppWindow({ id: "w-7", title: "Untitled" });
      yield* targets.acted(session, { app: textEdit, window: named, screenshot: null });
      const watcher = yield* watching();
      yield* until(
        "the tool",
        () => helper.tools.length > 0 && helper.tools[0]!.commands.length > 0
      );
      helper.tools[0]!.emit(frame(7, 1));
      yield* until("a frame", () => watcher.seen.length > 0);

      expect(helper.tools[0]!.commands).toEqual([{ window: 7, edge: 640, fps: 10 }]);
      expect(bytesSeen(watcher.seen)).toEqual([1]);
      yield* watcher.stop;
    })
  ));
