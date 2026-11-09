/**
 * What Requests' states say (DESIGN.md, Requests → States; Paper Q3): a Send that got no
 * response, and the prompt that asks an agent for the checkout's Requests. Pure.
 */
import type { Send, SendOutcome } from "@polaris/protocol";
import { Match } from "effect";

/** The Sends with no response to show: the send pane shows `SendFailure` for them. */
export type FailedOutcome = Extract<SendOutcome, "refused" | "timeout" | "failed" | "denied">;

export const isFailedSend = (send: Send): send is Send & { readonly outcome: FailedOutcome } =>
  send.outcome === "refused" ||
  send.outcome === "timeout" ||
  send.outcome === "failed" ||
  send.outcome === "denied";

/** "localhost:4000": the address the Send went to, the scheme left out. */
export const sendAddress = (url: string) => {
  try {
    const parsed = new URL(url);

    return parsed.port === "" ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
  } catch {
    return url;
  }
};

export const failureTitle = (outcome: FailedOutcome) =>
  Match.value(outcome).pipe(
    Match.when("refused", () => "Connection refused"),
    Match.when("timeout", () => "Timed out"),
    Match.when("denied", () => "Not sent: origin denied"),
    Match.when("failed", () => "Couldn’t send"),
    Match.exhaustive
  );

/** The error code the FROM row names, as the Host's network stack would. */
export const failureCode = (outcome: FailedOutcome) =>
  Match.value(outcome).pipe(
    Match.when("refused", () => "ECONNREFUSED"),
    Match.when("timeout", () => "ETIMEDOUT"),
    Match.when("denied", () => "origin approval denied"),
    Match.when("failed", () => null),
    Match.exhaustive
  );

/** The `{{base}}` the URL came from, when the Request says, for "or check {{base}} in env dev". */
export interface SendSource {
  readonly variable: string | null;
  readonly environment: string | null;
}

/** The URL's leading `{{variable}}`, if it starts with one. */
export const leadingVariable = (url: string): string | null =>
  /^\{\{\s*([^}\s]+)\s*\}\}/.exec(url)?.[1] ?? null;

export const WRITE_REQUESTS_PROMPT = [
  "Write .http files for this app's routes under http/, one file per area of the app,",
  "each request named with `### name`, with the origin as `{{base}}` from http-client.env.json",
  "(add a dev environment there if it's missing) and secrets as `{{$dotenv NAME}}`, never inline.",
  "Then send one read request through Polaris to check the files parse and the app answers.",
].join(" ");
