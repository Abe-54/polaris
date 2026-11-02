/**
 * Which Host gets the Mobile App's Self-Traces: one whose Developer Mode is effective and that
 * holds the Polaris Workspace. The Mobile App only reads Developer Mode (`developerMode.watch`).
 */
import {
  DEVELOPER_MODE_CAPABILITY,
  type DeveloperMode,
  SELF_TRACES_CAPABILITY,
  type SelfTraceBatch,
} from "@polaris/protocol";
import { Effect, Fiber, Stream } from "effect";
import type { DaemonClient } from "@polaris/client/rpc";
import type { SendOutcome } from "./tracer.ts";

/** The first Host, by id, that traces now and holds the Polaris Workspace; null for none. */
export const traceTargetHost = (modes: ReadonlyMap<string, DeveloperMode>): string | null => {
  const ready = [...modes]
    .flatMap(([hostId, mode]) =>
      mode.effective && mode.polarisWorkspaceId !== null ? [hostId] : []
    )
    .sort((a, b) => a.localeCompare(b));

  return ready[0] ?? null;
};

/** The RPCs Self-Traces use, so a fake Host needs only these. */
export type SelfTraceClient = Pick<DaemonClient, "developerMode.watch" | "traces.ingestSelf">;

/** What Self-Traces need of a HostConnection. */
export interface SelfTraceHost<C extends SelfTraceClient = SelfTraceClient> {
  readonly hostId: string;
  readonly live: () => {
    readonly epoch: number;
    readonly client: C;
    readonly capabilities: ReadonlyArray<string>;
  } | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly run: <A, E>(use: (client: C) => Effect.Effect<A, E>) => Promise<A>;
}

/**
 * Follows one Host's Developer Mode. The last value stands while the Host is unreachable, so
 * Spans keep buffering; a Host without the capabilities reports null.
 */
export const watchDeveloperMode = (
  connection: Pick<SelfTraceHost, "live" | "subscribe">,
  onMode: (mode: DeveloperMode | null) => void
): (() => void) => {
  let epoch: number | null = null;
  let fiber: Fiber.Fiber<void> | null = null;

  const follow = () => {
    const live = connection.live();

    if (live === null || live.epoch === epoch) return;
    epoch = live.epoch;

    if (fiber !== null) Effect.runFork(Fiber.interrupt(fiber));
    fiber = null;

    if (
      !live.capabilities.includes(DEVELOPER_MODE_CAPABILITY) ||
      !live.capabilities.includes(SELF_TRACES_CAPABILITY)
    )
      return onMode(null);

    fiber = Effect.runFork(
      Stream.runForEach(live.client["developerMode.watch"]({}), (mode) =>
        Effect.sync(() => onMode(mode))
      ).pipe(Effect.ignore)
    );
  };

  const unsubscribe = connection.subscribe(follow);
  follow();

  return () => {
    unsubscribe();

    if (fiber !== null) Effect.runFork(Fiber.interrupt(fiber));
  };
};

/** Sends one batch with `traces.ingestSelf`; a lost or absent connection keeps it for later. */
export const sendSelfTraces =
  (connection: Pick<SelfTraceHost, "run">) =>
  (batch: SelfTraceBatch): Promise<SendOutcome> =>
    connection
      .run((client) =>
        client["traces.ingestSelf"](batch).pipe(
          Effect.as<SendOutcome>("sent"),
          Effect.catchTags({
            SelfTraceRejected: (error) =>
              Effect.succeed<SendOutcome>(error.reason === "busy" ? "retry" : "dropped"),
            Unsupported: () => Effect.succeed<SendOutcome>("dropped"),
            RpcClientError: () => Effect.succeed<SendOutcome>("retry"),
          })
        )
      )
      .catch((): SendOutcome => "retry");
