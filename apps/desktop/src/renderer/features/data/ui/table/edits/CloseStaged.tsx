/**
 * Closing a Table tab that has staged edits asks first (after the Editor's close dialog):
 * Cancel keeps the tab, "Discard and close" drops the edits with it. ↵ cancels. While a commit
 * is on its way the dialog says "Committing…" and waits: the tab closes once it lands.
 */
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@polaris/ui";
import { useEffect } from "react";
import { closeDataTab, type DataSessionKey } from "../../../model/store.ts";
import type { DataTab, DataTabs } from "../../../model/tabs.ts";
import { changesLabel, countStaged } from "./staged.ts";
import { askClose, dropTab, editsOf, NO_EDITS, useClosing, useTabEdits } from "./store.ts";

export interface CloseStagedProps {
  readonly at: DataSessionKey;
  readonly tabs: DataTabs;
  readonly titleOf: (tab: DataTab) => string;
}

export const CloseStaged = ({ at, tabs, titleOf }: CloseStagedProps) => {
  const closing = useClosing();

  const mine =
    closing !== null && closing.at.sessionId === at.sessionId && closing.at.hostKey === at.hostKey;

  const tab = mine ? tabs.tabs.find((t) => t.id === closing.tabId) : undefined;
  const edits = useTabEdits(at, tab?.id ?? "");
  const { staged, commit } = tab === undefined ? NO_EDITS : edits;
  const committing = commit.status === "committing";
  const count = tab === undefined ? null : countStaged(staged);
  const tabId = tab?.id;

  // The commit landed with nothing left staged: the tab closes, as asked.
  useEffect(() => {
    if (tabId === undefined || committing || staged.cells.size > 0) return;
    dropTab(at, tabId);
    closeDataTab(tabId, at);
  }, [at, tabId, committing, staged]);

  if (committing && tab !== undefined)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) askClose(null);
        }}
      >
        <DialogContent data-testid="data-close-staged" data-committing="true">
          <DialogHeader>
            <DialogTitle>Committing changes to {titleOf(tab)}…</DialogTitle>
            <DialogDescription>
              The tab closes when the commit lands. If it fails, the changes stay staged here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" autoFocus onClick={() => askClose(null)}>
              Keep the tab open
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

  return (
    <Dialog
      open={tab !== undefined}
      onOpenChange={(open) => {
        if (!open) askClose(null);
      }}
    >
      <DialogContent data-testid="data-close-staged">
        <DialogHeader>
          <DialogTitle>
            Discard staged changes to {tab === undefined ? "this table" : titleOf(tab)}?
          </DialogTitle>
          <DialogDescription>
            {count === null ? "" : `${changesLabel(count)} aren't committed. `}Closing the tab
            discards them.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" autoFocus onClick={() => askClose(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            data-testid="data-close-discard"
            onClick={() => {
              if (tab === undefined) return;
              dropTab(at, tab.id);
              closeDataTab(tab.id, at);
            }}
          >
            Discard and close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** The tab strip's close: a tab with staged edits or a commit on its way asks first. */
export const requestCloseTab = (at: DataSessionKey, tabId: string) => {
  const { staged, commit } = editsOf(at, tabId);

  if (staged.cells.size > 0 || commit.status === "committing") return askClose({ at, tabId });
  dropTab(at, tabId);
  closeDataTab(tabId, at);
};
