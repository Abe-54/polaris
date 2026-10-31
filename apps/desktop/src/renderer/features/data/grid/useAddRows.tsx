/**
 * "Add n rows to agent session ⌘L" (DESIGN.md, Data): the rows go into the shown Agent Session's
 * draft, as Edit's ⌘L adds lines, and a toast says where they went. Nothing is sent. The block
 * keeps to the draft's limit: past it only the first rows go in, and the toast says how many.
 */
import { MAX_DRAFT_LENGTH } from "@polaris/protocol";
import { PixelCheckIcon, showToast } from "@polaris/ui";
import { useCallback } from "react";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { updateDraft, uiKey, useSessionUi } from "../../session/state.ts";
import type { DataSessionKey } from "../model/store.ts";
import { appendBlock, blockBudget, rowsBlock, rowsLabel, type RowsSource } from "./rows.ts";

/** What ⌘L would add: all the rows, the first `rows` of them, or none when the draft is full. */
export interface AddPlan {
  readonly rows: number;
  readonly of: number;
}

/** The rows that fit the shown session's draft, counted before anything is built. */
export const useAddPlan = (at: DataSessionKey, source: RowsSource | null): AddPlan => {
  const draft = useSessionUi(uiKey(at.hostKey, at.sessionId)).draft;

  if (source === null || source.rows.length === 0) return { rows: 0, of: 0 };

  return {
    rows: rowsBlock(source, blockBudget(draft, MAX_DRAFT_LENGTH)).rows,
    of: source.rows.length,
  };
};

/** The button's words: every row, the first n of them, or why none fit. */
export const addLabel = ({ rows, of }: AddPlan) => {
  if (of === 0) return "Add rows to agent session";

  if (rows === 0) return "Too long for the agent session's draft";

  return rows === of
    ? `Add ${rowsLabel(of)} to agent session`
    : `Add the first ${rowsLabel(rows)} of ${of.toLocaleString("en-US")} to agent session`;
};

export const useAddRows = (at: DataSessionKey) => {
  const { hostKey, sessionId } = at;
  const title = useApp((s) => s.hostModels[hostKey]?.sessions.get(sessionId)?.session.title);
  const { setMode, selectSession } = useShellActions();

  return useCallback(
    (source: RowsSource) => {
      if (source.rows.length === 0) return;
      let added = 0;

      updateDraft(hostKey, sessionId, (draft) => {
        const block = rowsBlock(source, blockBudget(draft, MAX_DRAFT_LENGTH));

        added = block.rows;

        return added === 0 ? draft : appendBlock(draft, block.text);
      });
      const name = title === undefined || title === "" ? "the agent session" : title;
      const all = added === source.rows.length;

      showToast({
        source: "starlight",
        icon: <PixelCheckIcon size={16} />,
        title:
          added === 0
            ? `No row fits in the draft in ${name}`
            : `Added ${all ? "" : "the first "}${rowsLabel(added)} to ${name}`,
        message: all
          ? "It's in the composer; nothing is sent yet."
          : `A draft holds ${MAX_DRAFT_LENGTH.toLocaleString("en-US")} characters, so ${(source.rows.length - added).toLocaleString("en-US")} selected rows were left out. Nothing is sent yet.`,
        action: {
          label: "Open session",
          onAction: () => {
            selectSession({ hostKey, sessionId });
            setMode("orchestrate");
          },
        },
      });
    },
    [hostKey, sessionId, title, setMode, selectSession]
  );
};
