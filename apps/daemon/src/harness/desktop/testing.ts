/** A fake agent-desktop at the process boundary: canned envelopes by command, every argv kept. */
import { AppId, AppRef } from "@polaris/protocol";
import { Effect, type Schema, Stream } from "effect";
import { Authorization, type Authorize } from "./authorize.ts";
import type { DisplayAwake } from "./awake.ts";
import type { DesktopHost } from "./host.ts";
import type { DesktopMcpDeps } from "./index.ts";
import type { DesktopRunner } from "./runner.ts";

export const ok = (command: string, data: typeof Schema.Json.Type) =>
  JSON.stringify({ version: "2.6", ok: true, command, data });

export const error = (command: string, code: string, message = code) =>
  JSON.stringify({ version: "2.6", ok: false, command, error: { code, message } });

/** Answers by the first non-flag word of the argv (`session start` by its two). */
export const fakeRunner = (answers: Readonly<Record<string, string>>) => {
  const calls: Array<ReadonlyArray<string>> = [];

  const commandOf = (args: ReadonlyArray<string>) => {
    const words = args.filter(
      (arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--session")
    );

    return words[0] === "session" || words[0] === "cursor-overlay"
      ? `${words[0]} ${words[1]}`
      : words[0];
  };

  const runner: DesktopRunner = {
    run: (args) =>
      Effect.sync(() => {
        calls.push(args);
        const command = commandOf(args) ?? "";

        return answers[command] ?? ok(command, {});
      }),
  };

  return { runner, calls, commandOf };
};

/** Every app allowed, unasked: for tests of what isn't the policy. */
export const allowAll: Authorize = {
  use: () => Effect.succeed(Authorization.Allow({ asked: false })),
  controlling: () => Effect.succeed(true),
  release: () => Effect.void,
  forget: () => Effect.void,
};

export const fakeHost = (overrides: Partial<DesktopHost> = {}): DesktopHost => ({
  ready: Effect.succeed(true),
  env: Effect.succeed({}),
  locked: Effect.succeed(false),
  inputIdle: Effect.succeed(null),
  // Like a Host with no bundle ids: an app that isn't running is known by the name asked.
  identify: (app) => Effect.succeed(new AppRef({ id: AppId.make(app), name: app })),
  name: "workbox",
  ...overrides,
});

export const countingAwake = () => {
  const state = { held: 0, released: 0 };

  const awake: DisplayAwake = {
    hold: Effect.sync(() => {
      state.held += 1;

      return () => void (state.released += 1);
    }),
  };

  return { awake, state };
};

export const fakeDeps = (
  runner: DesktopRunner,
  overrides: Partial<DesktopMcpDeps> = {}
): DesktopMcpDeps => ({
  runner,
  host: fakeHost(),
  sessions: {
    title: () => Effect.succeed("Fill in the quarterly report in Numbers please"),
    turnEnds: () => Effect.succeed(Stream.never),
  },
  authorize: allowAll,
  awake: countingAwake().awake,
  ...overrides,
});
