/**
 * Fetches an Agent Session's Schema Diff (`data.schemaDiff`) when its Review opens, when the
 * Turn picked changes and when a Turn ends; never on a timer. Null while there is nothing to
 * show: before the first answer, on a Daemon without the capability, or when it failed.
 */
import { type DataSchemaDiff, type SessionId, TurnId } from "@polaris/protocol";
import { useEffect, useState } from "react";
import { useDataApi } from "../../data/index.ts";

export interface SchemaDiffQuery {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  /** One Turn's diff; the whole session's when undefined. */
  readonly turn: TurnId | undefined;
  /** `turn`'s group, `turn` first: the diff spans them all (ENG-672). */
  readonly turns?: ReadonlyArray<TurnId> | undefined;
  /** The Host has `data.schemaDiff`; nothing is fetched without it. */
  readonly supported: boolean;
  /** Turns that have ended: a new one fetches again. */
  readonly ended: number;
}

export const useSchemaDiff = ({
  hostKey,
  sessionId,
  turn,
  turns,
  supported,
  ended,
}: SchemaDiffQuery): DataSchemaDiff | null => {
  const api = useDataApi();

  const [diff, setDiff] = useState<{ readonly key: string; readonly value: DataSchemaDiff } | null>(
    null
  );

  const group = turns?.join("\u0000") ?? "";
  const key = `${hostKey}\u0000${sessionId}\u0000${turn ?? ""}\u0000${group}`;

  useEffect(() => {
    if (!supported) return undefined;
    let live = true;

    const span = group === "" ? undefined : group.split("\u0000").map((id) => TurnId.make(id));

    void api.schemaDiff({ hostKey, sessionId }, turn, span).then((result) => {
      if (!live) return;

      // A failure keeps what was shown for this key; Unsupported never had anything.
      if (result.ok) setDiff({ key, value: result.value });
    });

    return () => {
      live = false;
    };
  }, [api, hostKey, sessionId, turn, group, supported, ended, key]);

  return supported && diff?.key === key ? diff.value : null;
};
