import { expect, test } from "bun:test";
import { DataSource, SessionId } from "@polaris/protocol";
import { Effect, Redacted } from "effect";
import { resolveReadSource } from "./readSource.ts";

const resolved = (host: string) => ({
  source: new DataSource({
    id: "app",
    name: "app",
    engine: "postgres",
    host,
    port: 5432,
    database: "app",
    user: "reader",
    locality: "remote",
    foundIn: { kind: "manual" },
    access: "needs-approval",
    writes: "off",
    label: { text: "", colour: "none" },
    reachable: true,
  }),
  connection: {
    hostname: host,
    port: 5432,
    database: "app",
    username: "reader",
    password: Redacted.make(""),
    tls: false as const,
  },
  matchUrl: Redacted.make(`postgres://reader@${host}/app`),
});

test("approval preparation uses the refreshed target and connection", async () => {
  let current = resolved("old.example");

  const refresh = () =>
    Effect.sync(() => {
      current = resolved("new.example");

      return [current.source];
    });

  const result = await Effect.runPromise(
    resolveReadSource(
      {
        refresh,
        resolve: () => Effect.sync(() => current),
      },
      { sessionId: SessionId.make("s"), source: "app", tool: "query" }
    )
  );

  expect(result.source.host).toBe("new.example");
  expect(result.connection.hostname).toBe("new.example");
});
