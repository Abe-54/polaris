/** "Open in Data" on a write or schema change; ⌘4 only switches to Data, so it is in the tooltip. */
import { Button } from "@polaris/ui";
import { menuShortcut } from "../../../shell/menu/index.ts";

export const OpenInData = ({ onOpen }: { readonly onOpen: () => void }) => {
  const shortcut = menuShortcut("view.data");

  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onOpen}
      title={shortcut === undefined ? undefined : `Data ${shortcut}`}
      data-testid="data-output-open"
    >
      Open in Data
    </Button>
  );
};
