import { durationLabel } from "./waterfall/time.ts";

/** The span panel's and Output's duration: the waterfall's own, so a span reads alike in each. */
export const formatDuration = durationLabel;

/** A long hex id as its first and last four ("a91f…03c2"), as the trace bar and span panel show it. */
export const shortId = (id: string) => (id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`);
