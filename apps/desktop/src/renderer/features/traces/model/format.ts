/** How Traces writes a duration: "2.1 ms" under 10 ms, "840 ms", "3.1 s", "2.4 min". */
export const formatDuration = (ms: number): string => {
  if (ms < 10) return `${Number(ms.toFixed(1))} ms`;

  if (ms < 1000) return `${Math.round(ms)} ms`;

  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))} s`;

  return `${Number((ms / 60_000).toFixed(1))} min`;
};

/** A long hex id as its first and last four ("a91f…03c2"), as the trace bar and span panel show it. */
export const shortId = (id: string) => (id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`);
