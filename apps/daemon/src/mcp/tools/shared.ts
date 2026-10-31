import {
  CommandId,
  ConstellationFinding,
  ConstellationGraphSlice,
  ConstellationRejected,
  type ConstellationCommand,
  type ConstellationResult,
  type ConstellationId,
} from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";
import type { SessionBinding } from "../binding.ts";
import { CallCommandId, RequestId, splitRequestId, type Idempotency } from "./idempotency.ts";

export interface ConstellationCommands {
  readonly command: (
    binding: SessionBinding,
    id: CommandId,
    command: ConstellationCommand
  ) => Effect.Effect<ConstellationResult, ConstellationRejected>;
  readonly status: (
    binding: SessionBinding,
    id: ConstellationId,
    json: boolean
  ) => Effect.Effect<ConstellationResult, ConstellationRejected>;
  /** Resolve friendly names against the caller's Constellation and Host catalog. */
  readonly resolve: (
    binding: SessionBinding,
    id: ConstellationId,
    kind: "attempt" | "session" | "host" | "model",
    name: string
  ) => Effect.Effect<string, ConstellationRejected>;
}

/** Where a Lead's `plan` start goes, and what follows a successful start. */
export interface StartTarget {
  readonly constellationId: ConstellationId;
  readonly started: Effect.Effect<void>;
}

/** Moves a closed Lead binding onto the Constellation it started (`McpTokens.advanceLeads`). */
export type LeadStarted = (
  sessionId: SessionBinding["sessionId"],
  constellationId: ConstellationId
) => Effect.Effect<void>;

export interface McpToolResult {
  readonly content: Array<{ type: "text"; text: string }>;
  readonly isError?: boolean;
  readonly structuredContent?: {
    readonly findings?: ReadonlyArray<ConstellationFinding>;
    readonly graph?: ConstellationRejected["graph"];
    readonly revision?: number;
    readonly [key: string]:
      | typeof Schema.Json.Type
      | ReadonlyArray<ConstellationFinding>
      | ConstellationRejected["graph"]
      | undefined;
  };
}

export interface BoundTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ReturnType<typeof Schema.toJsonSchemaDocument>["schema"];
  readonly call: (input: typeof Schema.Json.Type, signal?: AbortSignal) => Promise<McpToolResult>;
  /** MCP tool annotations; `readOnlyHint` lets a Harness run the tool unasked, in plan mode too. */
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export const rejection = (code: string, message: string, fix: string) =>
  new ConstellationRejected({
    findings: [new ConstellationFinding({ code, message, fix })],
    graph: null,
    revision: 0,
  });

export const graphSlice = (result: ConstellationResult) =>
  result.constellation === null
    ? null
    : new ConstellationGraphSlice({
        constellationId: result.constellation.id,
        revision: result.revision,
        tasks: result.constellation.tasks,
        attempts: result.constellation.attempts,
        projections: result.projections,
      });

const resultText = (
  result: ConstellationResult,
  json: boolean,
  summary?: string,
  next?: string
): McpToolResult => ({
  content: [
    {
      type: "text",
      text: `${summary ?? result.summary}\nRevision: ${result.revision}\n${json ? `${JSON.stringify({ constellation: result.constellation, projections: result.projections, proposals: result.proposals })}\n` : ""}Next: ${next ?? result.next}`,
    },
  ],
});

export const errorResult = (error: ConstellationRejected): McpToolResult => ({
  isError: true,
  structuredContent: { findings: error.findings, graph: error.graph, revision: error.revision },
  content: [
    {
      type: "text",
      text: [
        ...error.findings.map(
          (finding) => `${finding.code}: ${finding.message}\nFix: ${finding.fix}`
        ),
        `Revision: ${error.revision}`,
        "Next: Apply these fixes and retry; read status if the graph changed.",
      ].join("\n"),
    },
  ],
});

export const jsonSchema = (schema: Schema.Constraint) => {
  const document = Schema.toJsonSchemaDocument(schema);

  return { ...document.schema, $defs: document.definitions };
};

const requestIdSchema = Schema.toJsonSchemaDocument(RequestId).schema;

const WithProperties = Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) });

const propertiesOf = (schema: ReturnType<typeof jsonSchema>) =>
  Option.match(Schema.decodeUnknownOption(WithProperties)(schema), {
    onNone: () => ({}),
    onSome: ({ properties }) => properties,
  });

/** A mutating tool's schema also takes `requestId`, the call's idempotency key. */
export const withRequestId = (schema: ReturnType<typeof jsonSchema>) => ({
  ...schema,
  properties: {
    ...propertiesOf(schema),
    requestId: requestIdSchema,
  },
});

export const inputRejection = (name: string) =>
  rejection("E-INPUT", `Invalid input for ${name}`, "Use the fields in this tool's input schema.");

/** Who calls, and the ids their mutating calls commit under. */
export interface ToolCaller {
  readonly sessionId: SessionBinding["sessionId"];
  readonly ids: Idempotency;
}

export const toolFactory = (
  read: () => Effect.Effect<ConstellationResult, ConstellationRejected>,
  caller?: ToolCaller
) => {
  const contextualize = (error: ConstellationRejected) => {
    if (error.graph !== null || error.revision !== 0) return Effect.succeed(errorResult(error));

    return read().pipe(
      Effect.map((current) =>
        errorResult(
          new ConstellationRejected({
            findings: error.findings,
            graph: graphSlice(current),
            revision: current.revision,
          })
        )
      ),
      Effect.catchTag("ConstellationRejected", () => Effect.succeed(errorResult(error)))
    );
  };

  /** The call's command id, from its key and input; forgotten again if the call is rejected. */
  const keyed = <A>(
    name: string,
    input: typeof Schema.Json.Type,
    run: (rest: typeof Schema.Json.Type) => Effect.Effect<A, ConstellationRejected>
  ) =>
    splitRequestId(input).pipe(
      Effect.mapError(() => inputRejection(name)),
      Effect.flatMap(({ requestId, rest }) => {
        if (caller === undefined) return run(rest);
        const call = caller.ids.begin(caller.sessionId, name, requestId, rest);

        return run(rest).pipe(
          Effect.provideService(CallCommandId, call.id),
          Effect.tapError(() => Effect.sync(call.rejected))
        );
      })
    );

  return <S extends Schema.Decoder<unknown>>(
    name: string,
    description: string,
    schema: S,
    execute: (input: S["Type"]) => Effect.Effect<ConstellationResult, ConstellationRejected>,
    options: {
      readonly json?: (input: S["Type"]) => boolean;
      readonly summary?: string;
      readonly next?: string;
      /** It commits a command: it takes a `requestId` and a retry never acts twice. */
      readonly mutates?: boolean;
    } = {}
  ): BoundTool => {
    const run = (input: typeof Schema.Json.Type) =>
      Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => inputRejection(name)),
        Effect.flatMap((decoded) =>
          execute(decoded).pipe(
            Effect.map((result) =>
              resultText(result, options.json?.(decoded) ?? false, options.summary, options.next)
            )
          )
        )
      );

    return {
      name,
      description,
      inputSchema:
        options.mutates === true ? withRequestId(jsonSchema(schema)) : jsonSchema(schema),
      call: (input) =>
        Effect.runPromise(
          (options.mutates === true ? keyed(name, input, run) : run(input)).pipe(
            Effect.catchTag("ConstellationRejected", contextualize)
          )
        ),
    };
  };
};
