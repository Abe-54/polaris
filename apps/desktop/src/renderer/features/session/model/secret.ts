/**
 * A Secret Request (ADR 0089) as the Desktop App shows it: never approved, only answered with a
 * value on `secret.provide` or declined. Pure, so it is tested.
 */
import { ApprovalRequest, RequestId, SECRET_MAX_BYTES } from "@polaris/protocol";
import { Predicate } from "effect";
import type { IpcError } from "../../../../shared/api.ts";
import type { SecretOutcome, SettledSecret, TurnView } from "../../../store/sessionModel.ts";
import { secretEnding } from "./polarisTools/index.ts";

export const isSecretRequest = (request: Pick<ApprovalRequest, "kind">) =>
  request.kind === "secret";

export type { SecretOutcome } from "../../../store/sessionModel.ts";

export const SECRET_OUTCOME_TEXT: Readonly<Record<SecretOutcome, string>> = {
  provided: "Saved securely and kept private",
  declined: "Declined",
  ended: "Request ended",
};

export const DEFAULT_SECRET_PLACEHOLDER = "Paste the secret";

export const secretPlaceholder = (request: Pick<ApprovalRequest, "placeholder">) =>
  request.placeholder == null || request.placeholder.trim() === ""
    ? DEFAULT_SECRET_PLACEHOLDER
    : request.placeholder;

export const SECRET_FOOTER =
  "Kept out of chat, in a private file this agent's commands can read for 24 hours";

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** What the typed value would send: trimmed, or why it can't be sent (null message: empty). */
export type SecretDraft =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: string | null };

export const secretDraft = (typed: string): SecretDraft => {
  const value = typed.trim();

  if (value === "") return { ok: false, problem: null };

  if (/[\r\n]/.test(value)) return { ok: false, problem: "Use a single line" };

  if (bytes(value) > SECRET_MAX_BYTES) return { ok: false, problem: "The secret is too long" };

  return { ok: true, value };
};

export const SECRET_SAVE_FAILED = "Couldn't save the secret. Try again.";

/** The Host's own words for a refusal it understood; anything else (transport) is generic. */
export const provideFailure = (error: IpcError): string => {
  if (error.code === "NotFound") return "This request has ended, so the secret wasn't saved.";

  return error.code === "SecretRejected" && error.message.trim() !== ""
    ? error.message
    : SECRET_SAVE_FAILED;
};

/** "8m left": the quiet countdown to an unanswered request's timeout; null once due or unset. */
export const secretTimeLeft = (expiresAt: string | null | undefined, now: number) => {
  if (expiresAt == null) return null;
  const ms = Date.parse(expiresAt) - now;

  if (!(ms > 0)) return null;

  return ms < 60_000 ? "under a minute left" : `${Math.ceil(ms / 60_000)}m left`;
};

/** "Claude Code is asking for a secret": every summary of a Secret Request. */
export const askingForSecret = (who: string) => `${who} is asking for a secret`;

/** A session row's or inbox card's line for a Secret Request: the label only, never the reason. */
export const secretLine = (label: string) => `Asking for a secret · ${label}`;

/** The Secret Requests a Turn's finished `request_secret` calls settled, as their cards show them. */
const toolSecrets = ({ turn, items }: TurnView): ReadonlyArray<SettledSecret> =>
  items.flatMap((item) => {
    const ending = Predicate.isTagged(item, "ToolCall") ? secretEnding(item) : null;

    if (ending === null) return [];

    const request = new ApprovalRequest({
      id: RequestId.make(`tool:${item.id}`),
      sessionId: turn.sessionId,
      turnId: turn.id,
      kind: "secret",
      title: ending.label,
      detail: null,
      options: [],
      questions: [],
      openedAt: item.startedAt ?? turn.startedAt,
    });

    return [{ request, outcome: ending.outcome }];
  });

/**
 * Settled Secret Requests: those this feed saw end, then those only the `request_secret` call's
 * reply still records (a reload, ENG-631), skipping a label the feed already settled in that Turn.
 */
export const secretCards = (
  views: ReadonlyArray<TurnView>,
  seen: ReadonlyArray<SettledSecret>
): ReadonlyArray<SettledSecret> => {
  const known = new Set(seen.map(({ request }) => `${request.turnId}\u0000${request.title}`));

  return [
    ...seen,
    ...views
      .flatMap(toolSecrets)
      .filter(({ request }) => !known.has(`${request.turnId}\u0000${request.title}`)),
  ];
};
