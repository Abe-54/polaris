/**
 * The composer's floating notice strip (Paper MX-E, MX-D's strip): the oldest open request,
 * with the rest behind "+n", else Working while a Turn runs. Nothing to know, no strip.
 */
import type { ApprovalRequest, Subagent } from "@polaris/protocol";
import { approvalDetail } from "../home/model/lines.ts";
import type { SecretOutcome } from "../thread/fold.ts";

const WANTS: Readonly<Record<ApprovalRequest["kind"], string>> = {
  command: "wants to run",
  "file-change": "wants to change files",
  tool: "wants to use a tool",
  question: "has a question",
  secret: "asks for a secret",
};

/** What fits beside Approve and Deny on the narrowest iPhone; longer opens to the whole request. */
export const COMPACT_CHARACTERS = 20;

/** Past this Dynamic Type scale, Approve and Deny go under the request, never beside it. */
export const COMPACT_TEXT_SCALE = 1.25;

/** How much of the screen every open request may take, opened from "+n", before it scrolls. */
export const EXPANDED_SHARE = 0.45;

/** Printable ASCII only: no line breaks, controls, bidi or zero-width marks that hide text. */
const PLAIN = /^[\x20-\x7e]*$/;

export type StripNotice =
  | {
      readonly kind: "approval";
      readonly request: ApprovalRequest;
      /** "Claude Code wants to run"; "A subagent wants to run" when a Subagent asks. */
      readonly headline: string;
      /** The asking Subagent's place among the session's, which picks its moon; null for the lead. */
      readonly moon: number | null;
      /** Every line of the command, file or tool; null when the Harness named none. */
      readonly detail: string | null;
      /** Short plain text: Approve may sit beside it; the view still opens if it wraps. */
      readonly compact: boolean;
    }
  | { readonly kind: "question"; readonly request: ApprovalRequest }
  /** A Secret Request: its masked field, Save securely and Decline; never Approve. */
  | { readonly kind: "secret"; readonly request: ApprovalRequest; readonly headline: string }
  /** Queue offers the typed steer for after this Turn instead (ENG-557). */
  | { readonly kind: "working"; readonly queue: boolean };

export interface Strip {
  /** Null when only a Secret Request's outcome is left to say. */
  readonly notice: StripNotice | null;
  /** Requests behind this one. */
  readonly more: number;
  /** How the latest Turn's Secret Request ended, above the notice once nothing else is asked. */
  readonly settled: SecretOutcome | null;
}

/** Bidi controls and zero-width marks: they reorder or hide what a command really says. */
const HIDDEN_MARKS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/** Names each hidden mark ("⟨U+202E⟩") so the text reads in the order it runs. */
export const revealHidden = (text: string): string =>
  text.replace(
    HIDDEN_MARKS,
    (mark) => `⟨U+${(mark.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`
  );

const fitsOneLine = (text: string) => PLAIN.test(text) && text.length <= COMPACT_CHARACTERS;

/** Who asks: a Subagent, else the Harness by name. */
const askerOf = (request: ApprovalRequest, harness: string) =>
  request.subagentId === null ? harness : "A subagent";

const moonOf = (request: ApprovalRequest, subagents: ReadonlyArray<Subagent>) => {
  const index = subagents.findIndex((subagent) => subagent.id === request.subagentId);

  return request.subagentId === null || index < 0 ? null : index;
};

const noticeOf = (
  request: ApprovalRequest,
  harness: string,
  subagents: ReadonlyArray<Subagent>
): StripNotice => {
  if (request.kind === "question") return { kind: "question", request };
  const asker = askerOf(request, harness);

  if (request.kind === "secret")
    return { kind: "secret", request, headline: `${asker} ${WANTS.secret}` };
  const raw = approvalDetail(request)?.text ?? null;
  const detail = raw === null ? null : revealHidden(raw);

  return {
    kind: "approval",
    request,
    headline: `${asker} ${WANTS[request.kind]}`,
    moon: moonOf(request, subagents),
    detail,
    compact: raw === null || fitsOneLine(raw),
  };
};

/** Every open request as the strip shows it, oldest first. */
export const noticesOf = (
  requests: ReadonlyArray<ApprovalRequest>,
  harness: string,
  subagents: ReadonlyArray<Subagent> = []
): ReadonlyArray<StripNotice> =>
  [...requests]
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
    .map((request) => noticeOf(request, harness, subagents));

/**
 * The strip: requests first, oldest first, whether or not the Turn is still working (a
 * Subagent can ask while the lead works on); Working only when nothing is asked.
 */
export const stripOf = ({
  requests,
  working,
  harness,
  subagents = [],
  settled = null,
  queue = false,
}: {
  readonly requests: ReadonlyArray<ApprovalRequest>;
  readonly working: boolean;
  /** There is a steer typed that could wait for the Turn's end instead. */
  readonly queue?: boolean;
  /** The Harness's name, "Claude Code". */
  readonly harness: string;
  /** The session's Subagents, in the order they started (the control row's moons). */
  readonly subagents?: ReadonlyArray<Subagent>;
  readonly settled?: SecretOutcome | null;
}): Strip | null => {
  const oldest = noticesOf(requests, harness, subagents)[0];

  if (oldest !== undefined) return { notice: oldest, more: requests.length - 1, settled: null };

  if (working) return { notice: { kind: "working", queue }, more: 0, settled };

  return settled === null ? null : { notice: null, more: 0, settled };
};
