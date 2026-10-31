/** The waterfall and Table's model (DESIGN.md, Traces → Waterfall): pure, over a TraceDetail. */
export {
  coveredMs,
  type ServiceStat,
  type TimedSpan,
  type TraceTimes,
  traceTimes,
} from "./trace.ts";

export { FOLD_AT, holds, type SpanNode, spanTree } from "./tree.ts";

export { parentKeys, type RowOptions, type WaterfallRow, waterfallRows } from "./rows.ts";

export { DEFAULT_SORT, type SortKey, sortFor, type TableSort, tableRows } from "./table.ts";

export { ERROR_HUE, type Focus, focusOf, NEUTRAL_HUE, NO_FOCUS, serviceHue } from "./focus.ts";

export { clockLabel, durationLabel, rulerTicks, shortHex, type Tick } from "./time.ts";
