import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DesktopMcp } from "../desktop/index.ts";
import { fakeDeps, fakeHost, fakeRunner } from "../desktop/testing.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import { cleanup, scripted, sessionWith } from "./testing/session.ts";

const desktopService = (ready: boolean) =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* DesktopMcp;
    }).pipe(
      Effect.provide(
        DesktopMcp.layerWith(
          fakeDeps(fakeRunner({}).runner, { host: fakeHost({ ready: Effect.succeed(ready) }) })
        )
      )
    )
  );

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const ThreadConfig = Schema.Struct({
  config: Schema.Struct({
    "features.computer_use": Schema.Boolean,
    "mcp_servers.polaris_desktop": Schema.optionalKey(
      Schema.Struct({
        url: Schema.String,
        tools: Schema.Record(Schema.String, Schema.Struct({ approval_mode: Schema.String })),
      })
    ),
  }),
});

const decodeThread = Schema.decodeUnknownSync(ThreadConfig);

const threadConfig = async (ready: boolean, options: { readonly readOnly?: boolean } = {}) => {
  const withSession = sessionWith((o) => makeCodexDriver({ ...o, desktop: desktopService(ready) }));

  const { server } = await withSession(
    scripted(() => {}),
    () => Effect.void,
    options
  );

  return decodeThread(server.requests("thread/start")[0]?.params).config;
};

describe("polaris_desktop in Codex", () => {
  test("a thread gets the loopback server, pre-approved, and Codex's own computer use off", async () => {
    const config = await threadConfig(true);
    const server = config["mcp_servers.polaris_desktop"];

    expect(config["features.computer_use"]).toBe(false);
    expect(server?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/desktop\/[a-f0-9]{64}$/);
    expect(server?.tools["type"]).toEqual({ approval_mode: "approve" });
  });

  test("without a ready Host, and for the Reviewer, no server but computer use still off", async () => {
    for (const [ready, options] of [
      [false, {}],
      [true, { readOnly: true }],
    ] as const) {
      const config = await threadConfig(ready, options);

      expect(config["mcp_servers.polaris_desktop"]).toBeUndefined();
      expect(config["features.computer_use"]).toBe(false);
    }
  });
});
