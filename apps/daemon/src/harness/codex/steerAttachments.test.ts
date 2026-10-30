/** A steer with attachments on Codex (ENG-662): `turn/steer` carries the images as `localImage`. */
import { afterEach, expect, test } from "bun:test";
import { Attachment, AttachmentId, TurnItem } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { makeCodexDriver } from "./CodexDriver.ts";
import type { Json } from "./protocol.ts";
import type { FakeConnection, Handler } from "./testing/FakeAppServer.ts";
import { cleanup, ofTag, scripted, sessionWith, THREAD, turn } from "./testing/session.ts";
import type { HarnessSession } from "../HarnessDriver.ts";

const withSession = sessionWith(makeCodexDriver);

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const T = "t_tui";

const png = new Attachment({
  id: AttachmentId.make("a1"),
  name: "shot.png",
  mimeType: "image/png",
  size: 4,
  hostPath: "/stage/shot.png",
  width: null,
  height: null,
});

const pdf = new Attachment({
  id: AttachmentId.make("a2"),
  name: "spec.pdf",
  mimeType: "application/pdf",
  size: 9,
  hostPath: "/stage/spec.pdf",
  width: null,
  height: null,
});

/** What the fake reads of a `turn/steer`: its inputs' types and texts. */
const SteerParams = Schema.Struct({
  input: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
});

type Send = (method: string, params: { readonly [key: string]: Json }) => void;

const userMessage = (id: string, text: string) => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});

/** A Turn running in Codex; Codex echoes each steer as a user message item before answering. */
const steering = (steer: (session: HarnessSession) => Effect.Effect<void, unknown>) => {
  let conn: FakeConnection | null = null;

  const send: Send = (method, params) =>
    conn?.notify(method, { threadId: THREAD, turnId: T, ...params });

  const handler: Handler = (request, c) => {
    if (request.method === "thread/resume") conn = c;

    if (request.method === "turn/steer") {
      const params = Schema.decodeUnknownSync(SteerParams)(request.params);

      const text = params.input
        .flatMap((p) => (p.type === "text" ? [p.text ?? ""] : []))
        .join("\n");

      send("item/started", { startedAtMs: 0, item: userMessage("u2", text) });

      return c.reply({ turnId: T });
    }

    return scripted(() => {})(request, c);
  };

  return withSession(
    handler,
    ({ session }) =>
      Effect.gen(function* () {
        send("turn/started", { turn: turn(T) });
        send("item/started", { startedAtMs: 0, item: userMessage("u1", "fix it") });
        yield* Effect.sleep("10 millis");
        yield* steer(session);
        yield* Effect.sleep("10 millis");
        send("turn/completed", { turn: turn(T, "completed") });
        yield* Effect.sleep("10 millis");
      }),
    { resumeCursor: THREAD }
  );
};

test("a steer's images go to Codex as localImage, and it lands as the user sent it", async () => {
  const { events, server } = await steering((session) => session.steer("like this", [png, pdf]));

  expect(server.requests("turn/steer")[0]?.params).toMatchObject({
    expectedTurnId: T,
    input: [
      { type: "text", text: "like this\n\nAttached files:\n- /stage/spec.pdf" },
      { type: "localImage", path: "/stage/shot.png" },
    ],
  });

  const steers = ofTag(events, "ItemCompleted").flatMap((e) =>
    TurnItem.guards.UserMessage(e.item) ? [e.item] : []
  );

  expect(steers).toMatchObject([{ text: "like this", attachments: [png, pdf] }]);
});

test("an image-only steer sends Codex no empty text input", async () => {
  const { server } = await steering((session) => session.steer("", [png]));

  expect(server.requests("turn/steer")[0]?.params).toMatchObject({
    input: [{ type: "localImage", path: "/stage/shot.png" }],
  });
});
