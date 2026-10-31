/** The open trace's stretch in exact Unix nanoseconds, to compare with a Profile's. */
import type { TraceDetail } from "@polaris/protocol";

export const openTraceNs = (trace: Pick<TraceDetail, "summary">) => {
  const startNs = BigInt(trace.summary.startTimeUnixNano);

  return { startNs, endNs: startNs + BigInt(Math.round(trace.summary.durationMs * 1_000_000)) };
};
