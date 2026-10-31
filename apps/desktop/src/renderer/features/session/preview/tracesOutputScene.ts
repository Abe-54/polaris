/**
 * Output's Traces tab (`#preview/traces-output`; Paper T3): "Fix overdue totals" ran the overdue
 * tests in Turn 12, whose traces (Traces' fixtures) list one failure, the slowest and the rest.
 */
import { Turn, TurnId, TurnItem } from "@polaris/protocol";
import type { SessionModel } from "../../../store/sessionModel.ts";
import { FIXTURE_TURNS } from "../../traces/preview/fixtures.ts";
import { model, session, turn, view } from "./fixtures.ts";

const I = TurnItem.cases;

const s = session("s-traces-output", {
  title: "Fix overdue totals",
  harness: "claude",
  state: "idle",
  turnCount: 12,
});

/** Turn `n` (index n − 1) under the id the trace fixtures attribute their spans to. */
const fixtureTurn = (n: 11 | 12, prompt: string) => {
  const t = turn(s.id, n - 1, prompt, "completed");

  return new Turn({
    id: TurnId.make(FIXTURE_TURNS[n].id),
    sessionId: t.sessionId,
    index: t.index,
    prompt: t.prompt,
    attachments: t.attachments,
    model: t.model,
    effort: t.effort,
    status: t.status,
    checkpointBefore: t.checkpointBefore,
    checkpointAfter: t.checkpointAfter,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
  });
};

export const tracesOutput = (): SessionModel =>
  model({
    session: s,
    turns: [
      view(fixtureTurn(11, "Convert each invoice to the reporting currency"), [
        I.AssistantMessage.make({ id: "m11", text: "Totals now convert per invoice." }),
      ]),
      view(fixtureTurn(12, "Run the overdue tests"), [
        I.AssistantMessage.make({
          id: "m12a",
          text: "The totals now convert each invoice to the reporting currency. Running the overdue tests to check.",
        }),
        I.CommandExecution.make({
          id: "c12",
          command: "bun test overdue-totals",
          cwd: s.cwd,
          output: "1 fail, 11 pass\n",
          exitCode: 1,
          status: "completed",
        }),
        I.AssistantMessage.make({
          id: "m12b",
          text: "One test fails and the endpoint went from 122 ms to 840 ms. The trace shows 214 rate lookups in a row; I'll batch them.",
        }),
      ]),
    ],
  });
