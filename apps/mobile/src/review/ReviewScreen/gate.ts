/**
 * What a Review shows before its Turn is known (ENG-582): loading while the session is on its
 * way, the Host's Reconnecting or Offline state naming it, or why the Turn can't be found.
 * Never a made-up "Turn 0".
 */
import type { ConnectionState } from "@polaris/protocol";

export type ReviewGate =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "away";
      readonly title: string;
      readonly line: string;
      /** The Host's own failure, in mono; null when it gave none. */
      readonly failure: string | null;
      /** Polaris is still trying: an amber Reconnecting under the line. */
      readonly reconnecting: boolean;
      /** Retry now helps: the Host is being tried, or offline. */
      readonly retry: boolean;
    }
  | { readonly kind: "missing"; readonly title: string; readonly failure: string | null };

export interface ReviewGateInput {
  /** Null when the Host isn't linked to this iPhone. */
  readonly host: {
    readonly name: string;
    readonly state: ConnectionState;
    readonly failure: string | null;
  } | null;
  readonly session:
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly turnFound: boolean }
    | { readonly kind: "failed"; readonly message: string };
}

const AWAY_TITLES: Readonly<
  Record<Exclude<ConnectionState, "connected">, (host: string) => string>
> = {
  reconnecting: (host) => `Can't reach ${host}`,
  offline: (host) => `${host} is offline`,
  "needs-attention": (host) => `${host} needs attention`,
};

export const reviewGate = ({ host, session }: ReviewGateInput): ReviewGate => {
  if (host === null)
    return { kind: "missing", title: "This host isn't linked to this iPhone", failure: null };

  if (session.kind === "failed")
    return { kind: "missing", title: "Can't open this review", failure: session.message };

  if (session.kind === "ready")
    return session.turnFound
      ? { kind: "ready" }
      : { kind: "missing", title: `This turn isn't on ${host.name}`, failure: null };

  if (host.state === "connected") return { kind: "loading" };

  return {
    kind: "away",
    title: AWAY_TITLES[host.state](host.name),
    line: "This turn's review opens as soon as it connects.",
    failure: host.failure === "" ? null : host.failure,
    reconnecting: host.state === "reconnecting",
    retry: host.state !== "needs-attention",
  };
};
