/**
 * Closing a Table tab that has staged edits asks first (after the Editor's close dialog):
 * Cancel keeps the tab, "Discard and close" drops the edits with it. ↵ cancels.
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
import { closeDataTab, type DataSessionKey } from "../../../model/store.ts";
import type { DataTab, DataTabs } from "../../../model/tabs.ts";
import { changesLabel, countStaged } from "./staged.ts";
import { askClose, dropTab, editsOf, useClosing } from "./store.ts";

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
  const count = tab === undefined ? null : countStaged(editsOf(at, tab.id).staged);

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

/** The tab strip's close: a tab with staged edits asks first; others close now. */
export const requestCloseTab = (at: DataSessionKey, tabId: string) => {
  if (editsOf(at, tabId).staged.cells.size > 0) return askClose({ at, tabId });
  dropTab(at, tabId);
  closeDataTab(tabId, at);
};
