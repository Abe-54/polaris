import { describe, expect, test } from "bun:test";
import { DeveloperMode, WorkspaceId } from "@polaris/protocol";
import { Effect, Fiber, Queue, Stream } from "effect";
import { makeHostDeveloperModes, type WatchSession } from "../developerMode/index.ts";
import { developerModeSource } from "./adapter.ts";

const mode = (effective: boolean, workspace: string | null) =>
  DeveloperMode.make({
    leases: 0,
    fromSource: false,
    stored: effective,
    effective,
    polarisWorkspaceId: workspace === null ? null : WorkspaceId.make(workspace),
    polarisWorkspaceSource: workspace === null ? null : "remote",
  });

describe("developerModeSource", () => {
  test("follows the Host that holds the Polaris Workspace as per-Host modes change", () => {
    const modes = new Map([["local", mode(false, null)]]);
    let changed: () => void = () => undefined;

    const source = developerModeSource("local", {
      all: () => modes,
      onChange: (listener) => {
        changed = listener;

        return () => undefined;
      },
    });

    const heard: Array<unknown> = [];

    source.subscribe((gate) => heard.push(gate));
    modes.set("studio", mode(true, "ws-polaris"));
    changed();

    expect(heard).toEqual([{ hostKey: "studio", enabled: true }]);
    expect(source.current()).toEqual({ hostKey: "studio", enabled: true });
  });

  test("with no per-Host state wired, Self-Traces stay off", () => {
    expect(developerModeSource("local").current()).toEqual({ hostKey: "local", enabled: false });
  });
});

test("the gate turns on from the Desktop's watched per-Host Developer Mode (ENG-709)", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const modes = makeHostDeveloperModes();
      const source = developerModeSource("local", modes);
      const heard: Array<unknown> = [];
      const turnedOn = Promise.withResolvers<void>();
      source.subscribe((gate) => {
        heard.push(gate);

        if (gate.enabled) turnedOn.resolve();
      });

      const sessions = yield* Queue.unbounded<WatchSession | null>();
      const fiber = yield* Effect.forkChild(modes.watch("local", Stream.fromQueue(sessions)));

      expect(source.current()).toEqual({ hostKey: "local", enabled: false });

      yield* Queue.offer(sessions, {
        capabilities: ["developer-mode"],
        client: {
          "developerMode.watch": () =>
            Stream.concat(Stream.succeed(mode(true, null)), Stream.never),
        },
      });
      yield* Effect.promise(() => turnedOn.promise);

      expect(source.current()).toEqual({ hostKey: "local", enabled: true });
      expect(heard.at(-1)).toEqual({ hostKey: "local", enabled: true });

      yield* Fiber.interrupt(fiber);
      expect(source.current()).toEqual({ hostKey: "local", enabled: false });
    })
  ));
