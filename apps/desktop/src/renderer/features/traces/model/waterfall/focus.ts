/**
 * What narrows the waterfall: Find spans (a name, a service or an id prefix), Errors only, and
 * one service from the Services chip. Each keeps its matches and the path down to them.
 */
import type { SpanNode } from "./tree.ts";

export interface Focus {
  readonly find: string;
  readonly errorsOnly: boolean;
  readonly service: string | null;
}

export const NO_FOCUS: Focus = { find: "", errorsOnly: false, service: null };

const ID_PREFIX = /^[0-9a-f]{4,32}$/;

const found = (node: SpanNode, needle: string) =>
  node.name.toLowerCase().includes(needle) ||
  node.service.toLowerCase().includes(needle) ||
  (ID_PREFIX.test(needle) &&
    node.spans.some((s) => s.span.id.startsWith(needle) || s.span.traceId.startsWith(needle)));

/** The predicate for `waterfallRows`, or null when nothing narrows. */
export const focusOf = (focus: Focus): ((node: SpanNode) => boolean) | null => {
  const needle = focus.find.trim().toLowerCase();

  if (needle === "" && !focus.errorsOnly && focus.service === null) return null;

  return (node) =>
    (!focus.errorsOnly || node.error) &&
    (focus.service === null || node.service === focus.service) &&
    (needle === "" || found(node, needle));
};

/** The five series hues by first appearance (rule/context-categories); neutral after. */
const HUES = [
  "var(--color-context-tools)",
  "var(--color-context-system)",
  "var(--color-context-mcp)",
  "var(--color-context-skills)",
  "var(--color-context-memory)",
] as const;

export const NEUTRAL_HUE = "var(--color-text-subtle)";

export const ERROR_HUE = "var(--color-severity-critical)";

export const serviceHue = (index: number | undefined): string =>
  (index === undefined ? undefined : HUES[index]) ?? NEUTRAL_HUE;
