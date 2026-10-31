import { Effect } from "effect";
import type { TraceSettings } from "./settings.ts";
import { forwardHeaders, type ForwardQueue } from "./forwardQueue.ts";
import type { IngestContext } from "./ingest.ts";

/** Policy and forwarding failure cannot prevent Polaris's independent storage attempt. */
export const forwardReceived = async (
  settings: TraceSettings["Service"] | null,
  queue: ForwardQueue,
  context: IngestContext,
  signal: "traces" | "logs",
  request: Request,
  bytes: Uint8Array
): Promise<boolean> => {
  if (settings === null) return true;

  let enabled = true;

  try {
    const policy = await Effect.runPromise(settings.policy(context));
    enabled = policy.enabled;
    const collector = policy.collector;
    const target = signal === "logs" ? collector?.logs : collector?.traces;

    if (
      policy.forwarding &&
      settings.current(context.workspaceId, policy.generation) &&
      target != null &&
      !(signal === "traces" && policy.alreadyExporting)
    ) {
      const configured = signal === "logs" ? collector?.logHeaders : collector?.headers;

      queue.enqueue({
        workspaceId: context.workspaceId,
        url: target,
        bytes,
        headers: forwardHeaders(request.headers, configured ?? {}),
      });
    }

    return policy.enabled;
  } catch {
    return enabled;
  }
};
