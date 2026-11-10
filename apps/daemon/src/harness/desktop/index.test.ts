import { describe, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { Effect, Queue, Schema, Stream } from "effect";
import {
  Authorization,
  mixedApps,
  NAME_THE_APP,
  SCREEN_NEEDS_APP,
  unknownApp,
  UNSEEN_TARGET,
} from "./authorize.ts";
import { HEADED_HINT } from "./envelope.ts";
import { lockedMessage } from "./host.ts";
import {
  type ActedOn,
  computerUseCallOf,
  DesktopMcp,
  type DesktopMcpDeps,
  type DesktopServer,
} from "./index.ts";
import { takeover, tookOver, USER_ACTIVE_MS } from "./takeover.ts";
import { allowAll, countingAwake, error, fakeDeps, fakeHost, fakeRunner, ok } from "./testing.ts";

const sessionId = SessionId.make("ses-desktop");

const TEXTEDIT_SNAPSHOT = ok("snapshot", {
  app: "TextEdit",
  ref_count: 2,
  snapshot_id: "s1abc",
  tree: { role: "window" },
  window: { id: "w-42", title: "note.txt" },
});

const withServer = <A>(
  deps: DesktopMcpDeps,
  use: (server: DesktopServer | null) => Promise<A>,
  readOnly = false
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const desktop = yield* DesktopMcp;
        const server = yield* desktop.forSession({ sessionId, readOnly });

        return yield* Effect.promise(() => use(server));
      })
    ).pipe(Effect.provide(DesktopMcp.layerWith(deps)))
  );

const call = (server: DesktopServer | null, name: string, input: typeof Schema.Json.Type) => {
  const tool = server?.tools.find((t) => t.name === name);

  if (tool === undefined) throw new Error(`no tool ${name}`);

  return tool.call(input);
};

const textOf = (result: { readonly content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.flatMap((c) => (c.text === undefined ? [] : [c.text])).join("\n");

describe("which sessions get polaris_desktop", () => {
  test("read-only sessions and the Reviewer get no tools", async () => {
    const { runner } = fakeRunner({});

    expect(await withServer(fakeDeps(runner), async (s) => s, true)).toBeNull();
  });

  test("a Host that isn't ready gives no tools", async () => {
    const { runner } = fakeRunner({});
    const deps = fakeDeps(runner, { host: fakeHost({ ready: Effect.succeed(false) }) });

    expect(await withServer(deps, async (s) => s)).toBeNull();
  });

  test("a ready Host lists the headless and headed tools", async () => {
    const { runner } = fakeRunner({});
    const names = await withServer(fakeDeps(runner), async (s) => s?.tools.map((t) => t.name));

    for (const name of ["snapshot", "type", "screenshot", "launch", "mouse_click", "drag"])
      expect(names).toContain(name);
  });
});

describe("a call", () => {
  test("types into a ref from a snapshot, naming the snapshot's app and window", async () => {
    const { runner, calls } = fakeRunner({
      "session start": ok("session", { session_id: "run-7" }),
      snapshot: TEXTEDIT_SNAPSHOT,
      "list-apps": ok("list-apps", {
        apps: [{ name: "TextEdit", bundle_id: "com.apple.TextEdit" }],
      }),
      type: ok("type", { disposition: { delivery: "delivered_verified" } }),
    });

    const result = await withServer(fakeDeps(runner), async (server) => {
      await call(server, "snapshot", { app: "TextEdit" });

      return call(server, "type", { ref: "@s1abc:e2", text: "hello" });
    });

    expect(result.isError).toBeUndefined();
    expect(calls.find((args) => args.includes("type"))).toEqual([
      "--session",
      "run-7",
      "type",
      "--",
      "@s1abc:e2",
      "hello",
    ]);
    expect(computerUseCallOf(result.content)).toMatchObject({
      app: { id: "com.apple.TextEdit", name: "TextEdit" },
      window: { id: "w-42", title: "note.txt" },
      headed: false,
    });
  });

  test("a call naming only a listed window names that window's app", async () => {
    const { runner } = fakeRunner({
      "list-windows": ok("list-windows", [{ id: "w-7", title: "Home", app_name: "Dia" }]),
    });

    const result = await withServer(fakeDeps(runner), async (server) => {
      await call(server, "list_windows", {});

      return call(server, "focus_window", { window_id: "w-7" });
    });

    expect(computerUseCallOf(result.content)).toMatchObject({
      app: { name: "Dia" },
      window: { id: "w-7", title: "Home" },
    });
  });

  test("the overlay is labelled with the session title cut to six words", async () => {
    const { runner, calls } = fakeRunner({
      "session start": ok("session", { session_id: "run-7" }),
    });

    await withServer(fakeDeps(runner), (server) => call(server, "list_apps", {}));
    const enable = calls.find((args) => args.includes("cursor-overlay"));

    expect(enable?.[enable.indexOf("--label") + 1]).toBe("Fill in the quarterly report in");
  });

  test("closing the session ends its agent-desktop session", async () => {
    const { runner, calls } = fakeRunner({
      "session start": ok("session", { session_id: "run-7" }),
    });

    await withServer(fakeDeps(runner), (server) => call(server, "list_apps", {}));

    expect(calls).toContainEqual(["session", "end", "run-7"]);
  });

  test("a snapshot with nothing to act on points the agent at screenshots and headed tools", async () => {
    const { runner } = fakeRunner({
      snapshot: ok("snapshot", { app: "Game", ref_count: 0, snapshot_id: "s2", tree: {} }),
    });

    const result = await withServer(fakeDeps(runner), (server) =>
      call(server, "snapshot", { app: "Game" })
    );

    expect(textOf(result)).toContain(HEADED_HINT);
  });

  test("an action the element can't do points at the headed tools too", async () => {
    const { runner } = fakeRunner({
      snapshot: ok("snapshot", { app: "Game", ref_count: 1, snapshot_id: "s2", tree: {} }),
      click: error("click", "ACTION_NOT_SUPPORTED"),
    });

    const result = await withServer(fakeDeps(runner), async (server) => {
      await call(server, "snapshot", { app: "Game" });

      return call(server, "click", { ref: "@s2:e1" });
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(HEADED_HINT);
  });

  test("a locked screen says so, and runs nothing", async () => {
    const { runner, calls } = fakeRunner({});
    const deps = fakeDeps(runner, { host: fakeHost({ locked: Effect.succeed(true) }) });

    const result = await withServer(deps, (server) =>
      call(server, "snapshot", { app: "TextEdit" })
    );

    expect(textOf(result)).toBe(lockedMessage("workbox"));
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("invalid input is refused before anything runs", async () => {
    const { runner, calls } = fakeRunner({});
    const result = await withServer(fakeDeps(runner), (server) => call(server, "type", { ref: 3 }));

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("the preview follows what a call acted on", () => {
  test("an action on an app reports it, its window and a screenshot's bytes; a listing doesn't", async () => {
    const acted: Array<ActedOn> = [];
    const png = Buffer.from("not really a png").toString("base64");

    const { runner } = fakeRunner({
      snapshot: TEXTEDIT_SNAPSHOT,
      screenshot: ok("screenshot", { data: png, width: 10, height: 10, scale_factor: 1 }),
    });

    const deps = fakeDeps(runner, {
      acted: (_, on) => Effect.sync(() => void acted.push(on)),
    });

    await withServer(deps, async (server) => {
      await call(server, "list_apps", {});
      await call(server, "snapshot", { app: "TextEdit" });
      await call(server, "screenshot", { app: "TextEdit" });
    });

    expect(acted.map((on) => [on.app.name, on.window?.id ?? null])).toEqual([
      ["TextEdit", "w-42"],
      ["TextEdit", null],
    ]);
    expect(acted[0]?.screenshot).toBeNull();
    expect(Buffer.from(acted[1]?.screenshot?.image ?? []).toString()).toBe("not really a png");
  });
});

describe("headed input", () => {
  test("is refused, with nothing sent, when the policy refuses it", async () => {
    const { runner, calls } = fakeRunner({});

    const deps = fakeDeps(runner, {
      authorize: {
        ...allowAll,
        use: (desktopCall) =>
          Effect.succeed(
            desktopCall.headed
              ? Authorization.Refuse({ message: "no headed input" })
              : Authorization.Allow({ asked: false })
          ),
      },
    });

    const result = await withServer(deps, (server) =>
      call(server, "mouse_click", { x: 10, y: 20, app: "Dia" })
    );

    expect(textOf(result)).toBe("no headed input");
    expect(calls.some((args) => args.includes("mouse-click"))).toBe(false);
  });

  test("runs with --headed once allowed, negative coordinates included", async () => {
    const { runner, calls } = fakeRunner({});
    const deps = fakeDeps(runner);

    const result = await withServer(deps, (server) =>
      call(server, "mouse_click", { x: -100, y: 50, app: "Dia" })
    );

    expect(calls.find((args) => args.includes("mouse-click"))?.slice(-3)).toEqual([
      "--headed",
      "mouse-click",
      "--xy=-100,50",
    ]);
    expect(computerUseCallOf(result.content)?.headed).toBe(true);
  });

  test("the policy is asked about the app a ref belongs to, by its bundle id", async () => {
    const seen: Array<string> = [];

    const { runner } = fakeRunner({
      snapshot: TEXTEDIT_SNAPSHOT,
      "list-apps": ok("list-apps", {
        apps: [{ name: "TextEdit", bundle_id: "com.apple.TextEdit" }],
      }),
    });

    const deps = fakeDeps(runner, {
      authorize: {
        ...allowAll,
        use: (desktopCall) =>
          Effect.sync(() => {
            seen.push(desktopCall.app.id);

            return Authorization.Allow({ asked: false });
          }),
      },
    });

    await withServer(deps, async (server) => {
      await call(server, "snapshot", { app: "textedit" });
      await call(server, "click", { ref: "@s1abc:e2" });
    });

    expect(seen).toEqual(["com.apple.TextEdit", "com.apple.TextEdit"]);
  });
});

describe("which app a call is for", () => {
  test("a call that names no app is refused before anything runs", async () => {
    const { runner, calls } = fakeRunner({ snapshot: TEXTEDIT_SNAPSHOT });

    const result = await withServer(fakeDeps(runner), (server) => call(server, "snapshot", {}));

    expect(textOf(result)).toBe(NAME_THE_APP);
    expect(calls).toEqual([]);
  });

  test("a name that fits two running apps is refused, an exact name isn't", async () => {
    const { runner } = fakeRunner({
      "list-apps": ok("list-apps", {
        apps: [
          { name: "Notes", bundle_id: "com.apple.Notes" },
          { name: "Notesnook", bundle_id: "com.streetwriters.notesnook" },
        ],
      }),
    });

    const [vague, exact] = await withServer(fakeDeps(runner), async (server) => [
      await call(server, "snapshot", { app: "Note" }),
      await call(server, "snapshot", { app: "Notes" }),
    ]);

    expect(textOf(vague)).toBe(unknownApp("Note", "workbox"));
    expect(computerUseCallOf(exact.content)).toMatchObject({
      app: { id: "com.apple.Notes", name: "Notes" },
    });
  });

  test("a window or ref of another app can't ride on the app the call names", async () => {
    const { runner, calls } = fakeRunner({
      "list-windows": ok("list-windows", [{ id: "w-9", title: "zsh", app_name: "Terminal" }]),
      "list-apps": ok("list-apps", {
        apps: [
          { name: "TextEdit", bundle_id: "com.apple.TextEdit" },
          { name: "Terminal", bundle_id: "com.apple.Terminal" },
        ],
      }),
    });

    const [mixed, unseen] = await withServer(fakeDeps(runner), async (server) => {
      await call(server, "list_windows", {});

      return [
        await call(server, "focus_window", { app: "TextEdit", window_id: "w-9" }),
        await call(server, "focus_window", { app: "TextEdit", window_id: "w-never-listed" }),
      ];
    });

    expect(textOf(mixed)).toBe(mixedApps("TextEdit", "Terminal"));
    expect(textOf(unseen)).toBe(UNSEEN_TARGET);
    expect(calls.some((args) => args.includes("focus-window"))).toBe(false);
  });

  test("an app that isn't running and the Host doesn't know is refused", async () => {
    const { runner, calls } = fakeRunner({});
    const deps = fakeDeps(runner, { host: fakeHost({ identify: () => Effect.succeed(null) }) });

    const result = await withServer(deps, (server) => call(server, "launch", { app: "Nope" }));

    expect(textOf(result)).toBe(unknownApp("Nope", "workbox"));
    expect(calls.some((args) => args.includes("launch"))).toBe(false);
  });

  test("the whole screen is captured only while the session controls an app", async () => {
    const { runner, calls } = fakeRunner({});
    let controlling = false;

    const deps = fakeDeps(runner, {
      authorize: { ...allowAll, controlling: () => Effect.sync(() => controlling) },
    });

    const refused = await withServer(deps, async (server) => {
      const first = await call(server, "screenshot", { screen: 0 });
      controlling = true;
      await call(server, "screenshot", { screen: 0 });

      return first;
    });

    expect(textOf(refused)).toBe(SCREEN_NEEDS_APP);
    expect(calls.filter((args) => args.includes("screenshot"))).toHaveLength(1);
  });
});

describe("the user taking over during headed input", () => {
  const click = (idle: number | null, asked = false) => {
    const { runner, calls } = fakeRunner({});

    const deps = fakeDeps(runner, {
      host: fakeHost({ inputIdle: Effect.sync(() => idle) }),
      authorize: { ...allowAll, use: () => Effect.succeed(Authorization.Allow({ asked })) },
    });

    return withServer(deps, async (server) => ({
      result: await call(server, "mouse_click", { x: 1, y: 2, app: "Dia" }),
      sent: calls.some((args) => args.includes("mouse-click")),
    }));
  };

  test("input a moment ago pauses the action and tells the agent", async () => {
    const { result, sent } = await click(200);

    expect(textOf(result)).toBe(tookOver("workbox"));
    expect(sent).toBe(false);
  });

  test("an idle Host, and one that can't tell, let it through", async () => {
    expect((await click(USER_ACTIVE_MS + 1)).sent).toBe(true);
    expect((await click(null)).sent).toBe(true);
  });

  test("the user answering the approval is not a takeover", async () => {
    expect((await click(200, true)).sent).toBe(true);
  });

  test("our own input isn't the user's, but input after it is", () => {
    let now = 10_000;
    const tracker = takeover(() => now);
    tracker.acted();
    now += 400;
    expect(tracker.userActive(350)).toBe(false);
    now += 2000;
    expect(tracker.userActive(100)).toBe(true);
  });
});

describe("the display stays awake", () => {
  test("from a Turn's first call until the Turn ends, and not before any call", async () => {
    const { runner } = fakeRunner({});
    const { awake, state } = countingAwake();
    const ends = Effect.runSync(Queue.unbounded<unknown>());

    const deps = fakeDeps(runner, {
      awake,
      sessions: {
        title: () => Effect.succeed(null),
        turnEnds: () => Effect.succeed(Stream.fromQueue(ends)),
      },
    });

    await withServer(deps, async (server) => {
      expect(state.held).toBe(0);
      await call(server, "list_apps", {});
      await call(server, "list_windows", {});
      expect(state).toEqual({ held: 1, released: 0 });
      Effect.runSync(Queue.offer(ends, "TurnEnded"));
      await Bun.sleep(10);
      expect(state).toEqual({ held: 1, released: 1 });
      await call(server, "list_apps", {});
      expect(state.held).toBe(2);
    });

    expect(state.released).toBe(2);
  });
});

const RpcAnswer = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
    content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
});

const decodeAnswer = Schema.decodeUnknownSync(RpcAnswer);

describe("Codex's way in", () => {
  test("the loopback URL serves the same tools and stops with the session", async () => {
    const { runner } = fakeRunner({ snapshot: TEXTEDIT_SNAPSHOT });
    let url = "";

    const rpc = (method: string, params: typeof Schema.Json.Type) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }).then(async (r) => decodeAnswer(await r.json()));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* (yield* DesktopMcp).forSession({ sessionId });
          url = yield* server!.url;
          const listed = yield* Effect.promise(() => rpc("tools/list", {}));

          const called = yield* Effect.promise(() =>
            rpc("tools/call", { name: "snapshot", arguments: { app: "TextEdit" } })
          );

          expect(listed.result.tools?.map((t) => t.name)).toContain("snapshot");
          expect(computerUseCallOf(called.result)?.window?.title).toBe("note.txt");
        })
      ).pipe(Effect.provide(DesktopMcp.layerWith(fakeDeps(runner))))
    );

    const refused = await rpc("tools/list", {}).then(
      () => false,
      () => true
    );

    expect(refused).toBe(true);
  });
});
