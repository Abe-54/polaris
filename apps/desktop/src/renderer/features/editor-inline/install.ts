/**
 * The selection bar, ⌘I and ⌘L on whichever editor is active. The editor feature supplies the
 * active view and runs `inlineExtensions` in every editor; this registers the two commands.
 */
import type { EditorView } from "@codemirror/view";
import { WorkspaceId } from "@polaris/protocol";
import { useEffect } from "react";
import { useCommands } from "../../shell/hooks.ts";
import { type EditorFile, getActiveEditor, registerEditorExtensions } from "../editor/api.ts";
import { openInlineCard } from "./actions.ts";
import { type InlineFile, inlineExtensions } from "./cm/index.ts";
import { addSelectionToSession } from "./ui/AddToSession.tsx";

export interface ActiveEditor {
  readonly view: EditorView;
  readonly file: InlineFile;
}

/** Registers ⌘I and ⌘L while mounted; both act on `active()` and are off without an editor. */
export const useInlineCommands = (active: () => ActiveEditor | null) => {
  const commands = useCommands();

  useEffect(() => {
    return commands.register({
      "editor.inlineChat": {
        run: () => {
          const editor = active();

          if (editor !== null) openInlineCard(editor.view);
        },
        enabled: () => active() !== null,
      },
      "editor.addToSession": {
        run: () => {
          const editor = active();

          if (editor !== null) addSelectionToSession(editor.view.state, editor.file);
        },
        enabled: () => active()?.view.state.selection.main.empty === false,
      },
    });
  }, [commands, active]);
};

const inlineFileOf = (file: EditorFile): InlineFile => ({
  hostKey: file.hostKey,
  workspaceId: WorkspaceId.make(file.workspaceId),
  path: file.path,
});

const activeEditor = (): ActiveEditor | null => {
  const editor = getActiveEditor();

  return editor === null ? null : { view: editor.view, file: inlineFileOf(editor) };
};

/** In the app: the bar and card in every editor, ⌘I and ⌘L on the active one. */
export const useInlineInstall = () => {
  useEffect(() => {
    return registerEditorExtensions((file) => inlineExtensions(inlineFileOf(file)));
  }, []);
  useInlineCommands(activeEditor);
};
