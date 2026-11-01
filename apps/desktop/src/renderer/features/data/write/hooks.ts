/** A write's run in the Query Log, watched only once it was allowed: running, ran or failed. */
import type { QueryLogEntry } from "@polaris/protocol";
import { useQueryLog } from "../data/hooks.tsx";
import type { DataSessionKey } from "../model/store.ts";
import { type DataWrite, writeEntry } from "./model.ts";

export const useWriteEntry = (
  at: DataSessionKey,
  write: DataWrite,
  watching: boolean
): QueryLogEntry | undefined => {
  const log = useQueryLog(at, watching);

  return watching && log.status === "ready" ? writeEntry(log.value, write) : undefined;
};
