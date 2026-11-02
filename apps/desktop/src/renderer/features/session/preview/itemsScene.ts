/**
 * The T-ITEMS scene: Constellation tool calls, an image a tool showed, a long
 * command and a silent one.
 */
import { TurnItem } from "@polaris/protocol";
import type { SessionModel } from "../../../store/sessionModel.ts";
import type { ToolInput } from "../model/items.ts";
import { model, session, turn, view } from "./fixtures.ts";

const I = TurnItem.cases;

/** T-ITEMS: Constellation tool calls, an image a tool showed, a long command and a silent one. */
export const items = (): SessionModel => {
  const s = session("s-items", { title: "Claim the session rows task" });

  const tool = (id: string, name: string, input: ToolInput) =>
    I.ToolCall.make({ id, name, input, output: null, status: "completed" });

  return model({
    session: s,
    turns: [
      view(turn(s.id, 11, "Finish the rows and claim A2", "working"), [
        tool("k1", "mcp__polaris__status", {}),
        tool("k2", "mcp__polaris__progress", { task: "A2", text: "Rows at 32px" }),
        tool("i1", "view_image", { path: "screens/rows-dark.png" }),
        I.CommandExecution.make({
          id: "c11",
          command:
            "bun run --cwd apps/desktop scripts/sessionScreens.ts --out ../../.dagr/evidence/rows --scenes session,approval,question,interrupted --densities calm,balanced,compact",
          cwd: s.cwd,
          output: "",
          exitCode: 0,
          status: "completed",
        }),
        I.AssistantMessage.make({
          id: "m11",
          text: "Rows are **32px** in calm and balanced, 28px in compact. Both themes checked: [light](screens/rows-light.png), and [the gallery](screens/index.html).\n\n![Compact rows](screens/rows-compact.png)",
        }),
        tool("k3", "polaris.claim", { task: "A2" }),
      ]),
    ],
  });
};
