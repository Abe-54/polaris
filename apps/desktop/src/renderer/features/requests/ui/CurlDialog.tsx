/** "Paste a curl command": the command in a field, opened as a new Request (requests.curl.parse). */
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Kbd,
  Textarea,
} from "@polaris/ui";
import { useState } from "react";
import { shortcutLabel } from "../../../../shared/chord.ts";
import { FIELD_CHORDS } from "../../../../shared/keymap.ts";

export const CurlDialog = ({
  open,
  onOpenChange,
  onImport,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onImport: (text: string) => void;
}) => {
  const [text, setText] = useState("");

  const submit = () => {
    if (text.trim() === "") return;
    onImport(text);
    setText("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[560px]" data-testid="requests-curl-dialog">
        <DialogHeader>
          <DialogTitle>Paste a curl command</DialogTitle>
          <DialogDescription>
            It opens as a new request in http/requests.http; nothing is saved until you save it.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="curl command"
          autoFocus
          value={text}
          spellCheck={false}
          placeholder="curl -X POST https://localhost:4000/invoices -H 'Content-Type: application/json'"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
          className="text-caption h-32 font-mono"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={text.trim() === ""} onClick={submit}>
            Open as request
            <Kbd variant="plain">{shortcutLabel(FIELD_CHORDS.submit)}</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
