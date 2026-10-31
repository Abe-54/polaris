/** A Data Source Approval waiting in the conversation (`#preview/data-approval`). */
import { TurnItem } from "@polaris/protocol";
import type { SessionModel } from "../../../store/sessionModel.ts";
import { fixtureDataApproval } from "../../data/preview/fixtures.ts";
import { ago, model, session, turn, view } from "./fixtures.ts";

const I = TurnItem.cases;

export const dataApproval = (): SessionModel => {
  const s = session("s-backfill-currency", {
    title: "Backfill currency",
    harness: "codex",
    state: "needs-you",
    turnCount: 5,
  });

  const now = turn(
    s.id,
    5,
    "Check the analytics events for invoices without a currency",
    "working"
  );

  return model({
    session: s,
    turns: [
      view(now, [
        I.AssistantMessage.make({
          id: "m5",
          text: "The events live in the analytics database on PlanetScale. Reading them needs your approval.",
        }),
        I.ToolCall.make({
          id: "t5",
          name: "mcp__polaris__data_query",
          input: { source: "analytics", sql: "select count(*) from events where currency is null" },
          output: null,
          status: "running",
        }),
      ]),
    ],
    pendingApprovals: [fixtureDataApproval(s.id, now.id, ago(40))],
  });
};
