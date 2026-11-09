/** Open this link? (DESIGN.md, Visualizations V5): a link in a frame never navigates; it asks. */
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@polaris/ui";
import { polaris } from "../../../bridge.ts";

export const LinkDialog = ({
  title,
  url,
  onClose,
}: {
  readonly title: string;
  /** An https URL (`messages.ts` drops anything else); null while closed. */
  readonly url: string | null;
  /** `opened` is true when the user chose to open it. */
  readonly onClose: (opened: boolean) => void;
}) => (
  <Dialog open={url !== null} onOpenChange={(open) => (open ? undefined : onClose(false))}>
    <DialogContent data-testid="visualization-link">
      <DialogHeader>
        <DialogTitle>Open this link?</DialogTitle>
        <DialogDescription>“{title}” wants to open a page in your browser.</DialogDescription>
      </DialogHeader>
      {url === null ? null : (
        <div className="bg-panel border-hairline mx-5 mb-4 flex flex-col gap-1 rounded-[8px] border px-3 py-2.5">
          <span className="text-text-strong font-mono text-[13px] leading-[18px] font-medium">
            {new URL(url).host}
          </span>
          <span className="text-text-subtle font-mono text-[12px] leading-4 break-all">{url}</span>
        </div>
      )}
      <DialogFooter>
        <Button variant="ghost" autoFocus onClick={() => onClose(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            if (url !== null) void polaris().request("shell.openExternal", { url });
            onClose(true);
          }}
        >
          Open in browser
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
