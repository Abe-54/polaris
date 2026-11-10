import "../../../test/dom.testing.ts";
import { afterEach, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bindVimCommands, vimExtension } from "./vim.ts";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

const editor = async (doc: string) => {
  const extension = await vimExtension();

  view = new EditorView({
    state: EditorState.create({ doc, extensions: [extension] }),
    parent: document.body,
  });

  const { Vim, getCM } = await import("@replit/codemirror-vim");
  const cm = getCM(view);

  if (cm === null) throw new Error("vim did not attach");

  return { view, press: (...keys: string[]) => keys.forEach((k) => Vim.handleKey(cm, k, "user")) };
};

test("vim's language keys run their registry commands by id", async () => {
  const ran: string[] = [];
  const unbind = bindVimCommands((id) => (ran.push(id), true));

  try {
    const { press } = await editor("const value = 1;\nvalue;\n");

    press("g", "d");
    press("g", "D");
    press("g", "y");
    press("g", "i");
    press("g", "r");
    press("K");
    press("]", "d");
    press("[", "d");
    press("<C-o>");
    press("<C-i>");
    expect(ran).toEqual([
      "editor.language.definition",
      "editor.language.declaration",
      "editor.language.typeDefinition",
      "editor.language.implementation",
      "editor.language.references",
      "editor.language.hover",
      "editor.language.nextProblem",
      "editor.language.previousProblem",
      "editor.language.back",
      "editor.language.forward",
    ]);
  } finally {
    unbind();
  }
});

test("an unavailable command does nothing, and ⌃o falls back to vim's own jump list", async () => {
  const unbind = bindVimCommands(() => false);

  try {
    const { view: shown, press } = await editor("one\ntwo\nthree\nfour\n");

    press("G");
    const bottom = shown.state.selection.main.head;

    press("g", "d");
    expect(shown.state.selection.main.head).toBe(bottom);
    press("<C-o>");
    expect(shown.state.doc.lineAt(shown.state.selection.main.head).number).toBe(1);
  } finally {
    unbind();
  }
});
