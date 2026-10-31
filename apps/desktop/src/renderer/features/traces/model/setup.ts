/**
 * Which setup state Traces shows in place of a trace (DESIGN.md, Traces → Setup; Paper T4): none
 * once the checkout has traces; otherwise reading, the Host away (reconnecting, offline or needing
 * attention), a failed read, the receiver unavailable, the app exporting on its own, or none yet.
 */
import type { ConnectionState, TracesSnapshot } from "@polaris/protocol";
import { Match } from "effect";
import type { IpcError } from "../../../../shared/api.ts";
import type { Loaded } from "../data/hooks.tsx";

export type SetupState =
  | { readonly kind: "loading" }
  | { readonly kind: "reconnecting"; readonly host: string }
  | { readonly kind: "offline"; readonly host: string }
  | { readonly kind: "needsAttention"; readonly host: string }
  | { readonly kind: "failed"; readonly error: IpcError }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly message: string;
      readonly owner: string | null;
    }
  | { readonly kind: "userExported" }
  | { readonly kind: "empty"; readonly endpoint: string | null };

/** Stored traces stay readable while the receiver is unavailable; the status bar says why. */
const fromSnapshot = (snapshot: TracesSnapshot): SetupState | null =>
  Match.value(snapshot.availability).pipe(
    Match.tag("Unavailable", (u) =>
      snapshot.traces.length > 0
        ? null
        : { kind: "unavailable" as const, code: u.code, message: u.message, owner: u.owner }
    ),
    Match.tag("Listening", () => {
      if (snapshot.traces.length > 0) return null;

      return snapshot.userExported
        ? { kind: "userExported" as const }
        : { kind: "empty" as const, endpoint: snapshot.endpoint };
    }),
    Match.exhaustive
  );

const fromLoaded = (snapshot: Loaded<TracesSnapshot>): SetupState | null => {
  if (snapshot.status === "ready") return fromSnapshot(snapshot.value);

  if (snapshot.status === "failed") return { kind: "failed", error: snapshot.error };

  return { kind: "loading" };
};

/** Why the Host is away, in its own words: only Reconnecting promises to come back by itself. */
const away = (state: Exclude<ConnectionState, "connected">, host: string): SetupState =>
  Match.value(state).pipe(
    Match.when("reconnecting", () => ({ kind: "reconnecting" as const, host })),
    Match.when("offline", () => ({ kind: "offline" as const, host })),
    Match.when("needs-attention", () => ({ kind: "needsAttention" as const, host })),
    Match.exhaustive
  );

/**
 * `snapshot` is an unfiltered `traces.watch`. While its Host isn't connected, any state but a list
 * of traces reads as the Host's Connection State; traces it already gave stay readable.
 */
export const setupState = (
  snapshot: Loaded<TracesSnapshot>,
  host: { readonly label: string; readonly state: ConnectionState } | undefined
): SetupState | null => {
  const state = fromLoaded(snapshot);

  if (state === null || host === undefined || host.state === "connected") return state;

  return away(host.state, host.label);
};

/** The base endpoint as the environment line a server started outside Polaris needs. */
export const endpointLine = (endpoint: string) => `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`;

/**
 * The one-line change for an exporter whose URL is fixed in code (docs/research/traces-otlp.md):
 * read Polaris's trace endpoint from the environment, keeping today's URL as the fallback.
 */
export const FIXED_EXPORTER_CHANGE =
  "url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? existingUrl,";
