import type { TraceDetail } from "@polaris/protocol";

type Usual = NonNullable<TraceDetail["usual"]>[string];

/** The same five-sample, >20ms, >3× SLOW rule as the Traces tools; FAST is its inverse. */
export const durationVerdict = (
  durationMs: number,
  usual: Usual | undefined
): "FAST" | "SLOW" | null => {
  if (usual === undefined || usual.samples < 5) return null;

  if (durationMs > 20 && durationMs > 3 * usual.usualMs) return "SLOW";

  if (usual.usualMs > 20 && durationMs < usual.usualMs / 3) return "FAST";

  return null;
};
