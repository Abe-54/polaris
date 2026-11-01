/**
 * Notification categories and answers from them. An approval push offers Approve, Always here
 * and Deny behind Face ID; the answer is a RespondToApproval on the Host the push came from.
 */
import { ApprovalDecision, Command, CommandId, RequestId, SessionId } from "@polaris/protocol";
import { Option, Schema } from "effect";
import type { Route } from "../app/route.ts";

export const PushAction = {
  approve: "polaris.approve",
  always: "polaris.always-here",
  deny: "polaris.deny",
} as const;

interface CategoryAction {
  readonly identifier: string;
  readonly buttonTitle: string;
  readonly options: {
    readonly isDestructive: boolean;
    readonly isAuthenticationRequired: boolean;
    readonly opensAppToForeground: boolean;
  };
}

/** Answered without opening the app, and only after Face ID or the passcode. */
const action = (
  identifier: string,
  buttonTitle: string,
  isDestructive = false
): CategoryAction => ({
  identifier,
  buttonTitle,
  options: { isDestructive, isAuthenticationRequired: true, opensAppToForeground: false },
});

/** The categories the Notification Service Extension sets (PushMessage's `category`). */
export const PUSH_CATEGORIES: ReadonlyArray<{
  readonly identifier: string;
  readonly actions: ReadonlyArray<CategoryAction>;
}> = [
  {
    identifier: "approval",
    actions: [
      action(PushAction.approve, "Approve"),
      action(PushAction.always, "Always here"),
      action(PushAction.deny, "Deny", true),
    ],
  },
  {
    identifier: "approval-once",
    actions: [action(PushAction.approve, "Approve"), action(PushAction.deny, "Deny", true)],
  },
  // A question needs its choices, so it opens the app.
  { identifier: "question", actions: [] },
];

export const decisionOf = (actionId: string): ApprovalDecision | null => {
  switch (actionId) {
    case PushAction.approve:
      return ApprovalDecision.cases.Allow.make({ remember: false });
    case PushAction.always:
      return ApprovalDecision.cases.Allow.make({ remember: true });
    case PushAction.deny:
      return ApprovalDecision.cases.Deny.make({ reason: null });
    default:
      return null;
  }
};

/** What the extension put in the notification's userInfo under `polaris`. */
const PushTarget = Schema.Struct({
  polaris: Schema.Struct({
    kind: Schema.Literals(["needs-you", "turn-ended", "notify"]),
    hostId: Schema.String,
    sessionId: SessionId,
    requestId: Schema.NullOr(RequestId),
    /** A `notify` about a Constellation: a tap opens it. */
    constellationId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

const decodeTarget = Schema.decodeUnknownOption(PushTarget);

export interface PushResponse {
  readonly actionIdentifier: string;
  /** The category the extension set; only approval categories answer, so a secret's push never does. */
  readonly category: string | null;
  /** The notification's userInfo, as expo-notifications reports it (data, or the push payload). */
  readonly userInfo: ReadonlyArray<unknown>;
}

export interface Answer {
  readonly hostId: string;
  readonly dispatch: { readonly commandId: CommandId; readonly command: Command };
}

const targetOf = (response: PushResponse) =>
  Option.firstSomeOf(response.userInfo.map((info) => decodeTarget(info)));

/** What tapping the notification itself opens (iOS's default action). */
export const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

/** The screen a tap opens: its Constellation for one about a Constellation, else its session. */
export const routeOf = (response: PushResponse): Route | null => {
  if (response.actionIdentifier !== DEFAULT_ACTION) return null;
  const target = targetOf(response);

  if (Option.isNone(target)) return null;
  const { hostId, sessionId, constellationId } = target.value.polaris;

  return constellationId === undefined || constellationId === null
    ? { screen: "thread", hostId, sessionId }
    : { screen: "constellation", hostId, constellationId };
};

/** The answer an action asks for, or null for a tap or a push that isn't an approval. */
export const answerOf = (response: PushResponse): Answer | null => {
  const decision = decisionOf(response.actionIdentifier);

  if (
    decision === null ||
    (response.category !== "approval" && response.category !== "approval-once")
  )
    return null;

  if (response.category === "approval-once" && response.actionIdentifier === PushAction.always)
    return null;

  const target = targetOf(response);

  if (Option.isNone(target) || target.value.polaris.requestId === null) return null;
  const { hostId, sessionId, requestId } = target.value.polaris;

  return {
    hostId,
    dispatch: {
      // One command per request: a response seen twice (listener and cold start) is one answer.
      commandId: CommandId.make(`push-answer:${hostId}:${requestId}`),
      command: Command.cases.RespondToApproval.make({ sessionId, requestId, decision }),
    },
  };
};
