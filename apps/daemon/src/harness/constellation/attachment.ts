import { Effect } from "effect";
import { ConstellationRejected, ConstellationFinding, type VisualsLevel } from "@polaris/protocol";
import type { McpBinding } from "../../mcp/binding.ts";
import {
  constellationTools,
  errorResult,
  type BoundTool,
  type ConstellationCommands,
  type LeadStarted,
} from "../../mcp/tools.ts";
import { McpTokens } from "../../mcp/tokens.ts";
import { constellationInstructions } from "./skills.ts";

export interface ConstellationAttachment {
  readonly sessionId: McpBinding["sessionId"];
  readonly instructions: string;
  readonly url: string;
  readonly tools: ReadonlyArray<BoundTool>;
  /** The Visuals setting as the session opened (`rich` when absent); `off` drops `visualize`. */
  readonly visuals?: VisualsLevel;
}

const revoked = () =>
  errorResult(
    new ConstellationRejected({
      findings: [
        new ConstellationFinding({
          code: "E-REVOKED",
          message: "This session's Polaris tools were revoked",
          fix: "Continue in the current Attempt or Lead session.",
        }),
      ],
      graph: null,
      revision: 0,
    })
  );

export const attachConstellation = Effect.fn("attachConstellation")(function* (
  binding: McpBinding,
  origin: string,
  commands: ConstellationCommands,
  visuals: VisualsLevel = "rich"
) {
  const tokens = yield* McpTokens;
  const token = yield* tokens.issue(binding);

  const started: LeadStarted = (sessionId, id) => Effect.ignore(tokens.advanceLeads(sessionId, id));

  const options = { visualize: visuals !== "off" };

  // The listed catalog is fixed; each call runs against the binding as it stands now.
  const tools = constellationTools(binding, commands, started, options).map((tool): BoundTool => ({
    ...tool,
    call: async (input, signal) => {
      const current = await Effect.runPromise(tokens.authenticate(token));

      const bound =
        current === null
          ? undefined
          : constellationTools(current, commands, started, options).find(
              (t) => t.name === tool.name
            );

      return bound === undefined ? revoked() : bound.call(input, signal);
    },
  }));

  return {
    sessionId: binding.sessionId,
    instructions: constellationInstructions(binding),
    url: `${origin}/mcp/${token}${visuals === "off" ? "?visuals=off" : ""}`,
    tools,
    visuals,
  } satisfies ConstellationAttachment;
});
