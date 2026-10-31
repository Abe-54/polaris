import { expect, test } from "bun:test";
import { SessionId, Unsupported } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { type DataSession, watchDataSources, watchDataQueryLog, queryData } from "./data.ts";

const notCalled = () => Effect.die("Data RPC called on an older Daemon");

const watchNotCalled = () => {
  throw new Error("Data watch called on an older Daemon");
};

const session: DataSession = {
  capabilities: [],
  client: {
    "data.sources.watch": watchNotCalled,
    "data.queryLog.watch": watchNotCalled,
    "data.describe": notCalled,
    "data.query": notCalled,
    "data.source.save": notCalled,
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
