import { afterEach, describe, expect, test } from "bun:test";
import type { ComputerUseState } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { DesktopMcp } from "../desktop/index.ts";
import { fakeDeps, fakeHost, fakeRunner, NO_DESKTOP, OFF, READY } from "../desktop/testing.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import { cleanup, scripted, sessionWith } from "./testing/session.ts";

const desktopService = (state: ComputerUseState) =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* DesktopMcp;
    }).pipe(
      Effect.provide(
        DesktopMcp.layerWith(
          fakeDeps(fakeRunner({}).runner, { host: fakeHost({ state: Effect.succeed(state) }) })
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
        tool_timeout_sec: Schema.Number,
        tools: Schema.Record(Schema.String, Schema.Struct({ approval_mode: Schema.String })),
      })
    ),
  }),
});

const decodeThread = Schema.decodeUnknownSync(ThreadConfig);

const threadConfig = async (
  state: ComputerUseState,
  options: { readonly readOnly?: boolean } = {}
) => {
  const withSession = sessionWith((o) => makeCodexDriver({ ...o, desktop: desktopService(state) }));

  const { server } = await withSession(
    scripted(() => {}),
    () => Effect.void,
    options
  );

  return decodeThread(server.requests("thread/start")[0]?.params).config;
};

describe("polaris_desktop in Codex", () => {
  test("a thread gets the loopback server, pre-approved, and Codex's own computer use off", async () => {
    const config = await threadConfig(READY);
    const server = config["mcp_servers.polaris_desktop"];

    expect(config["features.computer_use"]).toBe(false);
    expect(server?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/desktop\/[a-f0-9]{64}$/);
    expect(server?.tools["type"]).toEqual({ approval_mode: "approve" });
  });

  test("without a ready Host, and for the Reviewer, no server but computer use still off", async () => {
    for (const [state, options] of [
      [NO_DESKTOP, {}],
      [READY, { readOnly: true }],
    ] as const) {
      const config = await threadConfig(state, options);

      expect(config["mcp_servers.polaris_desktop"]).toBeUndefined();
      expect(config["features.computer_use"]).toBe(false);
    }
  });

  test("an Off Host gets only request_computer_use, allowed to wait out the request", async () => {
    const server = (await threadConfig(OFF))["mcp_servers.polaris_desktop"];

    expect(Object.keys(server?.tools ?? {})).toEqual(["request_computer_use"]);
    // The request waits up to 30 minutes; Codex's default would cut the call off at 60 s.
    expect(server?.tool_timeout_sec).toBeGreaterThan(30 * 60);
  });
});
