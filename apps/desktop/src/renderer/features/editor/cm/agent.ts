/**
 * What an agent wrote this Turn, in the code (Paper E3): a 2px bar in the
 * Harness hue where the git bars sit and a ~5% fill on its lines, and its
 * live caret with a name flag. No dither in the text area (DESIGN.md).
 */
import {
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutter,
  GutterMarker,
  WidgetType,
} from "@codemirror/view";
import { hueVar } from "@polaris/ui";

export interface AgentWrite {
  readonly turnId: string;
  readonly harness: string;
  /** The Harness's name for the caret's flag ("Claude Code"). */
  readonly name: string;
  readonly from: number;
  readonly to: number;
}

interface Span {
  readonly from: number;
  readonly to: number;
}

export interface AgentMarks {
  readonly turnId: string;
  readonly harness: string;
  readonly name: string;
  readonly spans: ReadonlyArray<Span>;
  /** After the newest change. */
  readonly caret: number;
}

/** One write the agent made, found by reloading the file. */
export const agentWrote = StateEffect.define<AgentWrite>();

/** A write ending in a line break (and the next line's indent) ends on the line before it. */
const trimmed = (state: EditorState, from: number, to: number) => {
  const tail = /\n[ \t]*$/.exec(state.sliceDoc(Math.max(from, to - 200), to));

  return tail === null || to - tail[0].length < from ? to : to - tail[0].length;
};

/** The agent stopped editing this file: its marks go. */
export const agentCleared = StateEffect.define<null>();

const write = (marks: AgentMarks | null, w: AgentWrite): AgentMarks => {
  const span = { from: w.from, to: w.to };
  const spans = marks !== null && marks.turnId === w.turnId ? [...marks.spans, span] : [span];

  return { turnId: w.turnId, harness: w.harness, name: w.name, spans, caret: w.to };
};

export const agentField = StateField.define<AgentMarks | null>({
  create: () => null,
  update(value, tr) {
    let next =
      value === null || tr.changes.empty
        ? value
        : {
            ...value,
            spans: value.spans.map((s) => ({
              from: tr.changes.mapPos(s.from),
              to: tr.changes.mapPos(s.to, 1),
            })),
            caret: tr.changes.mapPos(value.caret, 1),
          };

    for (const effect of tr.effects) {
      if (effect.is(agentWrote)) next = write(next, effect.value);
      else if (effect.is(agentCleared)) next = null;
    }

    return next;
  },
});

const linesByState = new WeakMap<EditorState, ReadonlySet<number>>();

const noLines: ReadonlySet<number> = new Set();

/** Computed once per state, shared by decorations and every visible gutter line. */
export const agentLines = (state: EditorState): ReadonlySet<number> => {
  const marks = state.field(agentField, false) ?? null;

  if (marks === null) return noLines;
  const cached = linesByState.get(state);

  if (cached !== undefined) return cached;
  const lines = new Set<number>();

  for (const span of marks?.spans ?? []) {
    const last = state.doc.lineAt(
      Math.min(trimmed(state, span.from, span.to), state.doc.length)
    ).number;

    for (let n = state.doc.lineAt(Math.min(span.from, state.doc.length)).number; n <= last; n++)
      lines.add(n);
  }

  linesByState.set(state, lines);

  return lines;
};

/** The line of the agent's caret, else the user's: the status bar's "Following … · Ln N". */
export const agentCaretLine = (state: EditorState): number => {
  const marks = state.field(agentField, false) ?? null;

  const at =
    marks === null
      ? state.selection.main.head
      : Math.min(trimmed(state, 0, marks.caret), state.doc.length);

  return state.doc.lineAt(at).number;
};

class CaretWidget extends WidgetType {
  constructor(readonly name: string) {
    super();
  }

  override eq(other: CaretWidget) {
    return other.name === this.name;
  }

  toDOM() {
    const caret = document.createElement("span");
    const flag = document.createElement("span");

    caret.className = "cm-agentCaret";
    caret.setAttribute("aria-hidden", "true");
    flag.className = "cm-agentFlag";
    flag.textContent = this.name;
    caret.append(flag);

    return caret;
  }

  override ignoreEvent() {
    return true;
  }
}

const agentLine = Decoration.line({ class: "cm-agentLine" });

const decorations = (state: EditorState): DecorationSet => {
  const marks = state.field(agentField, false) ?? null;

  if (marks === null) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const caret = Math.min(trimmed(state, 0, marks.caret), state.doc.length);
  const caretLine = state.doc.lineAt(caret);

  for (const n of [...agentLines(state)].sort((a, b) => a - b)) {
    const line = state.doc.line(n);

    builder.add(line.from, line.from, agentLine);

    if (line.number === caretLine.number) {
      builder.add(
        caret,
        caret,
        Decoration.widget({ widget: new CaretWidget(marks.name), side: 1 })
      );
    }
  }

  return builder.finish();
};

class BarMarker extends GutterMarker {
  override elementClass = "cm-agentMarkHost";

  override toDOM() {
    const bar = document.createElement("span");

    bar.className = "cm-agentMark";

    return bar;
  }
}

const bar = new BarMarker();

const agentGutter = gutter({
  class: "cm-agentGutter",
  lineMarker: (view, line) =>
    agentLines(view.state).has(view.state.doc.lineAt(line.from).number) ? bar : null,
  lineMarkerChange: (update) =>
    update.startState.field(agentField, false) !== update.state.field(agentField, false),
});

const agentTheme = EditorView.theme({
  ".cm-agentLine": { backgroundColor: "color-mix(in srgb, var(--agent-hue) 5%, transparent)" },
  ".cm-gutter.cm-agentGutter": { width: "0", overflow: "visible" },
  ".cm-agentGutter .cm-gutterElement": { overflow: "visible" },
  ".cm-agentMark": {
    position: "relative",
    zIndex: "1",
    display: "block",
    width: "2px",
    height: "100%",
    backgroundColor: "var(--agent-hue)",
  },
  ".cm-agentCaret": {
    position: "relative",
    display: "inline-block",
    width: "0",
    height: "20px",
    verticalAlign: "top",
  },
  ".cm-agentCaret::before": {
    content: '""',
    position: "absolute",
    left: "0",
    top: "1px",
    width: "2px",
    height: "18px",
    backgroundColor: "var(--agent-hue)",
  },
  ".cm-agentFlag": {
    position: "absolute",
    left: "2px",
    top: "2px",
    height: "16px",
    padding: "0 5px",
    borderRadius: "4px",
    backgroundColor: "var(--agent-hue)",
    color: "var(--color-bg)",
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    fontWeight: "500",
    lineHeight: "16px",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
});

/** The agent's marks: first among the gutters, so its bar overlays the git bar's place. */
export const agentMarks: Extension = [
  agentField,
  agentGutter,
  EditorView.decorations.compute([agentField], decorations),
  EditorView.editorAttributes.compute([agentField], (state) => {
    const marks = state.field(agentField, false) ?? null;

    return marks === null ? {} : { style: `--agent-hue: ${hueVar(marks.harness)}` };
  }),
  agentTheme,
];
