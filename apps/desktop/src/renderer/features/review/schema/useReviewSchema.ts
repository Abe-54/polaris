/**
 * An Agent Session's Review reads its Schema Diff: the Turn picked (or the whole session),
 * refetched as Turns end, and "Open in Data" on the session's own Data tabs.
 */
import { SCHEMA_DIFF_CAPABILITY, type SessionId } from "@polaris/protocol";
import { useCallback, useMemo } from "react";
import type { HostView } from "../../../../shared/api.ts";
import { useShellActions } from "../../../shell/hooks.ts";
import type { TurnView } from "../../../store/sessionModel.ts";
import { openTable } from "../../data/index.ts";
import { hasCapability } from "../../session/hooks.ts";
import type { ReviewTurn, TurnPick } from "../data/source.ts";
import { shownSources } from "./model.ts";
import type { ReviewSchema } from "./section.ts";
import { useSchemaDiff } from "./useSchemaDiff.ts";

export interface ReviewSchemaInput {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly host: HostView | undefined;
  readonly turns: ReadonlyArray<ReviewTurn>;
  readonly pick: TurnPick;
  readonly views: ReadonlyArray<TurnView>;
}

/** What the comparison spans, as the body's caption says it. */
export const schemaScope = (turns: ReadonlyArray<ReviewTurn>, pick: TurnPick) => {
  if (pick.kind === "all") return "Across this session";
  const turn = turns.find((t) => t.id === pick.turnId);

  return turn === undefined ? "Start → end of the turn" : `Start → end of turn ${turn.number}`;
};

export const useReviewSchema = ({
  hostKey,
  sessionId,
  host,
  turns,
  pick,
  views,
}: ReviewSchemaInput): ReviewSchema | null => {
  const actions = useShellActions();
  const supported = hasCapability(host, SCHEMA_DIFF_CAPABILITY);
  const ended = views.filter((v) => v.turn.status !== "working").length;

  const diff = useSchemaDiff({
    hostKey,
    sessionId,
    turn: pick.kind === "turn" ? pick.turnId : undefined,
    supported,
    ended,
  });

  const onOpenTable = useCallback<ReviewSchema["onOpenTable"]>(
    (source, table) => {
      openTable(source.source.name, table, { hostKey, sessionId });
      actions.selectSession({ hostKey, sessionId });
      actions.setMode("data");
    },
    [actions, hostKey, sessionId]
  );

  const sources = useMemo(() => shownSources(diff), [diff]);
  const scope = schemaScope(turns, pick);

  return useMemo(
    () => (diff === null ? null : { sources, scope, onOpenTable }),
    [diff, sources, scope, onOpenTable]
  );
};
