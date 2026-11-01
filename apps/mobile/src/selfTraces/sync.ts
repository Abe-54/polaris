/** Points the Tracer at the Polaris Workspace's Host as the Hosts' Developer Mode changes. */
import type { DeveloperMode } from "@polaris/protocol";
import {
  type SelfTraceHost,
  sendSelfTraces,
  traceTargetHost,
  watchDeveloperMode,
} from "./developerMode.ts";
import type { SelfTracer } from "./tracer.ts";

export const syncSelfTraces = (
  hosts: ReadonlyArray<SelfTraceHost>,
  tracer: Pick<SelfTracer, "setTarget" | "targetHostId">
): (() => void) => {
  const modes = new Map<string, DeveloperMode>();

  const retarget = () => {
    const hostId = traceTargetHost(modes);
    const host = hosts.find((h) => h.hostId === hostId);

    if (host === undefined) tracer.setTarget(null);
    else if (tracer.targetHostId() !== host.hostId)
      tracer.setTarget({ hostId: host.hostId, send: sendSelfTraces(host) });
  };

  const stops = hosts.map((host) =>
    watchDeveloperMode(host, (mode) => {
      if (mode === null) modes.delete(host.hostId);
      else modes.set(host.hostId, mode);
      retarget();
    })
  );

  return () => {
    for (const stop of stops) stop();
  };
};
