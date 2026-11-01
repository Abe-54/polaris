import { ApprovalRequest, RequestId, TurnItem } from "@polaris/protocol";
import type { SessionModel } from "../../../store/sessionModel.ts";
import { ago, model, session, turn, view } from "./fixtures.ts";

/** The existing approval card with the inspector's exact process, duration and risk. */
export const profileAttach = (): SessionModel => {
  const current = session("s-profile-attach", {
    title: "Profile the ledger API",
    harness: "codex",
    state: "needs-you",
    turnCount: 3,
  });

  const now = turn(current.id, 3, "Find the slow function in the ledger API", "working");

  return model({
    session: current,
    turns: [
      view(now, [
        TurnItem.cases.AssistantMessage.make({
          id: "profile-request",
          text: "I can record five seconds of the running Node process after you approve the inspector access.",
        }),
      ]),
    ],
    pendingApprovals: [
      new ApprovalRequest({
        id: RequestId.make("profile-attach-preview"),
        sessionId: current.id,
        turnId: now.id,
        kind: "tool",
        title: "Profile Node process 28416 for 5 s",
        detail:
          "node services/ledger-api/server.mjs\npid 28416 · Node · profile for 5 s\nwhile attached, any local process can run code in it",
        profileAttach: {
          pid: 28416,
          command: "node services/ledger-api/server.mjs",
          runtime: "node",
          seconds: 5,
        },
        options: [],
        questions: [],
        openedAt: ago(10),
      }),
    ],
  });
};
