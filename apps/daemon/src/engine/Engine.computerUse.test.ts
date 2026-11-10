/** Computer use through the real Engine (ENG-846): first use, always allow and the refused apps. */
import { describe, expect, test } from "bun:test";
import {
  AppId,
  ApprovalDecision,
  type Capability,
  Command,
  DesktopApp,
  SessionId,
} from "@polaris/protocol";
import { Effect, Option, Predicate, Stream } from "effect";
import { ComputerUseHost } from "../computerUse/index.ts";
import { DesktopMcp } from "../harness/desktop/index.ts";
import {
  allow,
  allowed,
  asking,
  call,
  dispatch,
  endTurn,
  open,
  pendingOf,
  ranCommand,
  respond,
  run,
  setup,
  textOf,
} from "./computerUse.testing.ts";
import { Engine } from "./Engine.ts";
import { waitFor } from "./testing.ts";

describe("the first use of an app", () => {
  test("asks in every permission mode, and nothing runs until the user allows it", async () => {
    const { layer, ran, driver } = await setup();
    const S = SessionId.make("cu-first");

    const seen = await run(
      layer,
      Effect.gen(function* () {
        const server = yield* open(S, "full-access");
        const { result, request } = yield* asking(server, S, "snapshot", { app: "TextEdit" });
        const state = (yield* waitFor(() => true)).sessions.get(S)?.session.state;
        const before = ranCommand(ran, "snapshot");
        yield* respond(request, allow());
        const first = yield* Effect.promise(() => result);
        const second = yield* Effect.promise(() => call(server, "snapshot", { app: "TextEdit" }));

        return { request, state, before, first, second, pending: yield* pendingOf(S) };
      })
    );

    expect(seen.request).toMatchObject({
      kind: "app",
      app: { id: "com.apple.TextEdit", name: "TextEdit" },
    });
    expect(seen.state).toBe("needs-you");
    expect(seen.before).toBe(0);
    expect(seen.first.isError).toBeUndefined();
    expect(seen.second.isError).toBeUndefined();
    expect(seen.pending).toEqual([]);
    expect(ranCommand(ran, "snapshot")).toBe(2);
    // Polaris asked, not the Harness: the answer never goes to it.
    expect(driver.latest(S)?.responses).toEqual([]);
  });

  test("a deny tells the agent, runs nothing, and the next use asks again", async () => {
    const { layer, ran } = await setup();
    const S = SessionId.make("cu-deny");

    const [denied, again] = await run(
      layer,
      Effect.gen(function* () {
        const server = yield* open(S);
        const first = yield* asking(server, S, "snapshot", { app: "TextEdit" });
        yield* respond(first.request, ApprovalDecision.cases.Deny.make({ reason: null }));
        const result = yield* Effect.promise(() => first.result);
        const second = yield* asking(server, S, "snapshot", { app: "TextEdit" });
        yield* respond(second.request, allow());
        yield* Effect.promise(() => second.result);

        return [result, second.request.kind] as const;
      })
    );

    expect(textOf(denied)).toBe("The user didn't allow TextEdit for this session.");
    expect(again).toBe("app");
    expect(ranCommand(ran, "snapshot")).toBe(1);
  });

  test("an allow for one session doesn't cover another, and survives a Daemon restart", async () => {
    const first = await setup();
    const A = SessionId.make("cu-a");
    const B = SessionId.make("cu-b");

    const other = await run(
      first.layer,
      Effect.gen(function* () {
        const a = yield* open(A);
        yield* allowed(a, A, "snapshot", { app: "TextEdit" });
        yield* endTurn(first.driver, A);
        const b = yield* open(B);
        const { result, request } = yield* asking(b, B, "snapshot", { app: "TextEdit" });
        yield* respond(request, ApprovalDecision.cases.Deny.make({ reason: null }));
        yield* Effect.promise(() => result);

        return request.sessionId;
      })
    );

    expect(other).toBe(B);

    const restarted = await setup(first.reuse);

    const after = await run(
      restarted.layer,
      Effect.gen(function* () {
        yield* dispatch(
          Command.cases.SendTurn.make({ sessionId: A, prompt: "again", attachments: [] })
        );
        yield* waitFor((m) => m.sessions.get(A)?.session.state === "working");
        const server = (yield* (yield* DesktopMcp).forSession({ sessionId: A }))!;
        const result = yield* Effect.promise(() => call(server, "snapshot", { app: "TextEdit" }));

        return { result, pending: yield* pendingOf(A) };
      })
    );

    expect(after.result.isError).toBeUndefined();
    expect(after.pending).toEqual([]);
  });

  test("a Client that didn't announce computer-use is never sent the approval", async () => {
    const { layer } = await setup();
    const S = SessionId.make("cu-gated");

    const [older, newer] = await run(
      layer,
      Effect.gen(function* () {
        const server = yield* open(S);
        const { result, request } = yield* asking(server, S, "snapshot", { app: "TextEdit" });
        const engine = yield* Engine;

        const snapshot = (capabilities: ReadonlyArray<Capability>) =>
          engine
            .subscribeSession({ sessionId: S, afterSequence: null, turnLimit: null, capabilities })
            .pipe(
              Stream.take(1),
              Stream.runHead,
              Effect.map((item) => {
                const head = Option.getOrNull(item);

                return Predicate.isTagged(head, "Snapshot") ? head.pendingApprovals.length : -1;
              })
            );

        const counts = [yield* snapshot([]), yield* snapshot(["computer-use"])] as const;
        yield* respond(request, allow());
        yield* Effect.promise(() => result);

        return counts;
      })
    );

    expect(older).toBe(0);
    expect(newer).toBe(1);
  });
});

describe("always allow", () => {
  test("is saved on the Host: no session asks for the app again until it is removed", async () => {
    const { layer, driver } = await setup();
    const A = SessionId.make("cu-always-a");
    const B = SessionId.make("cu-always-b");

    const seen = await run(
      layer,
      Effect.gen(function* () {
        const host = yield* ComputerUseHost;
        const a = yield* open(A);
        const { result, request } = yield* asking(a, A, "snapshot", { app: "TextEdit" });
        yield* respond(request, allow(true));
        yield* Effect.promise(() => result);
        const saved = (yield* host.allowedApps).map((entry) => entry.app.id);
        yield* endTurn(driver, A);
        const b = yield* open(B);
        const unasked = yield* Effect.promise(() => call(b, "snapshot", { app: "TextEdit" }));
        const pending = yield* pendingOf(B);
        yield* host.removeAllowedApp(AppId.make("com.apple.TextEdit"));
        const again = yield* asking(b, B, "snapshot", { app: "TextEdit" });
        yield* respond(again.request, allow());
        yield* Effect.promise(() => again.result);

        return { saved, unasked, pending, again: again.request.kind };
      })
    );

    expect(seen.saved).toEqual([AppId.make("com.apple.TextEdit")]);
    expect(seen.unasked.isError).toBeUndefined();
    expect(seen.pending).toEqual([]);
    expect(seen.again).toBe("app");
  });

  test("with no Desktop App, an Extension allows for the session but can't always-allow", async () => {
    const { layer, ran } = await setup();
    const S = SessionId.make("cu-sdk");

    const seen = await run(
      layer,
      Effect.gen(function* () {
        const host = yield* ComputerUseHost;
        const server = yield* open(S);
        const { result, request } = yield* asking(server, S, "snapshot", { app: "TextEdit" });
        const refused = yield* Effect.flip(respond(request, allow(true), ["approve"]));
        const stillPending = (yield* pendingOf(S)).map((pending) => pending.id);
        yield* respond(request, allow(), ["approve"]);
        const answered = yield* Effect.promise(() => result);

        return { refused, stillPending, request, answered, always: yield* host.allowedApps };
      })
    );

    expect(seen.refused).toMatchObject({
      reason: "An extension can only allow an app for this session",
    });
    expect(seen.stillPending).toEqual([seen.request.id]);
    expect(seen.answered.isError).toBeUndefined();
    expect(seen.always).toEqual([]);
    expect(ranCommand(ran, "snapshot")).toBe(1);
  });
});

describe("the always-refused apps", () => {
  test.each([
    ["Terminal", "Terminal"],
    ["Quarterly Report", "Quarterly Report"],
    ["com.googlecode.iterm2", "Quarterly Report"],
  ])("%s is refused by its bundle id, with no approval and nothing run", async (asked, name) => {
    const { layer, ran } = await setup();
    const S = SessionId.make("cu-refused");

    const [result, pending] = await run(
      layer,
      Effect.gen(function* () {
        const server = yield* open(S, "full-access");
        const refused = yield* Effect.promise(() => call(server, "launch", { app: asked }));

        return [refused, yield* pendingOf(S)] as const;
      })
    );

    expect(textOf(result)).toBe(
      `polaris_desktop doesn't drive ${name}: it would get around the approvals this session asks for. Ask the user to do this step.`
    );
    expect(pending).toEqual([]);
    expect(ranCommand(ran, "launch")).toBe(0);
  });

  test("an app that only shares a refused app's name is asked about like any other", async () => {
    const { layer } = await setup();
    const S = SessionId.make("cu-namesake");

    const request = await run(
      layer,
      Effect.gen(function* () {
        const server = yield* open(S);
        const asked = yield* asking(server, S, "snapshot", { app: "Passwords" });
        yield* respond(asked.request, allow());
        yield* Effect.promise(() => asked.result);

        return asked.request;
      })
    );

    expect(request).toMatchObject({ kind: "app", app: { id: "com.example.crossword" } });
  });

  test("one the user always-allowed on the Host is used without asking", async () => {
    const { layer, ran } = await setup();
    const S = SessionId.make("cu-refused-lifted");

    const result = await run(
      layer,
      Effect.gen(function* () {
        const server = yield* open(S);

        yield* (yield* ComputerUseHost).allowApp(
          new DesktopApp({ id: AppId.make("com.apple.Terminal"), name: "Terminal", icon: null })
        );

        return yield* Effect.promise(() => call(server, "snapshot", { app: "Terminal" }));
      })
    );

    expect(result.isError).toBeUndefined();
    expect(ranCommand(ran, "snapshot")).toBe(1);
  });
});
