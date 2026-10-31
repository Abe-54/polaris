/** Data tools bind checkout, Turn and credentials to the authenticated Agent Session. */
import { DescribeData, QueryData, type RequestId, type SessionId } from "@polaris/protocol";
import { Clock, Effect, Match, Option, Schema, type Redacted } from "effect";
import type { DataSessionTools } from "../sessions/data.ts";
import type { SessionTools } from "../sessions/index.ts";
import { cappedLines, describeView, queryView, safeDataText, sourcesView } from "./dataFormat.ts";
import { text } from "./session.ts";
import { jsonSchema, type BoundTool, type McpToolResult } from "./shared.ts";

const DescribeInput = Schema.Struct({
  source: DescribeData.payloadSchema.fields.source,
  table: DescribeData.payloadSchema.fields.table,
  sample: DescribeData.payloadSchema.fields.sample,
});

const QueryInput = Schema.Struct({
  source: QueryData.payloadSchema.fields.source,
  sql: QueryData.payloadSchema.fields.sql,
  params: QueryData.payloadSchema.fields.params,
  limit: QueryData.payloadSchema.fields.limit,
});

const failure = (code: string, message: string, fix: string): McpToolResult => ({
  isError: true,
  ...text([`${code}: ${message}`, `Fix: ${fix}`]),
  structuredContent: { code, message, fix },
});

const pending = (
  source: string,
  approvalId: string,
  known: Parameters<typeof safeDataText>[1] = []
): McpToolResult => ({
  ...text([
    `Waiting for the user to approve ${safeDataText(source, known)} in this conversation; call again after they answer`,
  ]),
  structuredContent: { pending: true, approvalId: safeDataText(approvalId, known) },
});

type Failure = Effect.Error<ReturnType<DataSessionTools["describe"]>>;

/** Keep the statement's 30 s timeout plus 5 s headroom within the 60 s MCP budget. */
export const withDataApproval = <A>(
  run: Effect.Effect<A, Failure> | ((approvalId?: RequestId) => Effect.Effect<A, Failure>),
  data: DataSessionTools,
  render: (value: A) => McpToolResult,
  sessionId: SessionId,
  started: number,
  known: Parameters<typeof safeDataText>[1] = []
) => {
  const attempt = Effect.isEffect(run) ? () => run : run;

  return attempt().pipe(
    Effect.map(render),
    Effect.catchTag("DataApprovalRequired", (required) =>
      Effect.gen(function* () {
        const remaining = 55_000 - ((yield* Clock.currentTimeMillis) - started);

        const outcome = yield* data.awaitApproval(
          required.approvalId,
          Math.max(0, remaining),
          sessionId
        );

        return yield* Match.value(outcome).pipe(
          Match.when({ status: "pending" }, () =>
            Effect.succeed(pending(required.sourceName, required.approvalId, known))
          ),
          Match.when({ status: "denied" }, ({ reason }) =>
            Effect.succeed(
              failure("E-DATA-DENIED", safeDataText(reason, known), "Don't retry; ask the user.")
            )
          ),
          Match.when({ status: "approved" }, () =>
            Effect.gen(function* () {
              if (60_000 - ((yield* Clock.currentTimeMillis) - started) < 35_000)
                return {
                  ...text(["Approved; call query again to run with a fresh timeout."]),
                  structuredContent: { approved: true },
                };

              return yield* attempt(required.approvalId).pipe(
                Effect.map(render),
                Effect.catchTag("DataApprovalRequired", (again) =>
                  Effect.succeed(pending(again.sourceName, again.approvalId, known))
                )
              );
            })
          ),
          Match.exhaustive
        );
      })
    )
  );
};

const handle = (error: Failure, known: Parameters<typeof safeDataText>[1] = []) =>
  Match.value(error).pipe(
    Match.tag("DataError", (error) =>
      failure(error.code, safeDataText(error.message, known), safeDataText(error.fix, known))
    ),
    Match.tag("Unsupported", () =>
      failure(
        "E-NOT-READY",
        "Data isn't connected on this host",
        "The user can check it in Data (⌘4)."
      )
    ),
    Match.tag("NotFound", () =>
      failure(
        "E-SESSION",
        "This agent session isn't on this host",
        "Call from an agent session on this host."
      )
    ),
    Match.tag("DataApprovalRequired", (error) =>
      pending(error.sourceName, error.approvalId, known)
    ),
    Match.exhaustive
  );

export const dataTools = (sessionId: SessionId, sessions: SessionTools): BoundTool[] => {
  const make = <S extends Schema.Decoder<unknown>>(
    name: string,
    description: string,
    schema: S,
    run: (
      input: S["Type"],
      data: DataSessionTools,
      started: number
    ) => Effect.Effect<McpToolResult, Failure>
  ): BoundTool => ({
    name,
    description,
    inputSchema:
      name === "data_sources" ? { ...jsonSchema(schema), properties: {} } : jsonSchema(schema),
    annotations: { readOnlyHint: true },
    call: (input, signal) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const decoded = Schema.decodeUnknownOption(schema)(input, { onExcessProperty: "error" });

          if (Option.isNone(decoded))
            return failure(
              "E-INPUT",
              `Invalid input for ${name}`,
              "Use the fields in this tool's input schema."
            );

          if (sessions.data === undefined)
            return failure(
              "E-NOT-READY",
              "Data isn't connected on this host",
              "The user can check it in Data (⌘4)."
            );

          return yield* run(decoded.value, sessions.data, started);
        }).pipe(Effect.catch((error) => Effect.succeed(handle(error)))),
        { signal }
      ),
  });

  const read = <A>(
    data: DataSessionTools,
    source: string,
    run: (approvalId?: RequestId) => Effect.Effect<A, Failure>,
    render: (value: A, known: ReadonlyArray<Redacted.Redacted<string>>) => McpToolResult,
    started: number
  ) =>
    Effect.gen(function* () {
      const known = yield* data.credentials(sessionId, source);

      return yield* withDataApproval(
        run,
        data,
        (value) => render(value, known),
        sessionId,
        started,
        known
      ).pipe(Effect.catch((error) => Effect.succeed(handle(error, known))));
    });

  return [
    make(
      "data_sources",
      "List this checkout's data sources by name, without credentials. Call before describe or query.",
      Schema.Record(Schema.String, Schema.Never),
      (_input, data) =>
        data.sources(sessionId).pipe(
          Effect.map(({ checkout, sources }) => {
            const view = sourcesView(checkout, sources);

            return { ...text([cappedLines(view.lines)]), structuredContent: view.data };
          })
        )
    ),
    make(
      "describe",
      "Describe schemas or a table's columns, indexes and constraints. Optional sample (0–20) uses the logged read-only path. Remote sources need the user's approval.",
      DescribeInput,
      (input, data, started) =>
        read(
          data,
          input.source,
          (approvalId) =>
            data.describe({
              sessionId,
              ...input,
              ...(approvalId === undefined ? undefined : { approvalId }),
            }),
          (value, known) => {
            const view = describeView(value, known);

            return { ...text([cappedLines(view.lines)]), structuredContent: view.data };
          },
          started
        )
    ),
    make(
      "query",
      "Run one SQL statement in a read-only transaction with a 30 s timeout. Binds params; limit defaults to 200 and cannot exceed 200. Remote sources need the user's approval. MySQL SHOW/DESCRIBE/EXPLAIN are refused; use describe for metadata.",
      QueryInput,
      (input, data, started) =>
        read(
          data,
          input.source,
          (approvalId) =>
            data.query({
              sessionId,
              ...input,
              ...(approvalId === undefined ? undefined : { approvalId }),
            }),
          (value, known) => {
            const view = queryView(value, known);

            return { ...text([view.text]), structuredContent: view.data };
          },
          started
        )
    ),
  ];
};
