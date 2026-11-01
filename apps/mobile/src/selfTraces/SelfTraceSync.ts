/** Mounted under HostsProvider: keeps the app's Tracer on the Hosts it has now. */
import { useEffect } from "react";
import { useHosts } from "../runtime/hosts.tsx";
import { selfTracer } from "./index.ts";
import { syncSelfTraces } from "./sync.ts";

export const SelfTraceSync = (): null => {
  const hosts = useHosts();

  useEffect(() => syncSelfTraces(hosts, selfTracer), [hosts]);

  return null;
};
