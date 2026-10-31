import { useSettings } from "../../settings/index.ts";
import type { Entry } from "../model/runs.ts";
import { replyStatsLine } from "../model/replyStats.ts";

/** The advanced view's quiet line under a finished reply (ENG-678); nothing when it is off. */
export const ReplyStatsLine = ({ entry }: { readonly entry: Entry }) => {
  const on = useSettings((s) => s.sessions.advancedView);

  if (!on || entry.kind !== "item" || entry.item.kind !== "message") return null;
  const { stats, live } = entry.item;

  return live || stats === undefined || stats === null ? null : (
    <span className="text-caption text-text-subtle tabular mt-1" data-testid="reply-stats">
      {replyStatsLine(stats)}
    </span>
  );
};
