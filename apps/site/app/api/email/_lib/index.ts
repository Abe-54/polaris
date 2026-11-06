import { errorInfo, type Background, type Level, type WideEvent } from "../../../../lib/log";
import type { EmailTransport } from "./transport";
import type { BotCheck } from "./bot";
import type { Admission } from "./limiter";
import { Option } from "effect";
import {
  decodeEmailValidationError,
  EmailValidationError,
  unavailableValidator,
  type EmailValidator,
  type ValidationFailure,
} from "./validator";
import { readSubmission, validEmail } from "./validation";

type Dependencies = {
  checkBot: BotCheck;
  validator?: EmailValidator;
  transport: () => EmailTransport | null;
  admit: (headers: Headers, email: string) => Promise<Admission>;
  /** Lifts the recipient's cooldown after our side failed to validate or send. */
  release?: (email: string) => Promise<void>;
  /** `shared` when the deployment-wide store is configured, recorded on every event. */
  limiter?: "shared" | "local";
  /** Whether this deployment only previews email; constant per deployment, never per request. */
  preview: boolean;
  /** Names of missing or invalid settings, recorded when the transport is unavailable. */
  configProblems?: () => readonly string[];
};

/** The one public reply to every well-formed submission, whatever happens to it. */
export const ACKNOWLEDGEMENT =
  "Check your inbox for the Mac download. Not there? Download it on your Mac at polaris.lux.dev.";

function reply(status: number, message: string) {
  return Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });
}

function acknowledge(preview: boolean) {
  return Response.json(
    { message: ACKNOWLEDGEMENT },
    {
      status: 202,
      headers: { "Cache-Control": "no-store", "X-Polaris-Email-Preview": preview ? "1" : "0" },
    }
  );
}

/** Bot detection first; any detection failure fails closed. */
async function botGate(checkBot: BotCheck, request: Request, event: WideEvent) {
  try {
    const verification = await checkBot(request);

    if (verification.isVerifiedBot) event.bot = "verified_bot";
    else event.bot = verification.isBot ? "bot" : "human";

    if (verification.isBot || verification.isVerifiedBot)
      return reply(403, "This request was blocked. Please try again from your browser.");
  } catch (error) {
    event.bot = "unavailable";
    event.failure = "botid_unavailable";
    event.error = errorInfo(error);

    return reply(503, "Email is unavailable. Please try again later.");
  }

  return null;
}

function requestGate(request: Request, event: WideEvent) {
  const origin = request.headers.get("origin");
  const publicUrl = new URL(request.url);
  const host = request.headers.get("host");

  // Next can normalize the internal URL to localhost in development; Host is the browser's authority.
  if (host) publicUrl.host = host;

  if (origin && origin !== publicUrl.origin) {
    event.rejection = "origin_mismatch";

    return reply(403, "Send this form from the Polaris site.");
  }

  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    event.rejection = "content_type";

    return reply(415, "Send the email form as JSON.");
  }

  return null;
}

/** What each failure records as the event's `validation`; the rest are `unavailable` errors. */
const verdictOutcomes: Partial<Record<ValidationFailure, "uncertain" | "invalid">> = {
  uncertain: "uncertain",
  rejected: "invalid",
};

function validationFailure(failure: EmailValidationError, event: WideEvent): Level {
  const verdict = verdictOutcomes[failure.reason];
  event.validation = verdict ?? "unavailable";
  event.failure = `validation_${failure.reason}`;

  if (failure.cause_info) event.error = failure.cause_info;

  return verdict ? "info" : "error";
}

/** `retry` only when our side failed before a verdict or a send, so the cooldown is lifted. */
type Delivery = { level: Level; retry: boolean };

const held = (level: Level): Delivery => ({ level, retry: false });

const retryable = (level: Level): Delivery => ({ level, retry: true });

/** Failures that reached no verdict on the address; any reply judging it holds the cooldown. */
const noVerdict = new Set<ValidationFailure>(["unconfigured", "provider"]);

async function deliver(
  deps: Dependencies,
  validator: EmailValidator,
  email: string,
  event: WideEvent
): Promise<Delivery> {
  try {
    const accepted = await validator.validate(email, (verdicts) => Object.assign(event, verdicts));
    event.validation = accepted ? "accepted" : "invalid";

    if (!accepted) return held("info");
  } catch (error) {
    const failure = Option.getOrElse(
      decodeEmailValidationError(error),
      () => new EmailValidationError("provider", errorInfo(error))
    );

    const level = validationFailure(failure, event);

    return noVerdict.has(failure.reason) ? retryable(level) : held(level);
  }

  const sender = deps.transport();

  if (!sender) {
    event.failure = "email_unconfigured";
    event.missing_config = deps.configProblems?.() ?? [];

    return retryable("error");
  }

  try {
    await sender.send(email);
  } catch (error) {
    event.failure = "send_failed";
    event.error = errorInfo(error);

    return retryable("error");
  }

  event.delivery = sender.preview ? "preview" : "sent";

  return held("info");
}

async function releaseCooldown(deps: Dependencies, email: string, event: WideEvent) {
  try {
    await deps.release?.(email);
  } catch {
    event.cooldown_release = "failed";
  }
}

/** Limits, validation and sending; runs after the reply, so none of it shapes the response. */
async function admitAndDeliver(
  deps: Dependencies,
  validator: EmailValidator,
  headers: Headers,
  email: string,
  event: WideEvent
): Promise<Level> {
  let admission: Admission;

  try {
    admission = await deps.admit(headers, email);
  } catch (error) {
    event.failure = "limiter_unavailable";
    event.error = errorInfo(error);

    return "error";
  }

  if (admission !== "admitted") {
    event.rejection = admission;

    // The deployment-wide ceiling refuses everyone, so it raises the event for alerting.
    return admission === "total_limited" ? "error" : "info";
  }

  const { level, retry } = await deliver(deps, validator, email, event);

  if (retry) await releaseCooldown(deps, email, event);

  return level;
}

/**
 * Every well-formed submission gets the same 202 before any limit, validation or send,
 * so the response says nothing about the address; the event records what happened.
 */
export function createEmailHandler(deps: Dependencies) {
  const validator = deps.validator ?? unavailableValidator;

  return async (request: Request, event: WideEvent, background: Background): Promise<Response> => {
    if (deps.limiter) event.limiter = deps.limiter;
    const blocked = (await botGate(deps.checkBot, request, event)) ?? requestGate(request, event);

    if (blocked) return blocked;

    let submission;

    try {
      submission = await readSubmission(request);
    } catch {
      event.rejection = "unreadable_body";

      return reply(400, "Enter a valid email address.");
    }

    if (submission.website !== "") {
      event.rejection = "honeypot";

      return acknowledge(deps.preview);
    }

    if (!validEmail(submission.email)) {
      event.rejection = "invalid_syntax";

      return reply(400, "Enter a valid email address.");
    }

    const headers = new Headers(request.headers);
    const { email } = submission;
    background(() => admitAndDeliver(deps, validator, headers, email, event));

    return acknowledge(deps.preview);
  };
}
