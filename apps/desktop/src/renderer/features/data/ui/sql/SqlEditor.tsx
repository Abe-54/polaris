/**
 * The SQL tab's editor: the Editor's CodeMirror look and keys, lang-sql in the source's dialect
 * completing from its catalog, ⌘↵ to run, and the last run's database error marked in place.
 */
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { currentKeyPlatform } from "../../../../../shared/chord.ts";
import { shellSafe } from "../../../editor/cm/keys.ts";
import { editorLook } from "../../../editor/cm/theme.ts";
import type { Catalog } from "../../sql/catalog.ts";
import { type Engine, sqlLanguage } from "../../sql/language.ts";
import type { ErrorSpan } from "../../sql/sqlError.ts";

export interface SqlEditorProps {
  readonly text: string;
  readonly engine: Engine;
  readonly catalog: Catalog | null;
  /** The last run's database error, marked until the text changes. */
  readonly error: { readonly span: ErrorSpan; readonly message: string } | null;
  readonly onChange: (text: string) => void;
  readonly onRun: () => void;
  /** The editor's accessible name. */
  readonly label: string;
}

const editorKeys = () =>
  keymap.of([
    ...shellSafe(
      [...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab],
      currentKeyPlatform()
    ),
  ]);

export const SqlEditor = ({
  text,
  engine,
  catalog,
  error,
  onChange,
  onRun,
  label,
}: SqlEditorProps) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const handlers = useRef({ onChange, onRun });
  // What the view starts with; later changes arrive through the effects below.
  const start = useRef({ text, label });

  handlers.current = { onChange, onRun };

  useEffect(() => {
    const parent = host.current;

    if (parent === null) return undefined;

    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc: start.current.text,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  handlers.current.onRun();

                  return true;
                },
              },
            ])
          ),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          bracketMatching(),
          autocompletion({ activateOnTyping: true }),
          editorKeys(),
          editorLook,
          placeholder("Write a query"),
          language.current.of([]),
          EditorView.contentAttributes.of({ "aria-label": start.current.label }),
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
    view.current?.dispatch({
      effects: language.current.reconfigure(sqlLanguage(engine, catalog)),
    });
  }, [engine, catalog]);

  // Text set from outside (Format, a re-run from the Query Log) replaces the document.
  useEffect(() => {
    const current = view.current;

    if (current === null || current.state.doc.toString() === text) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: text } });
  }, [text]);

  useEffect(() => {
    const current = view.current;

    if (current === null) return;
    const length = current.state.doc.length;

    const marks =
      error === null || error.span.from >= length
        ? []
        : [
            {
              from: error.span.from,
              to: Math.min(error.span.to, length),
              severity: "error" as const,
              message: error.message,
            },
          ];

    current.dispatch(setDiagnostics(current.state, marks));
  }, [error]);

  return (
    <div
      ref={host}
      data-testid="data-sql-editor"
      className="min-h-0 flex-1 overflow-hidden [&>.cm-editor]:h-full"
    />
  );
};
