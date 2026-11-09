/** A CodeMirror editor with the prediction extension on a scripted edit port, for the edit tests. */
import "../../../../test/dom.testing.ts";
import { history, indentWithTab } from "@codemirror/commands";
import { EditorState, type Extension, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { PredictedEdit } from "@polaris/protocol";
import { setClientPlatform } from "../../../../../shared/platform.ts";
import { predictionExtension, type PredictionPort } from "../index.ts";
import {
  DEFAULT_EDIT_PREDICTION_SETTINGS,
  type EditFinal,
  type EditPrediction,
  type EditPredictionInput,
  type EditPredictionPort,
  type EditPredictionSettings,
  setEditPrediction,
} from "./index.ts";

export const views: EditorView[] = [];

let restoreSelectionChange: (() => void) | null = null;

/** Queues `selectionchange` as a browser does; happy-dom fires it inside CodeMirror's update. */
const deferSelectionChange = () => {
  if (restoreSelectionChange !== null) return;

  const dispatch = document.dispatchEvent.bind(document);
  // happy-dom's propagation calls dispatchEvent again: a queued event passes straight through.
  const queued = new WeakSet<Event>();

  document.dispatchEvent = (event) => {
    if (event.type !== "selectionchange" || queued.has(event)) return dispatch(event);

    queued.add(event);
    setTimeout(() => dispatch(event), 0);

    return true;
  };

  restoreSelectionChange = () => {
    Reflect.deleteProperty(document, "dispatchEvent");
    restoreSelectionChange = null;
  };
};

export const cleanup = () => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.remove();
  }

  restoreSelectionChange?.();
  setClientPlatform(null);
};

export const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Long enough for the 5 ms test pause to elapse and the request to start. */
export const settle = () => flush(25);

export const fim: PredictionPort = {
  allowed: () => true,
  request: async () => ({ text: "" }),
  subscribe: () => () => {},
};

export interface Call {
  readonly input: EditPredictionInput;
  readonly signal: AbortSignal;
  readonly resolve: (final: EditFinal) => void;
  readonly reject: (error: Error) => void;
}

export interface FakeEditPort extends EditPredictionPort {
  readonly calls: Call[];
  refresh: () => void;
}

export const editPort = (
  overrides: Partial<EditPredictionSettings["restraints"]> & {
    readonly display?: EditPredictionSettings["display"];
    readonly available?: boolean;
  } = {}
): FakeEditPort => {
  const calls: Call[] = [];
  const { available = true, display = "full", ...restraints } = overrides;

  const port: FakeEditPort = {
    calls,
    refresh: () => {},
    available: () => available,
    settings: () => ({
      ...DEFAULT_EDIT_PREDICTION_SETTINGS,
      display,
      restraints: { ...DEFAULT_EDIT_PREDICTION_SETTINGS.restraints, pauseMs: 5, ...restraints },
    }),
    subscribe: (refresh) => {
      port.refresh = refresh;

      return () => {};
    },
    request: (input, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ input, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };

  return port;
};

export const editor = (
  doc: string,
  port: EditPredictionPort = editPort(),
  cursor = doc.length,
  extensions: Extension = []
) => {
  setClientPlatform("darwin");
  deferSelectionChange();

  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        history(),
        keymap.of([indentWithTab]),
        predictionExtension(fim, port),
        extensions,
      ],
    }),
    parent: document.body,
  });

  views.push(view);
  view.focus();

  return view;
};

export const press = (view: EditorView, key: string, altKey = false) =>
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, code: key, altKey, bubbles: true, cancelable: true })
  );

export const tab = (view: EditorView) => press(view, "Tab");

export const final = (
  edits: ReadonlyArray<PredictedEdit>,
  extra: Partial<EditFinal> = {}
): EditFinal => ({
  edits,
  cursor: null,
  window: { from: 0, to: Number.MAX_SAFE_INTEGER },
  elapsedMs: 10,
  model: "zeta-2.1",
  format: "zeta-2.1",
  side: "client",
  ...extra,
});

/** Puts a prediction on screen directly, old enough for the 100 ms Tab guard. */
export const show = (
  view: EditorView,
  edits: ReadonlyArray<PredictedEdit>,
  extra: Partial<EditPrediction> = {}
) =>
  view.dispatch({
    effects: setEditPrediction.of({
      id: "test",
      hunks: [...edits].sort((a, b) => a.from - b.from),
      cursor: null,
      window: { from: 0, to: view.state.doc.length },
      doc: view.state.doc,
      anchor: view.state.selection.main.head,
      phase: "shown",
      shownAt: performance.now() - 1000,
      finalToShown: 0,
      model: "zeta-2.1",
      format: "zeta-2.1",
      side: "client",
      requestToFinal: 10,
      ...extra,
    }),
  });

/** Types at the cursor, optionally at a given clock time (for the history's bursts). */
export const type = (view: EditorView, text: string, time?: number) => {
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: "input.type",
    annotations: time === undefined ? [] : [Transaction.time.of(time)],
  });
};

export const hint = (view: EditorView) => view.dom.querySelector(".cm-ep-hint");

export const label = (view: EditorView) =>
  view.dom.querySelector(".cm-ep-label")?.textContent ?? null;
