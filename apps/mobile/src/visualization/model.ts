/**
 * Visualizations in the thread (ENG-599, ADR 0101, DESIGN.md Visualizations): which Tool Calls
 * draw one, its id and title, which later calls revise it, and the frame's messages and heights.
 */
import type { TurnItem } from "@polaris/protocol";
import {
  FRAME_HEIGHT_MAX,
  FRAME_HEIGHT_MIN,
  FrameMessage,
  VisualizeInput,
  VisualizeResult,
} from "@polaris/visualization";
import { Option, Predicate, Schema } from "effect";

type ToolCall = Extract<TurnItem, { readonly _tag: "ToolCall" }>;

/** A Tool Call's `input` or `output`, as its Harness sent it. */
type ToolPayload = ToolCall["input"];

const VISUALIZE = /^(?:mcp__polaris(?:_\d+)?__|polaris(?:_\d+)?\.)visualize$/;

/** True for the Polaris MCP's `visualize` call, under Claude Code's or Codex's naming. */
export const isVisualizeCall = (call: ToolCall): boolean =>
  VISUALIZE.test(call.name) || (call.mcp?.server === "polaris" && call.mcp.tool === "visualize");

export interface Visualization {
  /** The Tool Call's id: the row's key while the Daemon's own id isn't back yet. */
  readonly callId: string;
  /** The Daemon's `viz_…` id from the call's output; the call's id until it answers. */
  readonly id: string;
  readonly title: string;
  readonly html: string;
  readonly replaces: string | null;
  readonly drawing: boolean;
}

const decodeInput = Schema.decodeUnknownOption(VisualizeInput);

const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(VisualizeResult));

const decodeObject = Schema.decodeUnknownOption(VisualizeResult);

/** The first `VisualizeResult` in an output, as Harnesses wrap MCP text blocks. */
const resultIn = (output: ToolPayload, depth = 0): VisualizeResult | null => {
  if (depth > 4 || output === null || output === undefined) return null;

  if (Predicate.isString(output)) return Option.getOrNull(decodeResult(output));

  if (Array.isArray(output)) {
    for (const part of output) {
      const found = resultIn(part, depth + 1);

      if (found !== null) return found;
    }

    return null;
  }

  const direct = Option.getOrNull(decodeObject(output));

  if (direct !== null) return direct;

  for (const key of ["text", "content", "structuredContent", "result"]) {
    if (Predicate.hasProperty(output, key)) {
      const found = resultIn(output[key], depth + 1);

      if (found !== null) return found;
    }
  }

  return null;
};

const stringAt = (input: ToolPayload, key: string): string =>
  Predicate.hasProperty(input, key) && Predicate.isString(input[key]) ? input[key] : "";

/**
 * A `visualize` call as a Visualization; null when it isn't one, or the Daemon refused it
 * (a refused call leaves no card, DESIGN.md Drawing).
 */
export const visualizationOf = (call: ToolCall): Visualization | null => {
  if (!isVisualizeCall(call) || call.status === "failed" || call.status === "declined") return null;
  const input = Option.getOrNull(decodeInput(call.input));
  const result = resultIn(call.output);

  return {
    callId: call.id,
    id: result?.id ?? call.id,
    title: input?.title ?? (result?.title || stringAt(call.input, "title")),
    html: input?.html ?? "",
    replaces: input?.replaces ?? null,
    drawing: call.status === "running" || input === null,
  };
};

/** The ids a later Visualization replaces, across the whole thread. */
export const revisedIds = (
  turns: ReadonlyArray<{ readonly items: ReadonlyArray<TurnItem> }>
): ReadonlySet<string> => {
  const revised = new Set<string>();

  for (const { items } of turns)
    for (const item of items) {
      if (!Predicate.isTagged(item, "ToolCall")) continue;
      const shown = visualizationOf(item);

      if (shown !== null && !shown.drawing && shown.replaces !== null) revised.add(shown.replaces);
    }

  return revised;
};

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(FrameMessage));

/** A WebView message as a `FrameMessage`; null for anything else. */
export const parseFrameMessage = (data: string): FrameMessage | null =>
  Option.getOrNull(decodeMessage(data));

/** A reported height clamped to the frame's range; null when it isn't a number. */
export const clampHeight = (height: number): number | null =>
  Number.isFinite(height)
    ? Math.min(FRAME_HEIGHT_MAX, Math.max(FRAME_HEIGHT_MIN, Math.ceil(height)))
    : null;

export interface OpenableLink {
  readonly href: string;
  /** The domain the confirm names, without credentials or port. */
  readonly host: string;
}

// Hermes' URL can't read `protocol` or `host`, so the link is parsed by hand, strictly: an ASCII
// host, no credentials, and nothing but printable ASCII without a backslash.
const HTTPS = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?(?:[/?#][\x21-\x7e]*)?$/i;

const UNSAFE = /[^\x21-\x7e]|\\/;

export const openableLink = (url: string): OpenableLink | null => {
  const host = UNSAFE.test(url) ? undefined : HTTPS.exec(url)?.[1];

  return host === undefined ? null : { href: url, host: host.toLowerCase() };
};
