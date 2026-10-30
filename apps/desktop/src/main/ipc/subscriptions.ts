/**
 * One window's open subscriptions: each runs its feed on the Client runtime and
 * pushes items into the window's batcher. Closing the window interrupts them all.
 */
import { Cause, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { EditPredictionInput, PredictionCompletionInput } from "../../shared/predictionContract.ts";
import type { PredictionBridge } from "../prediction/bridge.ts";
import type { Registry as Browsers } from "../browser/registry.ts";
import { CHANNELS, type BatchEntry, type IpcError } from "../../shared/api.ts";
import type { ClientRuntime } from "../hosts.ts";
import { newBatcher } from "./batcher.ts";
import type { SubscribeEnvelope } from "../../shared/contract.ts";
import { feedOpener, isSubscriptionKind } from "./feeds.ts";

export interface WindowTarget {
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, entries: ReadonlyArray<BatchEntry>) => void;
}

export interface WindowSubscriptions {
  readonly subscribe: (envelope: SubscribeEnvelope) => void;
  readonly unsubscribe: (id: number) => void;
  readonly dispose: () => void;
}

export interface WindowSubscriptionsInput {
  readonly prediction?: PredictionBridge | undefined;
  readonly browser?: Browsers | undefined;
  readonly runtime: ClientRuntime;
  readonly target: WindowTarget;
}

const endError = (exit: Exit.Exit<void, IpcError>): IpcError | null =>
  Exit.match(exit, {
    onSuccess: () => null,
    onFailure: (cause) =>
      Option.getOrElse(Cause.findErrorOption(cause), () => ({
        code: "Defect",
        message: Cause.pretty(cause),
      })),
  });

export const windowSubscriptions = ({
  prediction,
  browser,
  runtime,
  target,
}: WindowSubscriptionsInput): WindowSubscriptions => {
  const fibers = new Map<number, Fiber.Fiber<void, IpcError>>();
  const workspaces = new Map<string, { hostKey: string; workspaceId: string }>();

  const batcher = newBatcher({
    send: (entries) => {
      if (!target.isDestroyed()) target.send(CHANNELS.batch, entries);
    },
  });

  const subscribe = ({ id, kind, input }: SubscribeEnvelope) => {
    if (fibers.has(id)) return;

    if (!isSubscriptionKind(kind)) {
      batcher.end(id, { code: "UnknownSubscription", message: `no subscription "${kind}"` });

      return;
    }

    if (kind === "prediction.complete" || kind === "prediction.edit")
      Option.map(
        Schema.decodeUnknownOption(
          kind === "prediction.edit" ? EditPredictionInput : PredictionCompletionInput
        )(input),
        (value) => {
          workspaces.set(JSON.stringify([value.hostKey, value.workspaceId]), {
            hostKey: value.hostKey,
            workspaceId: value.workspaceId,
          });
        }
      );

    const fiber = runtime.runFork(
      feedOpener(
        kind,
        prediction,
        browser
      )(input).pipe(Stream.runForEach((item) => Effect.sync(() => batcher.push(id, item))))
    );

    fibers.set(id, fiber);
    fiber.addObserver((exit) => {
      fibers.delete(id);

      if (!Exit.hasInterrupts(exit)) batcher.end(id, endError(exit));
    });
  };

  return {
    subscribe,
    unsubscribe: (id) => {
      const fiber = fibers.get(id);

      if (fiber === undefined) return;
      fibers.delete(id);
      runtime.runFork(Fiber.interrupt(fiber));
    },
    dispose: () => {
      for (const { hostKey, workspaceId } of workspaces.values())
        prediction?.release(hostKey, workspaceId);
      workspaces.clear();
      batcher.dispose();
      runtime.runFork(Fiber.interruptAll([...fibers.values()]));
      fibers.clear();
    },
  };
};
