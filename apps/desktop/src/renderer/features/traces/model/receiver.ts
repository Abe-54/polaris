/**
 * The status bar's receiver line (Paper T1; DESIGN.md, Traces): whether Polaris is receiving this
 * checkout's traces, and where. The endpoint carries a token, so only its host and port show.
 */
import type { TracesSnapshot } from "@polaris/protocol";
import { Match } from "effect";

export interface ReceiverLine {
  readonly text: string;
  /** The longer reason, for the line's tooltip; null when the text says it all. */
  readonly detail: string | null;
}

const hostPort = (endpoint: string): string | null => {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
};

export const receiverLine = (snapshot: TracesSnapshot): ReceiverLine =>
  Match.value(snapshot.availability).pipe(
    Match.tag("Unavailable", (u) => ({
      text: `Not receiving · ${u.code}${u.owner === null ? "" : ` · in use by ${u.owner}`}`,
      detail: u.message,
    })),
    Match.tag("Listening", () => {
      if (snapshot.userExported)
        return { text: "This app sends its traces elsewhere", detail: null };
      const at = snapshot.endpoint === null ? null : hostPort(snapshot.endpoint);

      return { text: at === null ? "Receiving" : `Receiving on ${at}`, detail: null };
    }),
    Match.exhaustive
  );
