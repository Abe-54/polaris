import "../../../test/dom.testing.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { autocompletion, currentCompletions } from "@codemirror/autocomplete";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cmChord, forwardShellChords, shellChords } from "../cm/keys.ts";
import { vimExtension } from "../cm/vim.ts";
import { footnoteOf } from "./completionMenu.ts";
import { WORDS_FOOTNOTE, withWordFallback } from "./codemirror.ts";
import { setClientPlatform } from "../../../../shared/platform.ts";

// These tests read macOS labels ("⌘↵", "⌃Space").
beforeAll(() => setClientPlatform("darwin"));

afterAll(() => setClientPlatform(null));

let view: EditorView | null = null;

let unforward: (() => void) | null = null;

afterEach(() => {
  unforward?.();
  view?.destroy();
  view = null;
  unforward = null;
});

/** An editor whose server answers nothing, as one still setting up (or none at all) does. */
const editor = (doc: string, extra: Extension = []) => {
  const parent = document.createElement("div");
  document.body.append(parent);
  unforward = forwardShellChords(parent, "mac");
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [extra, autocompletion({ override: [withWordFallback(async () => null)] })],
    }),
    parent,
  });
  view.focus();

  return view;
};

const ctrlSpace = (target: EditorView) =>
  target.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      keyCode: 32,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
  );

const listed = async (target: EditorView) => {
  for (let wait = 0; wait < 40 && currentCompletions(target.state).length === 0; wait++)
    await new Promise((resolve) => setTimeout(resolve, 25));

  return currentCompletions(target.state);
};

test("⌃Space opens completion with the file's words when no server answers", async () => {
  const shown = editor("alpha beta\nal");

  ctrlSpace(shown);
  const options = await listed(shown);

  expect(options.map((o) => o.label)).toContain("alpha");
  expect(footnoteOf(options)).toBe(WORDS_FOOTNOTE);
});

test("⌃Space opens completion in vim's insert mode", async () => {
  const shown = editor("alpha beta\nal", await vimExtension());
  const { Vim, getCM } = await import("@replit/codemirror-vim");
  const cm = getCM(shown);

  if (cm === null) throw new Error("vim did not attach");
  Vim.handleKey(cm, "A", "user");
  ctrlSpace(shown);

  expect((await listed(shown)).map((o) => o.label)).toContain("alpha");
});

test("no shell chord takes ⌃Space or ⌃⇧Space from the editor", () => {
  const shell = shellChords("mac");

  for (const key of ["Ctrl-Space", "Ctrl-Shift-Space"])
    expect(shell.has(cmChord(key, "mac"))).toBe(false);
});
