/**
 * `request_computer_use`: the one tool a session gets while computer use is Off or NeedsSetup on
 * its Host. It opens a `computer-use` approval and waits until the Host is Ready or the user says
 * Not now; the Engine then reopens the Harness after the Turn, so the next Turn has the tools.
 */
import type { ComputerUseState, SessionId } from "@polaris/protocol";
import { Effect, Match, Option, Schema } from "effect";
import { jsonSchema } from "../../mcp/tools/shared.ts";
import type { Json } from "./catalog.ts";
import { type DesktopResult, failure } from "./envelope.ts";
import { type ComputerUseAsk, ComputerUseOutcome, type RequestComputerUse } from "./service.ts";

export { type ComputerUseAsk, ComputerUseOutcome, type RequestComputerUse } from "./service.ts";

export const REQUEST_TOOL = "request_computer_use";

/** How long the request waits for the user before the Daemon withdraws it. */
export const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

const RequestInput = Schema.Struct({
  app: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(600)),
});

const decodeInput = Schema.decodeUnknownOption(RequestInput);

export const requestInputSchema = jsonSchema(RequestInput);

const whyOff = (state: ComputerUseState, host: string) =>
  Match.value(state).pipe(
    Match.tag("NeedsSetup", () => `Computer use isn't set up on ${host} yet`),
    Match.orElse(() => `Computer use is off on ${host}`)
  );

export const requestDescription = (state: ComputerUseState, host: string) =>
  `${whyOff(state, host)}, so you have no tools to control native apps. When the task needs one (an app the user names, or one with no web version), call this with the app and why: it asks the user to turn computer use on, and waits for them. app is the app's name as the user would say it; reason is one sentence the user reads. For web pages use polaris_browser instead.`;

export const requestInstructions = (state: ComputerUseState, host: string) =>
  `polaris_desktop: ${whyOff(state, host)}. request_computer_use asks the user to turn it on; once on, its tools arrive on your next Turn.`;

const text = (lines: ReadonlyArray<string>): DesktopResult => ({
  content: [{ type: "text", text: lines.join("\n") }],
});

export const outcomeResult = (outcome: ComputerUseOutcome, app: string): DesktopResult =>
  ComputerUseOutcome.$match(outcome, {
    Ready: () =>
      text([
        "Computer use is on now.",
        `polaris_desktop's tools arrive on your next Turn. Do what you can without them, then end this Turn saying what you'll do in ${app}.`,
      ]),
    NotNow: () =>
      text([
        "The user said not now.",
        "Carry on without computer use, and don't ask again unless the user says so.",
      ]),
    TimedOut: () =>
      text([
        `No answer in ${REQUEST_TIMEOUT_MS / 60_000} minutes; the request was withdrawn.`,
        "Do the work that doesn't need it. If you're blocked, end your Turn and say what you need.",
      ]),
    Ended: ({ reason }) => text([`The request ended unanswered: ${reason}.`]),
    NoTurn: () => failure("This session has no Turn in flight to ask on."),
    NotFound: () => failure("This session can't ask for computer use."),
  });

/** One call of the tool: the input checked, the Engine asked, its outcome in words. */
export const callRequest = (
  sessionId: SessionId,
  input: Json,
  request: RequestComputerUse | null,
  ask: (app: string, reason: string) => Omit<ComputerUseAsk, "app" | "reason">
): Effect.Effect<DesktopResult> => {
  const parsed = Option.getOrNull(decodeInput(input));

  if (parsed === null)
    return Effect.succeed(failure(`Invalid input for ${REQUEST_TOOL}: give app and reason.`));

  if (request === null)
    return Effect.succeed(failure("This Host can't ask for computer use right now."));

  return Effect.map(
    request(sessionId, {
      ...ask(parsed.app, parsed.reason),
      app: parsed.app,
      reason: parsed.reason,
    }),
    (outcome) => outcomeResult(outcome, parsed.app)
  );
};
