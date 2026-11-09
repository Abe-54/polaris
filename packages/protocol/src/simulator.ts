/**
 * The Simulator (ENG-829, ADR 0099): iOS Simulators and Android Emulators on the Host, streamed
 * by Expo's device hub, a child process of the Daemon on the Host's loopback. Capability
 * `simulator`, advertised only when the Host can run at least one platform.
 *
 * A Client reaches the hub's port directly on a local Host, and through `hostAddress.open` on
 * a remote one: the hub's token travels in the Client's own bytes, so it needs no new stream.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { NotFound, Unsupported } from "./errors.ts";
import { HostAddressPort } from "./hostAddress.ts";
import { SessionId } from "./ids.ts";

export const SimulatorPlatform = Schema.Literals(["ios", "android"]);

export type SimulatorPlatform = typeof SimulatorPlatform.Type;

/**
 * What a Host lacks to run a platform's Simulators. `xcode`: Xcode and its Simulator runtimes.
 * `android-sdk`: the emulator and an AVD. `ffmpeg`: the user's own build, which serve-emu
 * encodes with (Polaris ships no GPL code). `kvm`: hardware acceleration on Linux.
 */
export const SimulatorRequirement = Schema.Literals(["xcode", "android-sdk", "ffmpeg", "kvm"]);

export type SimulatorRequirement = typeof SimulatorRequirement.Type;

/**
 * Why a Host's tools are installed but can't run Simulators yet. `xcode-first-launch`: Xcode is
 * finishing an update (`xcodebuild -runFirstLaunch`), which blocks `simctl` for minutes.
 */
export const SimulatorUpdateReason = Schema.Literals(["xcode-first-launch"]);

export type SimulatorUpdateReason = typeof SimulatorUpdateReason.Type;

/**
 * Whether this Host can run a platform: `Unsupported` can never (iOS off a Mac, or the Pi).
 * `Updating` has the tools but is finishing an update; a `SupportChanged` follows when it's done.
 */
export const SimulatorSupport = Schema.TaggedUnion({
  Ready: {},
  NeedsSetup: { missing: Schema.Array(SimulatorRequirement) },
  Updating: { reason: SimulatorUpdateReason },
  Unsupported: {},
});

export type SimulatorSupport = typeof SimulatorSupport.Type;

/** The Host's support for each platform. */
export const HostSimulatorSupport = Schema.Struct({
  ios: SimulatorSupport,
  android: SimulatorSupport,
});

export type HostSimulatorSupport = typeof HostSimulatorSupport.Type;

/** A Simulator's id: an iOS Simulator's UDID, or an Android Emulator's AVD name. */
export const SimulatorId = Schema.String.check(Schema.isMinLength(1));

export const SimulatorState = Schema.Literals(["Shutdown", "Booting", "Booted"]);

export type SimulatorState = typeof SimulatorState.Type;

export class Simulator extends Schema.Class<Simulator>("Simulator")({
  id: SimulatorId,
  platform: SimulatorPlatform,
  /** As the platform names it: "iPhone 17 Pro", "Pixel_9_API_36". */
  name: Schema.String,
  osVersion: Schema.String,
  state: SimulatorState,
  /** Polaris booted it, so `simulator.shutdown` may stop it without `force`. */
  bootedByPolaris: Schema.Boolean,
}) {}

/** The Host can't run Simulators now: no platform is ready, or the hub could not be installed. */
export class SimulatorUnavailable extends Schema.TaggedError<SimulatorUnavailable>()(
  "SimulatorUnavailable",
  { message: Schema.String }
) {}

/** No Simulator on this Host has `id`. */
export class SimulatorNotFound extends Schema.TaggedError<SimulatorNotFound>()(
  "SimulatorNotFound",
  { id: SimulatorId }
) {
  override get message(): string {
    return `No Simulator ${this.id} on this Host.`;
  }
}

/** The hub failed to start or to carry out the request; `detail` is its own account. */
export class HubFailed extends Schema.TaggedError<HubFailed>()("HubFailed", {
  detail: Schema.String,
}) {}

/** `simulator.shutdown` without `force` on a Simulator the user or another tool booted. */
export class SimulatorNotBootedByPolaris extends Schema.TaggedError<SimulatorNotBootedByPolaris>()(
  "SimulatorNotBootedByPolaris",
  { id: SimulatorId }
) {}

const SimulatorErrors = Schema.Union([
  SimulatorNotFound,
  SimulatorUnavailable,
  HubFailed,
  Unsupported,
]);

export const SimulatorWatchItem = Schema.TaggedUnion({
  /** Always first: the Host's support and every Simulator on it. */
  Snapshot: { support: HostSimulatorSupport, simulators: Schema.Array(Simulator) },
  /** Setup changed what the Host can run. */
  SupportChanged: { support: HostSimulatorSupport },
  /** A Simulator appeared or its state changed: replaces the one with the same `id`. */
  SimulatorChanged: { simulator: Simulator },
  /** A Simulator was deleted from the Host. */
  SimulatorRemoved: { id: SimulatorId },
});

export type SimulatorWatchItem = typeof SimulatorWatchItem.Type;

/** The Host's support and Simulators: a `Snapshot`, then changes until the Client unsubscribes. */
export const SimulatorWatch = Rpc.make("simulator.watch", {
  payload: {},
  success: SimulatorWatchItem,
  error: Unsupported,
  stream: true,
});

/** Boots a Simulator, marking it `bootedByPolaris`; booting a booted one is a no-op. */
export const SimulatorBoot = Rpc.make("simulator.boot", {
  payload: { id: SimulatorId },
  error: SimulatorErrors,
});

/**
 * Shuts a Simulator down. Without `force`, one Polaris didn't boot is refused with
 * `SimulatorNotBootedByPolaris`, so the user's own Simulator survives an agent's cleanup.
 */
export const SimulatorShutdown = Rpc.make("simulator.shutdown", {
  payload: { id: SimulatorId, force: Schema.optionalKey(Schema.Boolean) },
  error: Schema.Union([SimulatorErrors, SimulatorNotBootedByPolaris]),
});

/**
 * Restarts the hub, which clears wedged input (expo/expo-device-hub#569). Every open
 * `simulator.attach` then sends `Attached` again with the new port and token.
 */
export const SimulatorRestart = Rpc.make("simulator.restart", {
  payload: {},
  error: Schema.Union([SimulatorUnavailable, HubFailed, Unsupported]),
});

export const SimulatorAttachItem = Schema.TaggedUnion({
  /**
   * The hub listens on `port` of the Host's loopback and takes `token` in each request. First,
   * and again whenever the hub restarts: drop connections to the old port.
   */
  Attached: { port: HostAddressPort, token: Schema.String },
});

export type SimulatorAttachItem = typeof SimulatorAttachItem.Type;

/**
 * Makes `id` the Simulator `sessionId` shows, and holds the session as watching it: the hub
 * stays up while any attach is open, and ending the stream detaches. It does not boot `id`.
 */
export const SimulatorAttach = Rpc.make("simulator.attach", {
  payload: { sessionId: SessionId, id: SimulatorId },
  success: SimulatorAttachItem,
  error: Schema.Union([SimulatorErrors, NotFound]),
  stream: true,
});

export const SimulatorSessionItem = Schema.TaggedUnion({
  /** The Simulator the session shows, null for none: first, then whenever it changes. */
  Showing: { id: Schema.NullOr(SimulatorId) },
  /** An agent of the session opened Simulator `id`: the tab shows it and marks the agent's work. */
  AgentOpened: { id: SimulatorId },
  /** Whether an agent is driving the shown Simulator now: the tab's dot and the indicator. */
  AgentDriving: { active: Schema.Boolean },
});

export type SimulatorSessionItem = typeof SimulatorSessionItem.Type;

/** An Agent Session's Simulator and its agents' activity on it, `Showing` first. */
export const SimulatorSessionFeed = Rpc.make("simulator.sessionFeed", {
  payload: { sessionId: SessionId },
  success: SimulatorSessionItem,
  error: Schema.Union([NotFound, Unsupported]),
  stream: true,
});

export class SimulatorRpcs extends RpcGroup.make(
  SimulatorWatch,
  SimulatorBoot,
  SimulatorShutdown,
  SimulatorRestart,
  SimulatorAttach,
  SimulatorSessionFeed
) {}
