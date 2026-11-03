/**
 * Linking as the scan sheet steps through it: the model in `model.ts`, plus its one effect, a
 * single link through the Polaris Relay. The link holds a one-time secret: it goes only to `onLink`.
 */
import type { LinkedHost } from "@polaris/client/relay";
import { decodeLinkString } from "@polaris/protocol";
import { Option } from "effect";
import type { LinkOutcome } from "../relay/RelayProvider.tsx";
import {
  advance,
  FIRST_STEP,
  type FoundHosts,
  type LinkEvent,
  type LinkStep,
  LINKED_DWELL_MS,
  NOT_SAVED,
  startsLink,
} from "./model.ts";

export type { LinkOutcome, LinkStep };

export { hostsLine, NOT_A_LINK, NOT_SAVED } from "./model.ts";

export interface LinkingOptions {
  readonly onLink: (link: string) => Promise<LinkOutcome>;
  readonly onStep: (step: LinkStep) => void;
  /** After "Linked this iPhone" has stood for its dwell, with every Host the link named. */
  readonly onLinked?: ((hosts: ReadonlyArray<LinkedHost>) => void) | undefined;
  readonly notSaved?: string;
  /** The dwell's timer; tests pass their own. */
  readonly later?: (run: () => void, ms: number) => void;
}

export interface Linking {
  /** A scanned code or the pasted text; ignored while a link is under way. */
  readonly submit: (text: string) => void;
  /** Back to the scanner or the paste field. */
  readonly show: (view: "scan" | "paste") => void;
}

const found = (text: string): FoundHosts | null => {
  const envelope = Option.getOrNull(decodeLinkString(text));

  if (envelope === null) return null;
  const hostName = envelope.link.hostName;

  return { hostName, hosts: [hostName, ...envelope.hosts.map((host) => host.hostName)] };
};

export const linking = ({
  onLink,
  onStep,
  onLinked,
  notSaved = NOT_SAVED,
  later = (run, ms) => void setTimeout(run, ms),
}: LinkingOptions): Linking => {
  let step = FIRST_STEP;

  const dispatch = (event: LinkEvent): LinkStep => {
    const before = step;

    step = advance(step, event);

    if (step !== before) onStep(step);

    return before;
  };

  const link = (text: string) =>
    onLink(text).then(
      (outcome) => {
        if (!outcome.linked) return void dispatch({ kind: "refused", message: outcome.message });
        dispatch({ kind: "linked", hosts: outcome.hosts.map((host) => host.hostName) });
        later(() => onLinked?.(outcome.hosts), LINKED_DWELL_MS);
      },
      () => void dispatch({ kind: "refused", message: notSaved })
    );

  return {
    show: (view) => void dispatch({ kind: "show", view }),
    submit: (text) => {
      const before = dispatch({
        kind: "read",
        found: step.kind === "linking" ? null : found(text),
      });

      if (startsLink(before, step)) void link(text);
    },
  };
};
