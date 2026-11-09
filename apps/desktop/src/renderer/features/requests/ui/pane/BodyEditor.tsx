/**
 * The body editor (DESIGN.md, Requests → Request pane): the Editor's CodeMirror look and keys,
 * as Data's SQL editor, the body's language for colour, and `{{variables}}` in Starlight.
 */
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  MatchDecorator,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { currentKeyPlatform } from "../../../../../shared/chord.ts";
import { loadLanguage } from "../../../editor/cm/languages.ts";
import { shellSafe } from "../../../editor/cm/keys.ts";
import { editorLook } from "../../../editor/cm/theme.ts";
import type { BodyLanguage } from "../../model/draft.ts";

const variableMark = Decoration.mark({ class: "cm-request-variable" });

/** The whole `{{…}}` in Starlight, over a string's colour inside it too. */
const variableLook = EditorView.theme({
  ".cm-request-variable, .cm-request-variable *": { color: "var(--color-starlight)" },
});

/** `{{name}}` over the language's colours, as in the URL bar. */
const variables = ViewPlugin.fromClass(
  class {
    decorations;
    readonly matcher = new MatchDecorator({ regexp: /\{\{[^{}]*\}\}/g, decoration: variableMark });

    constructor(view: EditorView) {
      this.decorations = this.matcher.createDeco(view);
    }

    update(update: ViewUpdate) {
      this.decorations = this.matcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

const GRAMMAR = { json: "json", xml: "xml" } as const;

const languageOf = async (language: BodyLanguage): Promise<Extension> =>
  language === "json" || language === "xml" ? loadLanguage(GRAMMAR[language]) : [];

export interface BodyEditorProps {
  readonly text: string;
  readonly language: BodyLanguage;
  readonly onChange: (text: string) => void;
}

export const BodyEditor = ({ text, language, onChange }: BodyEditorProps) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const grammar = useRef(new Compartment());
  const handlers = useRef({ onChange });
  // What the view starts with; later text arrives through the effect below.
  const start = useRef(text);

  handlers.current = { onChange };

  useEffect(() => {
    const parent = host.current;

    if (parent === null) return undefined;

    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc: start.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          bracketMatching(),
          closeBrackets(),
          keymap.of(
            shellSafe(
              [...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab],
              currentKeyPlatform()
            )
          ),
          editorLook,
          variables,
          variableLook,
          placeholder("No body"),
          grammar.current.of([]),
          EditorView.contentAttributes.of({ "aria-label": "Body" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });

    view.current = created;

    return () => {
      created.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    let live = true;

    void languageOf(language).then((extension) => {
      if (live) view.current?.dispatch({ effects: grammar.current.reconfigure(extension) });
    });

    return () => {
      live = false;
    };
  }, [language]);

  // Another Request opened, or the file changed: the document follows.
  useEffect(() => {
    const current = view.current;

    if (current === null || current.state.doc.toString() === text) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: text } });
  }, [text]);

  return (
    <div
      ref={host}
      data-testid="requests-body-editor"
      className="min-h-0 flex-1 overflow-hidden [&>.cm-editor]:h-full"
    />
  );
};
