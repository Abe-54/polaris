/**
 * The composer's floating notice strip (Paper MX-E, MX-D's strip): the oldest open request,
 * with the rest behind "+n", else Working while a Turn runs. Nothing to know, no strip.
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { approvalDetail } from "../home/model/lines.ts";
import type { SecretOutcome } from "../thread/fold.ts";

const WANTS: Readonly<Record<ApprovalRequest["kind"], string>> = {
  command: "wants to run",
  "file-change": "wants to change files",
  tool: "wants to use a tool",
  question: "has a question",
  secret: "asks for a secret",
  app: "wants to use an app",
  "headed-input": "wants headed input",
  "computer-use": "wants computer use",
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
      /** "Claude Code wants to run". */
      readonly headline: string;
      /** Every line of the command, file or tool; null when the Harness named none. */
      readonly detail: string | null;
      /** Short plain text: Approve may sit beside it; the view still opens if it wraps. */
      readonly compact: boolean;
    }
  | { readonly kind: "question"; readonly request: ApprovalRequest }
  /** A Secret Request: its masked field, Save securely and Decline; never Approve. */
  | { readonly kind: "secret"; readonly request: ApprovalRequest; readonly headline: string }
  | { readonly kind: "working" };

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

const noticeOf = (request: ApprovalRequest, harness: string): StripNotice => {
  if (request.kind === "question") return { kind: "question", request };

  if (request.kind === "secret")
    return { kind: "secret", request, headline: `${harness} ${WANTS.secret}` };
  const raw = approvalDetail(request)?.text ?? null;
  const detail = raw === null ? null : revealHidden(raw);

  return {
    kind: "approval",
    request,
    headline: `${harness} ${WANTS[request.kind]}`,
    detail,
    compact: raw === null || fitsOneLine(raw),
  };
};

/** Every open request as the strip shows it, oldest first. */
export const noticesOf = (
  requests: ReadonlyArray<ApprovalRequest>,
  harness: string
): ReadonlyArray<StripNotice> =>
  [...requests]
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
    .map((request) => noticeOf(request, harness));

/**
 * The strip: requests first, oldest first, whether or not the Turn is still working (a
 * Subagent can ask while the lead works on); Working only when nothing is asked.
 */
export const stripOf = ({
  requests,
  working,
  harness,
  settled = null,
}: {
  readonly requests: ReadonlyArray<ApprovalRequest>;
  readonly working: boolean;
  /** The Harness's name, "Claude Code". */
  readonly harness: string;
  readonly settled?: SecretOutcome | null;
}): Strip | null => {
  const oldest = noticesOf(requests, harness)[0];

  if (oldest !== undefined) return { notice: oldest, more: requests.length - 1, settled: null };

  if (working) return { notice: { kind: "working" }, more: 0, settled };

  return settled === null ? null : { notice: null, more: 0, settled };
};
