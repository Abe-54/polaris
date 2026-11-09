/**
 * The send's trace, live: the checkout's traces rooted at "send" are watched, and each time this
 * one's summary grows (or first appears) it is read again with traces.get, keeping the shown spans.
 */
import type { TraceDetail, TraceFilter } from "@polaris/protocol";
import {
  keyOf,
  type Loaded,
  settle,
  useLoadedWith,
  useTraces,
  useTracesApi,
} from "../../../traces/data/hooks.tsx";
import { summaryVersion } from "../../../traces/model/listed.ts";
import type { TracesSessionKey } from "../../../traces/model/session.ts";
import { SEND_SPAN_NAME } from "./model.ts";

/** Only traces a send started; the newest are the ones a send pane shows. */
const SENDS: TraceFilter = { route: SEND_SPAN_NAME, limit: 20 };

export const useSendTrace = (at: TracesSessionKey, traceId: string): Loaded<TraceDetail> => {
  const listed = useTraces(at, SENDS);

  const summary =
    listed.status === "ready" ? listed.value.traces.find((t) => t.id === traceId) : undefined;

  return useLoadedWith(
    useTracesApi(),
    keyOf(at.hostKey, at.sessionId, traceId),
    settle((api) => api.get(at, traceId)),
    summary === undefined ? "unlisted" : summaryVersion(summary)
  );
};
