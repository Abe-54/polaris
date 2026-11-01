/** The props every Traces slot takes, so T4 and T5 replace a file without touching the layout. */
import type { TracesSessionKey } from "../model/session.ts";

export interface TracesSlotProps {
  readonly at: TracesSessionKey;
  readonly hostKey: string;
  readonly workspaceId: string;
  /** The open trace and selected span; null when none. */
  readonly traceId: string | null;
  readonly spanId: string | null;
}
