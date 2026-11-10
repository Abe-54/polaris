/** Computer use through the real Engine (ENG-846): headed input and one session per app. */
import { describe, expect, test } from "bun:test";
import { ApprovalDecision, type RequestId, SessionId } from "@polaris/protocol";
import { Effect, Option, Predicate, Stream } from "effect";
import { AppControl, ComputerUseHost } from "../computerUse/index.ts";
import {
  allow,
  allowed,
  asking,
  call,
  DIA,
  endTurn,
  open,
  pendingOf,
  ranCommand,
  respond,
  run,
  setup,
  textOf,
} from "./computerUse.testing.ts";
import { waitFor, waitUntil } from "./testing.ts";

describe("headed input", () => {
  test("needs its own approval once per app per session, and is never always-allowed", async () => {
    const { layer, ran } = await setup();
    const S = SessionId.make("cu-headed");
    const click = { x: 10, y: 20, app: "Dia" };

    const seen = await run(
      layer,
      Effect.gen(function* () {
        const server = yield* open(S);
        yield* allowed(server, S, "focus_window", { app: "Dia" });
        const { result, request } = yield* asking(server, S, "mouse_click", click);
        const before = ranCommand(ran, "mouse-click");
        const always = yield* Effect.flip(respond(request, allow(true)));
        yield* respond(request, allow());
        const clicked = yield* Effect.promise(() => result);
        const again = yield* Effect.promise(() => call(server, "mouse_click", click));
        const pending = yield* pendingOf(S);
        // Headed input in Dia says nothing about TextEdit.
        yield* allowed(server, S, "snapshot", { app: "TextEdit" });
        const other = yield* asking(server, S, "mouse_click", { ...click, app: "TextEdit" });
        yield* respond(other.request, ApprovalDecision.cases.Deny.make({ reason: null }));
        const denied = yield* Effect.promise(() => other.result);

        return { request, before, always, clicked, again, pending, other: other.request, denied };
      })
    );

    expect(seen.request).toMatchObject({ kind: "headed-input", app: { id: DIA, name: "Dia" } });
    expect(seen.before).toBe(0);
    expect(seen.always).toMatchObject({
      reason: "Headed input can only be allowed for this session",
    });
    expect(seen.clicked.isError).toBeUndefined();
    expect(seen.again.isError).toBeUndefined();
    expect(seen.pending).toEqual([]);
    expect(seen.other).toMatchObject({ kind: "headed-input", app: { name: "TextEdit" } });
    expect(textOf(seen.denied)).toBe(
      "The user didn't allow headed input in TextEdit. Use the headless tools, or tell the user what you can't do without it."
    );
    expect(ranCommand(ran, "mouse-click")).toBe(2);
  });

  test("a first headed use of an app asks for the app, then for headed input", async () => {
    const { layer } = await setup();
    const S = SessionId.make("cu-headed-first");

    const kinds = await run(
      layer,
      Effect.gen(function* () {
        const server = yield* open(S);
        const result = call(server, "mouse_click", { x: 1, y: 2, app: "Dia" });
        const asked: Array<string> = [];
        let last: RequestId | null = null;

        for (const _ of [0, 1]) {
          const model = yield* waitFor(
            (m) => [...(m.sessions.get(S)?.pending.values() ?? [])].some((r) => r.id !== last),
            10_000
          );

          const request = [...model.sessions.get(S)!.pending.values()].find((r) => r.id !== last)!;
          asked.push(request.kind);
          last = request.id;
          yield* respond(request, allow());
        }

        yield* Effect.promise(() => result);

        return asked;
      })
    );

    expect(kinds).toEqual(["app", "headed-input"]);
  });
});

describe("one session per app", () => {
  test("another session is told who has the app, and gets it once that Turn ends", async () => {
    const { layer, driver } = await setup();
    const A = SessionId.make("cu-lock-a");
    const B = SessionId.make("cu-lock-b");

    const seen = await run(
      layer,
      Effect.gen(function* () {
        const host = yield* ComputerUseHost;
        const a = yield* open(A);
        const b = yield* open(B);
        yield* allowed(a, A, "snapshot", { app: "Dia" });

        const controlled = yield* host.feed.pipe(
          Stream.filter((item) => Predicate.isTagged(item, "ControlledApps")),
          Stream.runHead
        );

        const busy = yield* Effect.promise(() => call(b, "snapshot", { app: "Dia" }));
        const asked = yield* pendingOf(B);
        // A different app is free.
        yield* allowed(b, B, "snapshot", { app: "TextEdit" });
        yield* endTurn(driver, A);
        const free = yield* asking(b, B, "snapshot", { app: "Dia" });
        yield* respond(free.request, allow());
        const got = yield* Effect.promise(() => free.result);
        const title = (yield* waitFor(() => true, 10_000)).sessions.get(A)!.session.title;

        return { controlled: Option.getOrNull(controlled), busy, asked, got, title };
      })
    );

    expect(seen.controlled).toMatchObject({ apps: [{ app: { id: DIA }, sessionId: A }] });
    expect(textOf(seen.busy)).toBe(
      `Dia is in use by ${seen.title}. Try again when that session's Turn ends.`
    );
    expect(seen.asked).toEqual([]);
    expect(seen.got.isError).toBeUndefined();
  });

  test("a session that stops lets go of its apps", async () => {
    const { layer } = await setup();
    const A = SessionId.make("cu-stop-a");
    const B = SessionId.make("cu-stop-b");

    const kinds = await run(
      layer,
      Effect.gen(function* () {
        const b = yield* open(B);

        // A's server lives in its own scope: closing it is the session stopping.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const a = yield* open(A);
            yield* allowed(a, A, "snapshot", { app: "Dia" });
            const busy = yield* Effect.promise(() => call(b, "snapshot", { app: "Dia" }));
            expect(busy.isError).toBe(true);
          })
        );
        const { result, request } = yield* asking(b, B, "snapshot", { app: "Dia" });
        yield* respond(request, allow());

        return [request.kind, (yield* Effect.promise(() => result)).isError] as const;
      })
    );

    expect(kinds).toEqual(["app", undefined]);
  });

  test("turning computer use off stops the tools and releases every app", async () => {
    const { layer, ran } = await setup();
    const A = SessionId.make("cu-off-a");
    const B = SessionId.make("cu-off-b");

    const seen = await run(
      layer,
      Effect.gen(function* () {
        const host = yield* ComputerUseHost;
        const control = yield* AppControl;
        const a = yield* open(A);
        const b = yield* open(B);
        yield* allowed(a, A, "snapshot", { app: "Dia" });
        yield* host.disable;
        const off = yield* Effect.promise(() => call(a, "snapshot", { app: "Dia" }));
        let held = true;

        yield* waitUntil(() => {
          void Effect.runPromise(control.controlling(A)).then((still) => (held = still));

          return !held;
        });
        yield* host.enable;
        // Not "in use by": B is asked for the app like any first use.
        const { result, request } = yield* asking(b, B, "snapshot", { app: "Dia" });
        yield* respond(request, allow());
        yield* Effect.promise(() => result);

        return { off, kind: request.kind };
      })
    );

    expect(textOf(seen.off)).toMatch(/^Computer use isn't on for .+ any more\.$/);
    expect(seen.kind).toBe("app");
    expect(ranCommand(ran, "snapshot")).toBe(2);
  });
});
