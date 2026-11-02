import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Model, SessionId, TurnId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { makeCodexDriver } from "./CodexDriver.ts";
import { listCodexModels } from "./models.ts";
import { type ClientRequest, type Handler, startFakeAppServer } from "./testing/FakeAppServer.ts";
import { bunFake } from "../testing/shellFake.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Socket paths must stay under ~104 bytes, so tests use a short temp root. */
const tempDir = () => {
  const dir = newTempDir("pcm-", { short: true });
  cleanup.push(() => removeTempDir(dir));

  return dir;
};

const model = (id: string, extra: { hidden?: boolean; isDefault?: boolean } = {}) => ({
  id,
  model: id,
  displayName: id.toUpperCase(),
  description: id === "gpt-b" ? "" : `The ${id} model`,
  hidden: extra.hidden ?? false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "" },
    { reasoningEffort: "xhigh", description: "" },
  ],
  defaultReasoningEffort: "low",
  isDefault: extra.isDefault ?? false,
});

const decodeCursor = Schema.decodeUnknownSync(
  Schema.Struct({ cursor: Schema.NullOr(Schema.String), includeHidden: Schema.Boolean })
);

/** Two pages: the first ends with a cursor, the second holds a hidden Model. */
const PAGES = {
  first: { data: [model("gpt-a", { isDefault: true })], nextCursor: "p2" },
  p2: { data: [model("gpt-b"), model("gpt-secret", { hidden: true })], nextCursor: null },
};

const pageFor = (request: ClientRequest) =>
  decodeCursor(request.params).cursor === "p2" ? PAGES.p2 : PAGES.first;

const EXPECTED = [
  {
    id: "gpt-a",
    name: "GPT-A",
    description: "The gpt-a model",
    efforts: ["low", "xhigh"],
    defaultEffort: "low",
    isDefault: true,
  },
  {
    id: "gpt-b",
    name: "GPT-B",
    description: null,
    efforts: ["low", "xhigh"],
    defaultEffort: "low",
    isDefault: false,
  },
];

const listing: Handler = (request, conn) => {
  if (request.method === "initialize") return conn.reply({ userAgent: "fake" });

  if (request.method === "model/list") return conn.reply(pageFor(request));
  conn.replyError(-32601, "unexpected");
};

describe("Codex Models", () => {
  test("model/list on the running app-server: every page, hidden Models left out", async () => {
    const socketPath = join(tempDir(), "s.sock");
    const server = startFakeAppServer(socketPath, listing);
    cleanup.push(server.stop);

    const models = await Effect.runPromise(
      listCodexModels({ codexPath: "/nonexistent/codex", socketPath, clientVersion: "1" })
    );

    expect(models).toEqual(EXPECTED.map((m) => new Model(m)));
    expect(server.requests("model/list").map((r) => decodeCursor(r.params))).toEqual([
      { cursor: null, includeHidden: false },
      { cursor: "p2", includeHidden: false },
    ]);
    // Listing never starts a thread.
    expect(server.requests("thread/start")).toEqual([]);
  });

  test("with no app-server running, a private one on stdio answers and exits", async () => {
    const dir = tempDir();
    const pidFile = join(dir, "pid");

    // A stand-in `codex app-server` speaking JSON lines on stdio.
    const codexPath = bunFake(
      dir,
      "codex",
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const pages = ${JSON.stringify(PAGES)};
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id === undefined) continue;
    const result = message.method === "model/list"
      ? pages[message.params.cursor ?? "first"]
      : { userAgent: "fake" };
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
  }
}
`
    );

    const models = await Effect.runPromise(
      listCodexModels({ codexPath, socketPath: join(dir, "none.sock"), clientVersion: "1" })
    );

    expect(models.map((m) => m.id)).toEqual(["gpt-a", "gpt-b"]);
    const pid = Number(await Bun.file(pidFile).text());
    await Bun.sleep(50);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("each Turn sends its Model, effort and explicit fast-mode routing on turn/start", async () => {
    const socketPath = join(tempDir(), "s.sock");
    let turns = 0;

    const server = startFakeAppServer(socketPath, (request, conn) => {
      switch (request.method) {
        case "initialize":
          return conn.reply({ userAgent: "fake" });
        case "thread/start":
          return conn.reply({ thread: { id: "thr" } });
        case "turn/start": {
          const id = `ct${++turns}`;
          conn.reply({ turn: { id } });

          return conn.notify("turn/completed", {
            threadId: "thr",
            turn: { id, items: [], status: "completed", error: null },
          });
        }

        default:
          return conn.reply({});
      }
    });

    cleanup.push(server.stop);

    const turnStarts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* makeCodexDriver({
            socketPath,
            spawnAppServer: false,
            codexPath: "/opt/codex",
          });

          const session = yield* driver.open({
            sessionId: SessionId.make("s1"),
            cwd: "/repo",
            permissionMode: "supervised",
            model: "gpt-a",
            effort: null,
            serviceTier: "priority",
            resumeCursor: null,
          });

          const send = (
            n: number,
            m: string | null,
            effort: string | null,
            serviceTier: "priority" | "default"
          ) =>
            session.sendTurn({
              turnId: TurnId.make(`t${n}`),
              prompt: "hi",
              attachments: [],
              model: m,
              effort,
              serviceTier,
            });

          expect(server.requests("thread/start")[0]?.params).toMatchObject({
            serviceTier: "priority",
          });
          yield* send(1, "gpt-a", null, "priority");
          yield* Effect.sleep("30 millis");
          yield* send(2, "gpt-b", "xhigh", "default");

          return server.requests("turn/start");
        })
      )
    );

    const decodeChoice = Schema.decodeUnknownSync(
      Schema.Struct({
        model: Schema.optional(Schema.String),
        effort: Schema.optional(Schema.String),
        serviceTier: Schema.String,
      })
    );

    expect(turnStarts.map((r) => decodeChoice(r.params))).toEqual([
      { model: "gpt-a", serviceTier: "priority" },
      { model: "gpt-b", effort: "xhigh", serviceTier: "default" },
    ]);
  });
});
