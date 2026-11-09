/**
 * Visualizations (ENG-594, ADR 0089): the `visualize` tool's input, the validation the
 * Daemon runs when the agent submits, the frame document, and the frame↔app messages.
 */
import { Schema } from "effect";
import { buildFrameDocumentWith, type FrameLibraries } from "./frame/document.ts";
import { type VisualizationProblem, validateWith } from "./validate/index.ts";

export {
  boundedJson,
  type BridgeClock,
  type Coalesced,
  coalesced,
  FRAME_MESSAGE_MAX_BYTES,
  FRAME_MESSAGE_RATE,
  type FrameInbox,
  frameInbox,
  type FrameLane,
  laneOfText,
  laneOfType,
  LINK_CONFIRM_COOLDOWN_MS,
  LINK_CONFIRM_MAX_DECLINED,
  type LinkConfirms,
  linkConfirms,
  timerClock,
} from "./bridge/index.ts";

export { FRAME_CSP, type FrameLibraries } from "./frame/document.ts";

export { VISUALIZE_TOOL_DESCRIPTION, visualizeGuidance } from "./guidance.ts";

export {
  FRAME_TOKEN_DEFAULTS,
  FRAME_TOKEN_NAMES,
  FRAME_TOKEN_SOURCES,
  FRAME_TOKEN_THEMES,
  type FrameTokenName,
  resolveFrameTokens,
  safeTokenValue,
} from "./tokens.ts";

export type { VisualizationProblem, VisualizationRule } from "./validate/index.ts";

export { CHART_JS_PIN, D3_PIN, LIBRARY_PINS, type LibraryPin } from "./vendor/pins.ts";

/** Hard cap on `html`, in UTF-8 bytes. */
export const VISUALIZATION_MAX_BYTES = 128 * 1024;

export const VISUALIZATION_TITLE_MAX = 120;

/** The `visualize` tool's input, as the Harness sends it. */
export const VisualizeInput = Schema.Struct({
  title: Schema.String,
  /** A body fragment: no `<!doctype>`, `<html>`, `<head>` or `<body>`. */
  html: Schema.String,
  /** The id of an earlier Visualization in this Agent Session that this one replaces. */
  replaces: Schema.optionalKey(Schema.String),
});

export type VisualizeInput = typeof VisualizeInput.Type;

/**
 * The tool result on success. `id` is minted by the Daemon; a Client reads it from the Tool Call's
 * output (one text block holding this JSON) and matches it against a later call's `replaces`.
 */
export const VisualizeResult = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  bytes: Schema.Int,
});

export type VisualizeResult = typeof VisualizeResult.Type;

/** Checks a submission; an empty array means it is accepted. Pure and synchronous. */
export const validateVisualization = (input: VisualizeInput): ReadonlyArray<VisualizationProblem> =>
  validateWith(input, { maxBytes: VISUALIZATION_MAX_BYTES, titleMax: VISUALIZATION_TITLE_MAX });

/** The Visuals setting: how readily the agent reaches for `visualize`; `off` removes the tool. */
export const VisualsLevel = Schema.Literals(["rich", "simple", "off"]);

export type VisualsLevel = typeof VisualsLevel.Type;

/** Token name (`--pv-bg` or `pv-bg`) → value; names outside FRAME_TOKEN_NAMES, and values over 128 chars or containing `<>{};`, are dropped. */
export type FrameTokens = Readonly<Record<string, string>>;

export interface FrameDocumentOptions {
  readonly html: string;
  readonly title: string;
  readonly tokens: FrameTokens;
  readonly scheme: "light" | "dark";
  /** The frame's saved `pv.state`, restored before the agent's script runs. */
  readonly state?: unknown;
  /** `inline` sizes to content and reports height; `expanded` fills its container. */
  readonly mode: "inline" | "expanded";
  /** `auto` (the default) inlines only the libraries the fragment names; `all` inlines both. */
  readonly libraries?: FrameLibraries;
}

/**
 * The complete document for a frame's `srcdoc` (Desktop) or WebView `html` (Mobile): CSP meta
 * first, then tokens, Chart.js, D3, the Polaris kit (`pv`), and the agent's fragment.
 */
export const buildFrameDocument = (options: FrameDocumentOptions): string =>
  buildFrameDocumentWith(options);

/** Messages the frame posts to the app. Accept only from the frame's own window. */
export const FrameMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("pv:height"), height: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("pv:open-link"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("pv:state"), state: Schema.Unknown }),
]);

export type FrameMessage = typeof FrameMessage.Type;

/** Messages the app posts into the frame. */
export const HostMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pv:theme"),
    tokens: Schema.Record(Schema.String, Schema.String),
    scheme: Schema.Literals(["light", "dark"]),
  }),
]);

export type HostMessage = typeof HostMessage.Type;

/** Inline frame heights are clamped to this range, in CSS px. */
export const FRAME_HEIGHT_MIN = 80;

export const FRAME_HEIGHT_MAX = 6000;
