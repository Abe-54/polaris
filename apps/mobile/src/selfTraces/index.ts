/**
 * The Mobile App's Self-Traces (ENG-713, ADR 0095): one Tracer for the app, gated live on the
 * Polaris Workspace's Host's Developer Mode.
 */
import type { Command } from "@polaris/protocol";
import type { Effect } from "effect";
import { openSelfTracer } from "./tracer.ts";

export { type SelfSpanHandle, type SelfTracer, MOBILE_SERVICE } from "./tracer.ts";

export const selfTracer = openSelfTracer();

/** A command sent to a Host, in a client Span whose `traceparent` the dispatch carries. */
export const tracedDispatch = <A, E, R>(
  command: Command,
  commandId: string,
  dispatch: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  selfTracer.traced(
    `mobile.dispatch.${command._tag}`,
    { "polaris.command": command._tag, "polaris.command.id": commandId },
    dispatch
  );
