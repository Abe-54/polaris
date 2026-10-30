/** A steer with attachments on Claude Code (ENG-662): images inline in the injected message. */
import { expect, test } from "bun:test";
import { Attachment, AttachmentId, SessionId, TurnId, TurnItem } from "@polaris/protocol";
import { Effect, Scope, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { assistant, FakeClaude, result } from "./fakeClaude.ts";

const T1 = TurnId.make("turn-1");

const png = new Attachment({
  id: AttachmentId.make("a1"),
  name: "shot.png",
  mimeType: "image/png",
  size: 4,
  hostPath: "/stage/shot.png",
  width: 2,
  height: 2,
});

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await Bun.sleep(2);
  }

  throw new Error("timed out");
};

const open = async () => {
  const fake = new FakeClaude();
  const scope = Effect.runSync(Scope.make());

  const session = await Effect.runPromise(
    makeClaudeDriver({
      query: fake.query,
      claudePath: () => "/opt/bin/claude",
      stagingDir: "/stage",
      readFile: async () => new Uint8Array([137, 80, 78, 71]),
    })
      .open({
        sessionId: SessionId.make("s1"),
        cwd: "/work/repo",
        permissionMode: "full-access",
        model: null,
        effort: null,
        resumeCursor: null,
      })
      .pipe(Scope.provide(scope))
  );

  const events: HarnessEvent[] = [];
  Effect.runFork(
    Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event)))
  );
  await Effect.runPromise(
    session.sendTurn({ turnId: T1, prompt: "fix it", attachments: [], model: null, effort: null })
  );
  await fake.nextInput(0);

  return { fake, session, events };
};

const landed = (events: ReadonlyArray<HarnessEvent>) =>
  events.flatMap((e) =>
    HarnessEvent.$is("ItemCompleted")(e) && TurnItem.guards.UserMessage(e.item) ? [e.item] : []
  );

test("a steer's image goes inline with its text, and lands in the Turn with the attachment", async () => {
  const { fake, session, events } = await open();

  await Effect.runPromise(session.steer("like this", [png]));
  const sent = await fake.nextInput(1);

  expect(sent.message.content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } },
    { type: "text", text: "like this" },
  ]);

  fake.emit({ ...sent, session_id: "claude-session-1", isReplay: true as const });
  fake.emit(assistant("m1", [{ type: "text", text: "Got it." }]));
  await until(() => landed(events).length === 1);

  expect(landed(events)).toMatchObject([
    { id: `steer:${sent.uuid}`, text: "like this", attachments: [png] },
  ]);
  fake.emit(result([sent.uuid!]));
});

test("an image-only steer sends no empty text block", async () => {
  const { fake, session } = await open();

  await Effect.runPromise(session.steer("", [png]));
  const sent = await fake.nextInput(1);

  expect(sent.message.content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } },
  ]);
});
