import { expect, test } from "bun:test";
import { AppId, AppRef, AppWindow, SessionId } from "@polaris/protocol";
import { Effect, Fiber, Option, Stream } from "effect";
import { MAX_KEPT_SCREENSHOTS, type PreviewTarget, PreviewTargets } from "./targets.ts";

const session = SessionId.make("s1");

const textEdit = new AppRef({ id: AppId.make("com.apple.TextEdit"), name: "TextEdit" });

const windowOf = (id: string) => new AppWindow({ id, title: `Untitled ${id}` });

const run = <A>(effect: Effect.Effect<A, never, PreviewTargets>, seed?: PreviewTarget) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(PreviewTargets.layerWith(Option.fromUndefinedOr(seed))))
  );

const windowId = Option.map((target: PreviewTarget) => target.window.id);

test("a call that names no window leaves the session's last window its target", () =>
  run(
    Effect.gen(function* () {
      const targets = yield* PreviewTargets;
      yield* targets.acted(session, { app: textEdit, window: windowOf("7"), screenshot: null });
      yield* targets.acted(session, { app: textEdit, window: null, screenshot: null });

      expect(yield* targets.target(session)).toEqual(
        Option.some({ app: textEdit, window: windowOf("7") })
      );
      expect(yield* targets.target(SessionId.make("other"))).toEqual(Option.none());
    })
  ));

test("a watcher hears the target now, each action of its session, and its forgetting", () =>
  run(
    Effect.gen(function* () {
      const targets = yield* PreviewTargets;
      yield* targets.acted(session, { app: textEdit, window: windowOf("7"), screenshot: null });

      const seen = yield* targets
        .watch(session)
        .pipe(Stream.map(windowId), Stream.take(5), Stream.runCollect, Effect.forkChild);

      yield* Effect.sleep("20 millis");
      yield* targets.acted(session, { app: textEdit, window: windowOf("8"), screenshot: null });
      // Another session's action is not this watcher's.
      yield* targets.acted(SessionId.make("other"), {
        app: textEdit,
        window: windowOf("99"),
        screenshot: null,
      });
      // The same window again is still told: it restarts a capture that stopped.
      yield* targets.acted(session, { app: textEdit, window: windowOf("8"), screenshot: null });
      yield* targets.forget(session);
      yield* targets.acted(session, { app: textEdit, window: windowOf("9"), screenshot: null });

      expect(yield* Fiber.join(seen)).toEqual([
        Option.some("7"),
        Option.some("8"),
        Option.some("8"),
        Option.none(),
        Option.some("9"),
      ]);
    })
  ));

test("only the sessions that acted last keep a screenshot", () =>
  run(
    Effect.gen(function* () {
      const targets = yield* PreviewTargets;

      const ids = Array.from({ length: MAX_KEPT_SCREENSHOTS + 2 }, (_, i) =>
        SessionId.make(`s${i}`)
      );

      const act = (at: number, takenAt: number) =>
        targets.acted(ids[at]!, {
          app: textEdit,
          window: null,
          screenshot: { image: new Uint8Array([at]), takenAt },
        });

      // One more than is kept: the first session's is dropped.
      for (let at = 0; at <= MAX_KEPT_SCREENSHOTS; at++) yield* act(at, at);
      // The oldest kept acts again, so the next new session drops the one after it.
      yield* act(1, 100);
      yield* act(MAX_KEPT_SCREENSHOTS + 1, 200);

      const kept = yield* Effect.forEach(ids, (id) => targets.screenshot(id));

      expect(kept.map(Option.map((screenshot) => screenshot.takenAt))).toEqual([
        Option.none(),
        Option.some(100),
        Option.none(),
        ...Array.from({ length: MAX_KEPT_SCREENSHOTS - 2 }, (_, i) => Option.some(i + 3)),
        Option.some(200),
      ]);
    })
  ));

test("the bench's seed is a session's target until it acts", () =>
  run(
    Effect.gen(function* () {
      const targets = yield* PreviewTargets;
      expect(Option.map(yield* targets.target(session), (target) => target.window.id)).toEqual(
        Option.some("1")
      );
      yield* targets.acted(session, { app: textEdit, window: windowOf("2"), screenshot: null });
      expect(windowId(yield* targets.target(session))).toEqual(Option.some("2"));
    }),
    { app: textEdit, window: windowOf("1") }
  ));
