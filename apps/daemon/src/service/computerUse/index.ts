/**
 * The Daemon's one way to run a process inside "Polaris Computer Use.app" (ADR 0104), so that
 * macOS charges the helper's privacy grants and never the Daemon's. stdio is kept, so MCP
 * over stdio works. macOS only: other Hosts have no TCC and run agent-desktop directly.
 */
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect";
import { helperBeside } from "./bundle.ts";
import { type ChannelOptions, spawnInHelper } from "./channel.ts";
import { type Launch, openHelper, runDisclaimed } from "./launch.ts";
import { type ComputerUsePermissions, permissionsOf } from "./permissions.ts";
import { type HelperProcess, type HelperRequest, spawnSetting, type SpawnVia } from "./process.ts";

export {
  COMPUTER_USE_BUNDLE,
  COMPUTER_USE_BUNDLE_ID,
  COMPUTER_USE_DEV_BUNDLE_ID,
  type HelperTool,
} from "./bundle.ts";

export type { ComputerUseGrant, ComputerUsePermissions } from "./permissions.ts";

export {
  EXIT_NO_DISCLAIM,
  EXIT_REFUSED,
  type HelperProcess,
  type HelperRequest,
  spawnSetting,
  type SpawnVia,
} from "./process.ts";

export class ComputerUseUnavailable extends Schema.TaggedError<ComputerUseUnavailable>()(
  "ComputerUseUnavailable",
  { message: Schema.String }
) {}

export interface HelperOptions extends ChannelOptions {
  /** The Host's setting, read for each process; `request.via` overrides it. */
  readonly via?: () => SpawnVia;
  /** How the launcher is started for `launch-services`; `open` when absent. */
  readonly launch?: Launch;
}

const unavailable = (what: string) => (cause: unknown) =>
  new ComputerUseUnavailable({ message: `${what}: ${String(cause)}` });

const start = (helper: string, request: HelperRequest, options: HelperOptions) => {
  const via = request.via ?? (options.via ?? spawnSetting)();
  const launch = via === "launch-services" ? (options.launch ?? openHelper) : runDisclaimed;

  return Effect.tryPromise({
    try: () => spawnInHelper(helper, request, via, launch, options),
    catch: unavailable("the computer use helper could not be started"),
  });
};

const make = (locate: () => string | null, options: HelperOptions) => {
  const located = Effect.suspend(() => {
    const helper = locate();

    return helper === null
      ? Effect.fail(
          new ComputerUseUnavailable({
            message: "this Daemon has no computer use helper beside it",
          })
        )
      : Effect.succeed(helper);
  });

  const spawn = Effect.fn("ComputerUseHelper.spawn")(function* (request: HelperRequest) {
    const helper = yield* located;

    return yield* Effect.acquireRelease(start(helper, request, options), (running) =>
      Effect.sync(() => running.kill("SIGKILL"))
    );
  });

  const permissions = Effect.scoped(
    Effect.gen(function* () {
      const status = yield* spawn({ tool: "agent-desktop", args: ["status"] });
      status.end();

      const output = yield* Effect.tryPromise({
        try: () => new Response(status.stdout).text(),
        catch: unavailable("agent-desktop's status could not be read"),
      });

      return yield* Option.match(permissionsOf(output), {
        onNone: () =>
          Effect.fail(
            new ComputerUseUnavailable({ message: "agent-desktop's status made no sense" })
          ),
        onSome: Effect.succeed,
      });
    })
  );

  return { spawn, permissions };
};

export class ComputerUseHelper extends Context.Service<
  ComputerUseHelper,
  {
    /**
     * Starts a tool inside the helper with responsibility disclaimed, or through
     * LaunchServices when the setting says so. Closing the scope kills it. The helper's
     * launcher serves this process only when it is signed as the Daemon (ENG-867).
     */
    readonly spawn: (
      request: HelperRequest
    ) => Effect.Effect<HelperProcess, ComputerUseUnavailable, Scope.Scope>;
    /** `ready`, or `needs setup` with the grants the helper is missing. */
    readonly permissions: Effect.Effect<ComputerUsePermissions, ComputerUseUnavailable>;
  }
>()("polaris/daemon/service/ComputerUseHelper") {
  /** The helper found by `locate` at each use; tests pass a built one and their own launch. */
  static readonly layerAt = (locate: () => string | null, options: HelperOptions = {}) =>
    Layer.sync(ComputerUseHelper, () => ComputerUseHelper.of(make(locate, options)));

  /** The helper installed beside this Daemon's own bundle. */
  static readonly layer = ComputerUseHelper.layerAt(() => helperBeside(process.execPath));
}
