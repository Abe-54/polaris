/**
 * Drives a throwaway iOS Simulator end to end through the `polaris_simulator` MCP server, with
 * the real agent-device install and detection. Skipped off a Mac or without Xcode.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime, Schema, Scope } from "effect";
import { SimulatorTools } from "../../install/simulator/index.ts";
import { HostPlatform } from "../../platform/index.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { SimulatorDetection } from "../../simulator/index.ts";
import type { SimulatorActivity } from "./activity.ts";
import { SimulatorMcp, SimulatorMcpLive } from "./index.ts";
import { callTool, textOf } from "./mcp.testing.ts";

const simctl = (...args: ReadonlyArray<string>) =>
  execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 300_000 }).trim();

const xcode = (() => {
  if (process.platform !== "darwin") return false;

  try {
    simctl("help");

    return true;
  } catch {
    return false;
  }
})();

const Runtimes = Schema.Struct({
  runtimes: Schema.Array(
    Schema.Struct({
      identifier: Schema.String,
      platform: Schema.optionalKey(Schema.String),
      isAvailable: Schema.Boolean,
      supportedDeviceTypes: Schema.Array(Schema.Struct({ identifier: Schema.String })),
    })
  ),
});

const DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";

/** The newest available iOS runtime that has an iPhone 17. */
const runtimeId = () =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Runtimes))(simctl("list", "runtimes", "-j"))
    .runtimes.filter(
      (runtime) =>
        runtime.isAvailable &&
        runtime.platform === "iOS" &&
        runtime.supportedDeviceTypes.some((type) => type.identifier === DEVICE_TYPE)
    )
    .map((runtime) => runtime.identifier)
    .at(-1);

const marks: string[] = [];

const activity: SimulatorActivity = {
  agentOpened: (sessionId, id) => Effect.sync(() => void marks.push(`opened ${sessionId} ${id}`)),
  agentDriving: (sessionId) =>
    Effect.acquireRelease(
      Effect.sync(() => void marks.push(`driving ${sessionId}`)),
      () => Effect.sync(() => void marks.push(`idle ${sessionId}`))
    ),
  shown: () => Effect.succeed(null),
  agentBooted: (id) => Effect.sync(() => void marks.push(`booted ${id}`)),
};

interface E2eState {
  udid: string;
  root: string;
  url: string;
  runtime: ManagedRuntime.ManagedRuntime<SimulatorMcp, never> | null;
  scope: Scope.Closeable | null;
}

const state: E2eState = { udid: "", root: "", url: "", runtime: null, scope: null };

describe.skipIf(!xcode)("the Simulator's MCP server on a real Simulator", () => {
  beforeAll(async () => {
    const runtimeOf = runtimeId();

    if (runtimeOf === undefined) throw new Error("no iOS runtime with an iPhone 17");
    state.udid = simctl("create", `polaris-e2e-${process.pid}`, DEVICE_TYPE, runtimeOf);
    state.root = newTempDir("simulator-e2e-");

    const runtime = ManagedRuntime.make(
      SimulatorMcpLive.layerWith(Effect.succeed(activity), { softWaitMs: 600_000 }).pipe(
        Layer.provide(
          Layer.mergeAll(
            SimulatorDetection.layer,
            SimulatorTools.layerWith(() => ({ root: join(state.root, "tools") }))
          )
        ),
        Layer.provide(HostPlatform.live)
      )
    );

    const scope = Effect.runSync(Scope.make());

    state.runtime = runtime;
    state.scope = scope;

    const server = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SimulatorMcp).forSession(SessionId.make("e2e"));
      }).pipe(Scope.provide(scope))
    );

    state.url = server!.url;
  }, 600_000);

  afterAll(async () => {
    if (state.scope !== null) await Effect.runPromise(Scope.close(state.scope, Exit.void));
    await state.runtime?.dispose();

    if (state.udid !== "") {
      try {
        simctl("shutdown", state.udid);
      } catch {
        // Already shut down.
      }

      simctl("delete", state.udid);
    }

    if (state.root !== "") removeTempDir(state.root);
  }, 300_000);

  test("open, snapshot, tap and screenshot Settings", async () => {
    const listed = await callTool(state.url, "simulator_list");

    expect(textOf(listed)).toContain(state.udid);

    const opened = await callTool(state.url, "simulator_open", {
      id: state.udid,
      app: "com.apple.Preferences",
    });

    expect(opened.isError, textOf(opened)).toBeUndefined();
    expect(marks).toContain(`booted ${state.udid}`);
    expect(marks).toContain(`opened e2e ${state.udid}`);
    const snapshot = await callTool(state.url, "simulator_snapshot");

    expect(textOf(snapshot)).toContain("General");
    const tapped = await callTool(state.url, "simulator_tap", { target: 'label="General"' });

    expect(tapped.isError, textOf(tapped)).toBeUndefined();
    expect(textOf(await callTool(state.url, "simulator_snapshot"))).toContain("About");
    const shot = await callTool(state.url, "simulator_screenshot");

    expect(shot.content[0]?.type).toBe("image");
    expect(
      Buffer.from(shot.content[0]?.data ?? "", "base64")
        .subarray(1, 4)
        .toString()
    ).toBe("PNG");
    expect(marks.filter((mark) => mark === "driving e2e").length).toBe(
      marks.filter((mark) => mark === "idle e2e").length
    );
  }, 900_000);
});
