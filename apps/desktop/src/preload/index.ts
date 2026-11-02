/**
 * The preload script: exposes the typed `PolarisApi` as `window.polaris`
 * through `contextBridge`. Sandboxed, so it may require nothing but `electron`.
 * One IPC listener demultiplexes every subscription's batched items.
 */
import { contextBridge, ipcRenderer } from "electron";
import { createLanguageApi } from "./languages.ts";
import { platformFromArgv } from "../shared/platform.ts";
import {
  type BatchEntry,
  CHANNELS,
  type AppEvent,
  type PolarisApi,
  type SubscriptionListener,
} from "../shared/api.ts";

import { lockFrameWebRTC } from "./lockdown.ts";

function exposePolarisApi() {
  const listeners = new Map<number, SubscriptionListener<unknown>>();

  let nextId = 1;

  /** One listener's failure must not stop the rest of the batch from being delivered. */
  const deliver = (run: () => void) => {
    try {
      run();
    } catch (cause) {
      console.error("polaris: a subscription listener threw", cause);
    }
  };

  ipcRenderer.on(CHANNELS.batch, (_event, entries: ReadonlyArray<BatchEntry>) => {
    for (const entry of entries) {
      const listener = listeners.get(entry.id);

      if (listener === undefined) continue;

      if (entry.items.length > 0) deliver(() => listener.items(entry.items));

      if (entry.end !== undefined) {
        listeners.delete(entry.id);
        const end = entry.end;

        deliver(() => listener.end?.(end));
      }
    }
  });

  const api: PolarisApi = {
    platform: platformFromArgv(process.argv, process.platform),
    languages: createLanguageApi(),
    notify: (method, input) => ipcRenderer.send(method, input),
    request: (method, input, options) =>
      ipcRenderer.invoke(
        CHANNELS.request,
        options?.trace === undefined ? { method, input } : { method, input, trace: options.trace }
      ),
    selfSpans: (spans) => ipcRenderer.send(CHANNELS.selfSpans, spans),
    reportCrash: (report) => ipcRenderer.send(CHANNELS.crash, report),
    subscribe: (kind, input, listener) => {
      const id = nextId++;

      // SAFETY: the main process only sends items of `kind` under this id (see main/ipc/subscriptions.ts).
      listeners.set(id, listener as SubscriptionListener<unknown>);
      ipcRenderer.send(CHANNELS.subscribe, { id, kind, input });

      return () => {
        if (!listeners.delete(id)) return;
        ipcRenderer.send(CHANNELS.unsubscribe, { id });
      };
    },
    onAppEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, event: AppEvent) => listener(event);

      ipcRenderer.on(CHANNELS.app, handler);

      return () => {
        ipcRenderer.off(CHANNELS.app, handler);
      };
    },
  };

  contextBridge.exposeInMainWorld("polaris", api);
}

lockFrameWebRTC();

if (process.isMainFrame) exposePolarisApi();
