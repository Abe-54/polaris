/**
 * The Turn's data for Output, from the session's Query Log, approvals and Schema Diff; null on a
 * Daemon without the data capability, where nothing is watched or fetched.
 */
import {
  DATA_CAPABILITY,
  SCHEMA_DIFF_CAPABILITY,
  type SessionId,
  type TurnId,
} from "@polaris/protocol";
import { useMemo } from "react";
import type { HostView } from "../../../../shared/api.ts";
import type { SessionModel } from "../../../store/sessionModel.ts";
import { shownSources } from "../../review/schema/model.ts";
import { useSchemaDiff } from "../../review/schema/useSchemaDiff.ts";
import { hasCapability } from "../../session/hooks.ts";
import { useQueryLog } from "../data/hooks.tsx";
import { type TurnData, turnData } from "./model.ts";

export interface TurnDataQuery {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly host: HostView | undefined;
  readonly model: SessionModel;
  /** The Turns Output shows, the opening one first; empty before the first Turn. */
  readonly turnIds: ReadonlyArray<TurnId>;
}

export const useTurnData = ({
  hostKey,
  sessionId,
  host,
  model,
  turnIds,
}: TurnDataQuery): TurnData | null => {
  const supported = hasCapability(host, DATA_CAPABILITY);
  const log = useQueryLog({ hostKey, sessionId }, supported && turnIds.length > 0);
  const ended = model.turns.filter((v) => v.turn.status !== "working").length;

  const diff = useSchemaDiff({
    hostKey,
    sessionId,
    turn: turnIds[0],
    turns: turnIds,
    supported: supported && hasCapability(host, SCHEMA_DIFF_CAPABILITY) && turnIds.length > 0,
    ended,
  });

  const entries = log.status === "ready" ? log.value : null;
  const key = turnIds.join("\u0000");

  return useMemo(
    () =>
      !supported || entries === null
        ? null
        : turnData({
            entries,
            sessionId,
            turnIds: new Set(key.split("\u0000")),
            pending: model.pendingApprovals,
            settled: model.settledWrites ?? [],
            schema: shownSources(diff),
          }),
    [supported, entries, sessionId, key, model.pendingApprovals, model.settledWrites, diff]
  );
};
