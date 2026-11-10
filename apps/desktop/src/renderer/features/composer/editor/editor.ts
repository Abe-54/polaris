/**
 * The composer's Lexical editor on its core API: plain text, undo, chips, the
 * keys, and ↑/↓ through sent messages. React only mounts it (`../ui/PromptEditor.tsx`); every handler
 * reads the latest callbacks through `hooks()`, so nothing re-registers on render.
 */
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { registerPlainText } from "@lexical/plain-text";
import { mergeRegister } from "@lexical/utils";
import {
  $getRoot,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_NORMAL,
  COPY_COMMAND,
  createEditor,
  CUT_COMMAND,
  DROP_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  PASTE_COMMAND,
  SELECTION_CHANGE_COMMAND,
  $getSelection,
  $isRangeSelection,
  CLEAR_HISTORY_COMMAND,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  SKIP_DOM_SELECTION_TAG,
} from "lexical";
import type { CommandOption, Draft } from "../model/commands.ts";
import type { MentionRow } from "../model/mentions.ts";
import { CommandNode } from "./node.ts";
import { $onEdgeLine, onEdgeRow, type Toward } from "./lines.ts";
import { $caretAcrossChip, $followDomCaret, $selectionText, $snapOutOfChip } from "./selection.ts";
import {
  $insertChip,
  $insertMention,
  $readDraft,
  $readTypedWord,
  $replaceTypedWord,
  $retokenize,
  $setText,
  registerChips,
  type TypedWord,
} from "./state.ts";

export interface EditorHooks {
  readonly options: () => ReadonlyArray<CommandOption>;
  readonly onDraft: (draft: Draft) => void;
  readonly onTypedWord: (word: TypedWord | null) => void;
  /** While the menu is open it owns ↑ ↓ ⇥ ↵ and esc. */
  readonly menu: {
    readonly open: () => boolean;
    readonly move: (by: 1 | -1) => void;
    /** ⇥ on a folder in the `@` picker goes into it; otherwise both pick. */
    readonly pick: (via: "enter" | "tab") => void;
    readonly dismiss: () => void;
  };
  /** The Suggested Reply in the empty prompt: ⇥ accepts it and esc dismisses it, after the menu. */
  readonly suggestion: {
    readonly shown: () => boolean;
    readonly accept: () => void;
    readonly dismiss: () => void;
  };
  /** ↑/↓ with the caret on the first or last line: the sent message to show, or null. */
  readonly recall: (toward: Toward) => string | null;
  /** ↵ sends; with ⌘ or Ctrl, `queue` is true. */
  readonly onSubmit: (queue: boolean) => void;
  /** esc outside the menu; true when it did something (stopped the Turn). */
  readonly onEscape: () => boolean;
  /** Whether pasted or dropped files go to attachments, so their names aren't typed in. */
  readonly takesFiles: () => boolean;
}

/** Undo groups keystrokes this close together, as a textarea does. */
const HISTORY_DELAY_MS = 300;

const hasFiles = (data: DataTransfer | null) => data !== null && data.types.includes("Files");

export interface PromptEditor {
  readonly editor: LexicalEditor;
  readonly mount: (root: HTMLElement) => () => void;
  readonly setText: (text: string) => void;
  readonly insertChip: (option: CommandOption) => void;
  readonly insertMention: (row: MentionRow) => void;
  /** Swaps the typed word for `text`, the caret after it (⇥ into a folder). */
  readonly replaceTypedWord: (text: string) => void;
  readonly removeTypedWord: () => void;
  /** Types `text` into the empty prompt as one undoable edit, the caret after it. */
  readonly insertWhole: (text: string) => void;
  readonly retokenize: () => void;
  /** Focuses now with the caret after the draft, typing `text` there first. */
  readonly focusEnd: (text?: string) => void;
  /** The word under the caret and the draft, as the editor stands now. */
  readonly read: () => { readonly typed: TypedWord | null; readonly draft: Draft };
}

/** The keys: the menu's first while it is open, then ↵ to send and esc to stop. */
const registerKeys = (editor: LexicalEditor, hooks: () => EditorHooks) => {
  const whileMenu = (run: (h: EditorHooks) => void) => (event: KeyboardEvent | null) => {
    const h = hooks();

    if (event?.isComposing || !h.menu.open()) return false;
    event?.preventDefault();
    run(h);

    return true;
  };

  const across = (direction: "left" | "right") => (event: KeyboardEvent) => {
    if (!$caretAcrossChip(direction, event.shiftKey)) return false;
    event.preventDefault();

    return true;
  };

  // After the menu's ↑ ↓: history only where the caret can't move up or down a line.
  const recall = (toward: Toward) => (event: KeyboardEvent | null) => {
    if (event === null || event.isComposing) return false;

    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
    const root = editor.getRootElement();

    if (!$onEdgeLine(toward) || (root !== null && !onEdgeRow(root, toward))) return false;
    const text = hooks().recall(toward);

    if (text === null) return false;
    event.preventDefault();
    $setText(text, true);

    return true;
  };

  const high = COMMAND_PRIORITY_HIGH;

  return mergeRegister(
    // First on every key: the commands below act on the caret the user sees.
    editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        if (!event.isComposing) $followDomCaret(editor);

        return false;
      },
      COMMAND_PRIORITY_CRITICAL
    ),
    editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      whileMenu((h) => h.menu.move(1)),
      high
    ),
    editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      whileMenu((h) => h.menu.move(-1)),
      high
    ),
    editor.registerCommand(
      KEY_TAB_COMMAND,
      whileMenu((h) => h.menu.pick("tab")),
      high
    ),
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      whileMenu((h) => h.menu.pick("enter")),
      high
    ),
    editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        const h = hooks();

        if (event.isComposing || event.shiftKey || !h.suggestion.shown()) return false;
        event.preventDefault();
        // Outside this key's update, so the insert gets its own undo entry.
        queueMicrotask(h.suggestion.accept);

        return true;
      },
      COMMAND_PRIORITY_NORMAL
    ),
    editor.registerCommand(KEY_ARROW_UP_COMMAND, recall(-1), COMMAND_PRIORITY_NORMAL),
    editor.registerCommand(KEY_ARROW_DOWN_COMMAND, recall(1), COMMAND_PRIORITY_NORMAL),
    editor.registerCommand(KEY_ARROW_LEFT_COMMAND, across("left"), high),
    editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, across("right"), high),
    editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        const h = hooks();

        if (event.isComposing) return false;

        if (h.menu.open()) h.menu.dismiss();
        else if (h.suggestion.shown()) h.suggestion.dismiss();
        else if (!h.onEscape()) return false;
        event.preventDefault();

        return true;
      },
      high
    ),
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event === null || event.isComposing || event.shiftKey) return false;
        event.preventDefault();
        hooks().onSubmit(event.metaKey || event.ctrlKey);

        return true;
      },
      COMMAND_PRIORITY_NORMAL
    )
  );
};

/** Copy and cut keep a chip's sigil; a selection without chips is Lexical's to copy. */
const copyWithSigils = (cut: boolean) => (event: ClipboardEvent | KeyboardEvent | null) => {
  if (!(event instanceof ClipboardEvent) || event.clipboardData === null) return false;
  const text = $selectionText();

  if (text === null) return false;
  event.preventDefault();
  event.clipboardData.setData("text/plain", text);
  const selection = $getSelection();

  if (cut && $isRangeSelection(selection)) selection.removeText();

  return true;
};

export const createPromptEditor = (hooks: () => EditorHooks, label: string): PromptEditor => {
  const editor = createEditor({
    namespace: "polaris-composer",
    nodes: [CommandNode],
    onError: (error) => {
      throw error;
    },
  });

  const register = () => {
    const files = (data: DataTransfer | null) => hasFiles(data) && hooks().takesFiles();

    return mergeRegister(
      registerPlainText(editor),
      registerHistory(editor, createEmptyHistoryState(), HISTORY_DELAY_MS),
      registerChips(editor, () => hooks().options()),
      registerKeys(editor, hooks),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          $snapOutOfChip();

          return false;
        },
        COMMAND_PRIORITY_LOW
      ),
      editor.registerCommand(COPY_COMMAND, copyWithSigils(false), COMMAND_PRIORITY_LOW),
      editor.registerCommand(CUT_COMMAND, copyWithSigils(true), COMMAND_PRIORITY_LOW),
      // The attachments wrapper takes the files as the event bubbles; only keep Lexical from typing names.
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!(event instanceof ClipboardEvent) || !files(event.clipboardData)) return false;
          event.preventDefault();

          return true;
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        DROP_COMMAND,
        (event) => {
          if (!files(event.dataTransfer)) return false;
          event.preventDefault();

          return true;
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
        const typed = editorState.read($readTypedWord);

        hooks().onTypedWord(typed);

        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
        hooks().onDraft(editorState.read($readDraft));
      })
    );
  };

  return {
    editor,
    mount: (root) => {
      root.setAttribute("aria-label", label);
      editor.setRootElement(root);
      const unregister = register();

      return () => {
        unregister();
        editor.setRootElement(null);
      };
    },
    setText: (text) => {
      const root = editor.getRootElement();
      const focused = root !== null && root.contains(document.activeElement);

      // A hidden session's composer must not take focus; nor is a set from outside undoable.
      editor.update(() => $setText(text, focused), {
        tag: focused ? [] : [SKIP_DOM_SELECTION_TAG],
        onUpdate: () => editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined),
      });
    },
    insertChip: (option) => editor.update(() => $insertChip(option)),
    insertMention: (row) => editor.update(() => $insertMention(row)),
    replaceTypedWord: (text) => editor.update(() => $replaceTypedWord(text)),
    removeTypedWord: () => editor.update(() => $replaceTypedWord("")),
    insertWhole: (text) => {
      editor.getRootElement()?.focus({ preventScroll: true });
      // History has no entry before the first edit; record the empty prompt so undo returns to it.
      editor.update(() => $setText("", true), { tag: HISTORY_MERGE_TAG, discrete: true });
      editor.update(() => $setText(text, true), { tag: HISTORY_PUSH_TAG, discrete: true });
    },
    retokenize: () => editor.update(() => $retokenize()),
    read: () =>
      editor.getEditorState().read(() => ({ typed: $readTypedWord(), draft: $readDraft() })),
    focusEnd: (text = "") => {
      // DOM focus first and synchronously: a keystroke the browser still delivers lands here.
      editor.getRootElement()?.focus({ preventScroll: true });
      editor.update(
        () => {
          const end = $getRoot().selectEnd();

          if (text !== "") end.insertText(text);
        },
        { discrete: true }
      );
    },
  };
};
