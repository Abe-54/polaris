/** `visualize` (ENG-597, ADR 0101): every binding shows the user a Visualization in its session. */
import { ConstellationFinding, type SessionId } from "@polaris/protocol";
import {
  type VisualizationProblem,
  type VisualizeResult,
  VISUALIZE_TOOL_DESCRIPTION,
  VisualizeInput,
  validateVisualization,
} from "@polaris/visualization";
import { Effect, Schema } from "effect";
import type { VisualizationLog } from "../tokens.ts";
import { jsonSchema, type BoundTool, type McpToolResult } from "./shared.ts";

const finding = (code: string, message: string, fix: string) =>
  new ConstellationFinding({ code, message, fix });

const refused = (findings: ReadonlyArray<ConstellationFinding>): McpToolResult => ({
  isError: true,
  structuredContent: { findings, graph: null, revision: 0 },
  content: [
    {
      type: "text",
      text: [
        ...findings.map((item) => `${item.code}: ${item.message}\nFix: ${item.fix}`),
        "Next: Fix these and call visualize again.",
      ].join("\n"),
    },
  ],
});

const problemFinding = (problem: VisualizationProblem) =>
  finding(`E-VISUAL-${problem.rule.toUpperCase()}`, problem.message, problem.fix);

const INPUT = finding(
  "E-INPUT",
  "Invalid input for visualize",
  "Send title and html as strings, and replaces only as an id an earlier visualize call returned."
);

const UNKNOWN_REPLACES = (id: string) =>
  finding(
    "E-VISUAL-REPLACES",
    `replaces names ${JSON.stringify(id)}, which no earlier Visualization in this session has`,
    "Use the id an earlier visualize call in this session returned, or leave replaces out to show a new one."
  );

const UNRECORDED = finding(
  "E-VISUAL-STORE",
  "The Visualization couldn't be recorded",
  "Call visualize again."
);

const encoder = new TextEncoder();

/** In memory, for catalogs no Daemon attached a log to (tests, the eval). */
export const memoryVisualizations = (): VisualizationLog => {
  const shown = new Set<string>();

  return {
    record: (sessionId, id) => Effect.sync(() => void shown.add(`${sessionId}\n${id}`)),
    shown: (sessionId, id) => Effect.sync(() => shown.has(`${sessionId}\n${id}`)),
  };
};

/** The id is minted here and returned to the agent; a later call's `replaces` names it. */
export const visualizeTool = (sessionId: SessionId, log: VisualizationLog): BoundTool => {
  const show = (input: VisualizeInput) =>
    Effect.gen(function* () {
      const problems = validateVisualization(input);

      if (problems.length > 0) return refused(problems.map(problemFinding));

      if (input.replaces !== undefined && !(yield* log.shown(sessionId, input.replaces)))
        return refused([UNKNOWN_REPLACES(input.replaces)]);

      const result: VisualizeResult = {
        id: `viz_${crypto.randomUUID()}`,
        title: input.title,
        bytes: encoder.encode(input.html).byteLength,
      };

      yield* log.record(sessionId, result.id);

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      } satisfies McpToolResult;
    }).pipe(Effect.catchTag("McpTokenError", () => Effect.succeed(refused([UNRECORDED]))));

  return {
    name: "visualize",
    description: VISUALIZE_TOOL_DESCRIPTION,
    inputSchema: jsonSchema(VisualizeInput),
    // It only shows the user a page: nothing in the Workspace or beyond the Host changes.
    annotations: { readOnlyHint: true, openWorldHint: false },
    call: (input) =>
      Effect.runPromise(
        Schema.decodeUnknownEffect(VisualizeInput)(input, { onExcessProperty: "error" }).pipe(
          Effect.matchEffect({
            onFailure: () => Effect.succeed(refused([INPUT])),
            onSuccess: show,
          })
        )
      ),
  };
};
