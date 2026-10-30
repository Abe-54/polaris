/**
 * Wires the typed bridge into Electron: `request` through `ipcMain.handle`,
 * subscriptions per window. Only frames loaded from the app's own origin may
 * call in.
 */
import { ipcMain, type WebContents, type WebFrameMain } from "electron";
import { Cause, Effect, Exit, flow, Option, Schema } from "effect";
import { CHANNELS, type IpcError, type Result } from "../../shared/api.ts";
import type { ClientRuntime } from "../hosts.ts";
import { RequestEnvelope, SubscribeEnvelope, UnsubscribeEnvelope } from "../../shared/contract.ts";
import {
  isRequestMethod,
  type RequestContext,
  requestHandlers,
  requestRunner,
} from "./requests.ts";
import { windowSubscriptions, type WindowSubscriptions } from "./subscriptions.ts";
import { PredictionNotifications } from "../../shared/predictionOutcomes.ts";

export interface IpcInput {
  readonly runtime: ClientRuntime;
  readonly context: RequestContext;
  /** Whether a frame's URL belongs to the app (the `app://` origin, or the dev server). */
  readonly trusted: (url: string) => boolean;
}

const decodeRequest = flow(
  Schema.decodeUnknownEffect(RequestEnvelope),
  Effect.mapError((error): IpcError => ({ code: "InvalidInput", message: error.message }))
);

const decodeSubscribe = Schema.decodeUnknownOption(SubscribeEnvelope);

const decodeUnsubscribe = Schema.decodeUnknownOption(UnsubscribeEnvelope);

const rejected = (message: string): Result<never> => ({
  ok: false,
  error: { code: "Forbidden", message },
});

const senderTrusted = (frame: WebFrameMain | null, trusted: IpcInput["trusted"]) =>
  frame !== null && trusted(frame.url);

export const registerIpc = ({ runtime, context, trusted }: IpcInput) => {
  const handlers = requestHandlers(context);
  const windows = new Map<number, WindowSubscriptions>();

  ipcMain.on(CHANNELS.predictionOutcome, (event, message) => {
    if (!senderTrusted(event.senderFrame, trusted)) return;
    Option.map(
      Schema.decodeUnknownOption(PredictionNotifications["prediction.outcome"])(message),
      (record) => context.predictionOutcomes?.record(record)
    );
  });
  ipcMain.on(CHANNELS.predictionKeystrokes, (event, message) => {
    if (!senderTrusted(event.senderFrame, trusted)) return;
    Option.map(
      Schema.decodeUnknownOption(PredictionNotifications["prediction.keystrokes"])(message),
      (record) => context.predictionOutcomes?.keystrokes(record)
    );
  });

  const subscriptionsOf = (sender: WebContents) => {
    let subs = windows.get(sender.id);

    if (subs === undefined) {
      subs = windowSubscriptions({
        runtime,
        prediction: context.predictionBridge,
        browser: context.browser,
        target: {
          isDestroyed: () => sender.isDestroyed(),
          send: (channel, entries) => sender.send(channel, entries),
        },
      });
      windows.set(sender.id, subs);
      sender.once("destroyed", () => {
        windows.get(sender.id)?.dispose();
        windows.delete(sender.id);
      });
      // A reload drops the renderer's listeners; its old subscriptions must go too.
      sender.on("did-start-navigation", (details) => {
        if (!details.isMainFrame || details.isSameDocument) return;
        windows.get(sender.id)?.dispose();
        windows.delete(sender.id);
      });
    }

    return subs;
  };

  ipcMain.handle(CHANNELS.request, async (event, message): Promise<Result<unknown>> => {
    if (!senderTrusted(event.senderFrame, trusted)) return rejected("untrusted sender");

    const exit = await runtime.runPromiseExit(
      Effect.flatMap(decodeRequest(message), ({ method, input }) =>
        isRequestMethod(method)
          ? requestRunner(handlers, method)(input)
          : Effect.fail<IpcError>({ code: "UnknownMethod", message: `no method "${method}"` })
      )
    );

    return Exit.match(exit, {
      onSuccess: (value) => ({ ok: true, value }),
      onFailure: (cause): Result<never> => ({
        ok: false,
        error: Option.getOrElse(Cause.findErrorOption(cause), (): IpcError => ({
          code: "Defect",
          message: Cause.pretty(cause),
        })),
      }),
    });
  });

  ipcMain.on(CHANNELS.subscribe, (event, message) => {
    if (!senderTrusted(event.senderFrame, trusted)) return;

    Option.map(decodeSubscribe(message), subscriptionsOf(event.sender).subscribe);
  });

  ipcMain.on(CHANNELS.unsubscribe, (event, message) => {
    Option.map(decodeUnsubscribe(message), ({ id }) =>
      windows.get(event.sender.id)?.unsubscribe(id)
    );
  });

  return {
    dispose: () => {
      for (const subs of windows.values()) subs.dispose();
      windows.clear();
      void context.predictionBridge?.dispose();
      ipcMain.removeHandler(CHANNELS.request);
      ipcMain.removeAllListeners(CHANNELS.subscribe);
      ipcMain.removeAllListeners(CHANNELS.unsubscribe);
      ipcMain.removeAllListeners(CHANNELS.predictionOutcome);
      ipcMain.removeAllListeners(CHANNELS.predictionKeystrokes);
    },
  };
};
