import { expect, test } from "bun:test";
import { SessionId, TurnId, Unsupported } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import {
  type DataSession,
  watchDataSources,
  watchDataQueryLog,
  queryData,
  getDataSchemaDiff,
  saveDataFileSource,
} from "./data.ts";

const notCalled = () => Effect.die("Data RPC called on an older Daemon");

const watchNotCalled = () => {
  throw new Error("Data watch called on an older Daemon");
};

const session: DataSession = {
  capabilities: [],
  client: {
    "data.sources.watch": watchNotCalled,
    "data.queryLog.watch": watchNotCalled,
    "data.schemaDiff": notCalled,
    "data.describe": notCalled,
    "data.query": notCalled,
    "data.edits.commit": notCalled,
    "data.source.save": notCalled,
    "data.source.saveFile": notCalled,
    "data.source.remove": notCalled,
    "data.source.label": notCalled,
    "data.query.stream": watchNotCalled,
    "data.queryLog.page": notCalled,
    "data.source.access": notCalled,
  },
};

test("older Daemons are never asked for Data: watches end empty and Queries report Unsupported", async () => {
  const sessionId = SessionId.make("session");
  expect(
    await Effect.runPromise(Stream.runCollect(watchDataSources(session, { sessionId })))
  ).toEqual([]);
  expect(
    await Effect.runPromise(Stream.runCollect(watchDataQueryLog(session, { sessionId })))
  ).toEqual([]);
  expect(
    await Effect.runPromise(
      Effect.flip(queryData(session, { sessionId, source: "app", sql: "select 1" }))
    )
  ).toEqual(new Unsupported({ capability: "data" }));
});

test("Schema Diff separately gates older Data-capable Daemons", async () => {
  expect(
    await Effect.runPromise(
      Effect.flip(
        getDataSchemaDiff(
          { ...session, capabilities: ["data"] },
          { sessionId: SessionId.make("s") }
        )
      )
    )
  ).toEqual(new Unsupported({ capability: "data.schemaDiff" }));
});

test.each([
  [["data", "data.schemaDiff"], [{ sessionId: "s", turn: "t1" }]],
  [
    ["data", "data.schemaDiff", "data.schemaDiff.turns"],
    [{ sessionId: "s", turn: "t1", turns: ["t1", "t2"] }],
  ],
] as const)("a Turn group's Schema Diff asks %p for: %p", async (capabilities, expected) => {
  const asked: Array<unknown> = [];

  // The answer doesn't matter here, only what was asked.
  await Effect.runPromiseExit(
    getDataSchemaDiff(
      {
        ...session,
        capabilities,
        client: {
          ...session.client,
          "data.schemaDiff": (input) => {
            asked.push(input);

            return Effect.die("answered");
          },
        },
      },
      {
        sessionId: SessionId.make("s"),
        turn: TurnId.make("t1"),
        turns: [TurnId.make("t1"), TurnId.make("t2")],
      }
    )
  );
  expect(asked).toEqual([...expected]);
});

test("a Data-capable Daemon without SQLite is never asked to save a file source", async () => {
  expect(
    await Effect.runPromise(
      Effect.flip(
        saveDataFileSource(
          { ...session, capabilities: ["data"] },
          {
            sessionId: SessionId.make("s"),
            name: "local",
            path: "/work/app/dev.db",
            label: { text: "", colour: "none" },
          }
        )
      )
    )
  ).toEqual(new Unsupported({ capability: "data.sqlite" }));
});
