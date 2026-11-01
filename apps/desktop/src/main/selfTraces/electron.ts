/** Connects the Desktop App's Self-Traces to the Client runtime and to every window. */
import { BrowserWindow } from "electron";
import { type AppEvent, CHANNELS } from "../../shared/api.ts";
import type { ClientRuntime } from "../hosts.ts";
import type { DesktopSelfTraces } from "./index.ts";
import { ingestOn } from "./send.ts";

/** Sends batches through the runtime and tells each window when Self-Traces turn on or off. */
export const connectSelfTraces = (selfTraces: DesktopSelfTraces, runtime: ClientRuntime) => {
  selfTraces.bind((hostKey, batch) => runtime.runPromise(ingestOn(hostKey, batch)));

  return selfTraces.onChange((enabled) => {
    const event: AppEvent = { kind: "self-traces", enabled };

    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANNELS.app, event);
  });
};
