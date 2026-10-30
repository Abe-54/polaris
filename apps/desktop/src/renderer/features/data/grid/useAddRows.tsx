/**
 * "Add n rows to agent session ⌘L" (DESIGN.md, Data): the rows go into the shown Agent Session's
 * draft, as Edit's ⌘L adds lines, and a toast says where they went. Nothing is sent.
 */
import { PixelCheckIcon, showToast } from "@polaris/ui";
import { useCallback } from "react";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { updateDraft } from "../../session/index.ts";
import type { DataSessionKey } from "../model/store.ts";
import { appendBlock, rowsBlock, rowsLabel, type RowsSource } from "./rows.ts";

export const useAddRows = (at: DataSessionKey) => {
  const { hostKey, sessionId } = at;
  const title = useApp((s) => s.hostModels[hostKey]?.sessions.get(sessionId)?.session.title);
  const { setMode, selectSession } = useShellActions();

  return useCallback(
    (source: RowsSource) => {
      if (source.rows.length === 0) return;
      const block = rowsBlock(source);

      updateDraft(hostKey, sessionId, (draft) => appendBlock(draft, block));
      showToast({
        source: "starlight",
        icon: <PixelCheckIcon size={16} />,
        title: `Added ${rowsLabel(source.rows.length)} to ${title === undefined || title === "" ? "the agent session" : title}`,
        message: "It's in the composer; nothing is sent yet.",
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
