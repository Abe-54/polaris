/**
 * The composer's right-click menu (Paper M2): corrections for a misspelled word, Cut, Copy,
 * Paste and Select all with the standard chords, then Attach files…, which opens the file picker.
 */
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuEntries,
  ContextMenuTrigger,
  MENU_SEPARATOR_ENTRY,
  type MenuEntryInput,
} from "@polaris/ui";
import { type ReactNode, useRef, useState } from "react";
import { editShortcut } from "../../../shell/menu/index.ts";
import { polaris } from "../../bridge.ts";
import { type Misspelling, misspellingAt, replaceWord } from "./spelling.ts";

type EditAction = "cut" | "copy" | "paste" | "selectAll";

const MAX_SUGGESTIONS = 5;

const spellingEntries = (
  misspelling: Misspelling | null,
  replace: (word: string) => void
): ReadonlyArray<MenuEntryInput> => {
  if (misspelling === null) return [];

  const guesses = misspelling.suggestions.slice(0, MAX_SUGGESTIONS);

  const items: ReadonlyArray<MenuEntryInput> =
    guesses.length === 0
      ? [{ kind: "item", label: "No guesses found", disabled: true, onSelect: () => undefined }]
      : guesses.map((word) => ({
          kind: "item",
          label: word,
          testId: "spelling-suggestion",
          onSelect: () => replace(word),
        }));

  return [...items, MENU_SEPARATOR_ENTRY];
};

export const ComposerMenu = ({
  onFiles,
  children,
}: {
  /** Unset: the composer takes no files, and Attach files… is left out. */
  readonly onFiles: ((files: ReadonlyArray<File>) => void) | undefined;
  readonly children: ReactNode;
}) => {
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLElement | null>(null);
  const pending = useRef<EditAction | null>(null);
  const correction = useRef<string | null>(null);
  const [selected, setSelected] = useState(false);
  const [misspelling, setMisspelling] = useState<Misspelling | null>(null);

  // Run once the menu has closed and the field has its focus (and selection) back.
  const edit = (action: EditAction) => () => {
    pending.current = action;
  };

  const entries: ReadonlyArray<MenuEntryInput> = [
    ...spellingEntries(misspelling, (word) => {
      correction.current = word;
    }),
    {
      kind: "item",
      label: "Cut",
      shortcut: editShortcut("cut"),
      disabled: !selected,
      onSelect: edit("cut"),
    },
    {
      kind: "item",
      label: "Copy",
      shortcut: editShortcut("copy"),
      disabled: !selected,
      onSelect: edit("copy"),
    },
    { kind: "item", label: "Paste", shortcut: editShortcut("paste"), onSelect: edit("paste") },
    {
      kind: "item",
      label: "Select all",
      shortcut: editShortcut("selectAll"),
      onSelect: edit("selectAll"),
    },
    MENU_SEPARATOR_ENTRY,
    onFiles !== undefined && {
      kind: "item",
      label: "Attach files…",
      needsInput: true,
      onSelect: () => picker.current?.click(),
    },
  ];

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          asChild
          onContextMenu={(event) => {
            field.current =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>("[contenteditable], textarea")
                : null;
            setSelected((window.getSelection()?.toString() ?? "") !== "");
            const check = polaris().spelling?.suggestions;

            setMisspelling(
              field.current === null || check === undefined
                ? null
                : misspellingAt(event.clientX, event.clientY, check)
            );
          }}
        >
          <div className="contents">{children}</div>
        </ContextMenuTrigger>
        <ContextMenuContent
          data-testid="composer-menu"
          onCloseAutoFocus={(event) => {
            const action = pending.current;
            const word = correction.current;

            pending.current = null;
            correction.current = null;

            if (action === null && word === null) return;
            event.preventDefault();
            field.current?.focus();

            if (action !== null) void polaris().request("edit.run", { action });
            else if (word !== null && misspelling !== null) replaceWord(misspelling.range, word);
          }}
        >
          <ContextMenuEntries entries={entries} />
        </ContextMenuContent>
      </ContextMenu>
      {onFiles === undefined ? null : (
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          data-testid="attach-files-input"
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];

            event.currentTarget.value = "";

            if (files.length > 0) onFiles(files);
          }}
        />
      )}
    </>
  );
};
