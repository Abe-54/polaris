/**
 * `LocalHost`: whether this Client has a local Host, what it's called, and which Daemon
 * serves it (the installed system Daemon, the app's dev Daemon, or a given socket). The
 * composition root picks the Layer once from the platform. See docs/adr/0045-platform-services.md.
 */
import { HostTarget } from "@polaris/client";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { clientCopy } from "../../shared/clientCopy.ts";
import {
  awaitInstalledDaemon,
  type LocalDaemon,
  type LocalDaemonOptions,
  resolveLocalDaemon,
} from "./daemon.ts";

export type { LocalDaemon, LocalDaemonOptions } from "./daemon.ts";

export {
  awaitInstalledDaemon,
  devHome,
  socketLive,
  startDevDaemon,
  systemSocket,
} from "./daemon.ts";

export class LocalHostUnsupported extends Schema.TaggedError<LocalHostUnsupported>()(
  "LocalHostUnsupported",
  { message: Schema.String }
) {}

export class LocalHostFailed extends Schema.TaggedError<LocalHostFailed>()("LocalHostFailed", {
  message: Schema.String,
}) {}

export interface LocalHostApi {
  /** Whether this Client can have a local Host at all; false on Windows on Arm. */
  readonly supported: boolean;
  /** The local Host's name: `clientCopy().localHost` ("This Mac") unless overridden. */
  readonly label: string;
  /** Finds (or in dev, starts) the Daemon; the first one found is kept. */
  readonly resolve: Effect.Effect<LocalDaemon, LocalHostUnsupported | LocalHostFailed>;
  /** The Daemon `resolve` found, if it has run. */
  readonly current: Effect.Effect<Option.Option<LocalDaemon>>;
  /** Waits for the Daemon installed in `home` to listen after an install or a start. */
  readonly listening: (home: string) => Effect.Effect<void, LocalHostFailed | LocalHostUnsupported>;
  /** Stops the Daemon if this app started it. */
  readonly stop: Effect.Effect<void>;
}

/** How Polaris reaches the local Host's Daemon; `installedHome` only for one it installed. */
export const localTarget = (daemon: LocalDaemon): HostTarget =>
  daemon.installedHome === null
    ? HostTarget.Local({ socketPath: daemon.socketPath })
    : HostTarget.Local({ socketPath: daemon.socketPath, installedHome: daemon.installedHome });

const failed = (cause: unknown) =>
  new LocalHostFailed({ message: cause instanceof Error ? cause.message : String(cause) });

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failed });

type Found = Pick<LocalHostApi, "resolve" | "current" | "stop">;

/** Resolves once through `find`, then keeps that Daemon; `initial` counts as found. */
const once = (find: () => Promise<LocalDaemon>, initial: LocalDaemon | null = null): Found => {
  let daemon = initial;

  return {
    resolve: Effect.suspend(() =>
      daemon === null
        ? Effect.tap(attempt(find), (found) => Effect.sync(() => void (daemon ??= found)))
        : Effect.succeed(daemon)
    ),
    current: Effect.sync(() => Option.fromNullOr(daemon)),
    stop: Effect.promise(() => daemon?.stop() ?? Promise.resolve()),
  };
};

export interface NativeOptions extends LocalDaemonOptions {
  /** Overrides the name (`POLARIS_DESKTOP_LOCAL_LABEL`). */
  readonly label?: string | undefined;
  readonly platform?: NodeJS.Platform;
}

const native = (options: NativeOptions): LocalHostApi => {
  const found = once(() => resolveLocalDaemon(options));
  const label = options.label ?? "";

  return {
    ...found,
    supported: true,
    label: label === "" ? clientCopy(options.platform ?? process.platform).localHost : label,
    listening: (home) =>
      Effect.flatMap(found.resolve, (daemon) =>
        attempt(() => awaitInstalledDaemon(daemon.socketPath, home))
      ),
  };
};

const refusing = (platform: string): LocalHostApi => {
  const copy = clientCopy(platform);
  const refused = new LocalHostUnsupported({ message: copy.localHostUnsupported });

  return {
    supported: false,
    label: copy.localHost,
    resolve: Effect.fail(refused),
    current: Effect.succeed(Option.none()),
    listening: () => Effect.fail(refused),
    stop: Effect.void,
  };
};

/** A Daemon for tests: installed in `installedHome`, or (null) the app's own dev Daemon. */
export const testDaemon = (installedHome: string | null): LocalDaemon => ({
  socketPath: installedHome === null ? "dev.sock" : `${installedHome}/.polaris/daemon.sock`,
  benchHarness: installedHome === null,
  installedHome,
  stop: () => Promise.resolve(),
});

export interface TestOptions {
  /** The Daemon serving the local Host, as if already resolved; absent, resolving fails. */
  readonly daemon?: LocalDaemon;
  readonly label?: string;
  /** Rejects with why the Daemon didn't listen; resolves by default. */
  readonly listening?: (home: string) => Promise<void>;
}

const scripted = (options: TestOptions): LocalHostApi => ({
  ...once(() => Promise.reject(new Error("no local Daemon in this test")), options.daemon ?? null),
  supported: true,
  label: options.label ?? clientCopy("darwin").localHost,
  listening: (home) => attempt(() => options.listening?.(home) ?? Promise.resolve()),
});

export class LocalHost extends Context.Service<LocalHost, LocalHostApi>()(
  "polaris/desktop/LocalHost"
) {
  /**
   * The system Daemon (socket, or on Windows its pipe), a dev Daemon, or a given one
   * (`daemon.ts`): macOS, Linux and Windows x64.
   */
  static readonly native = (options: NativeOptions) =>
    Layer.succeed(LocalHost, LocalHost.of(native(options)));

  /** No local Host (Windows on Arm, no Daemon build): nothing resolves, installs or upgrades. */
  static readonly unsupported = (platform: NodeJS.Platform = "win32") =>
    Layer.succeed(LocalHost, LocalHost.of(refusing(platform)));

  /** The Layer for this Client's platform; Windows has a Daemon only for x64 (ADR 0059). */
  static readonly forPlatform = (
    platform: NodeJS.Platform,
    options: NativeOptions,
    arch: string = process.arch
  ) =>
    (options.env.POLARIS_DESKTOP_SCRIPTED === "1" && !options.env.POLARIS_DESKTOP_LOCAL_SOCKET) ||
    (platform === "win32" && arch !== "x64")
      ? LocalHost.unsupported(platform)
      : LocalHost.native({ ...options, platform });

  /** A fixed Daemon, or none, for tests on any OS. */
  static readonly test = (options: TestOptions = {}) =>
    Layer.succeed(LocalHost, LocalHost.of(scripted(options)));
}
