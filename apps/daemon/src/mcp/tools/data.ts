/** Data tools on every binding (ENG-644); no caller-supplied checkout, Turn or credentials. */
import {
  DataError,
  ConstellationRejected,
  DescribeData,
  QueryData,
  type SessionId,
} from "@polaris/protocol";
import { Effect, Match, Schema, Redacted } from "effect";
import { scrubKnown, scrubKnownJson } from "../../data/knownCredentials.ts";
import type { DataSessionTools } from "../sessions/data.ts";
import type { SessionTools } from "../sessions/index.ts";
import { cappedLines, describeView, queryView, safeDataText, sourcesView } from "./dataFormat.ts";
import { sessionTool, text } from "./session.ts";
import { rejection, errorResult, type McpToolResult } from "./shared.ts";

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

const failure = (error: DataError): McpToolResult => {
  const data = {
    code: error.code,
    message: safeDataText(error.message),
    fix: safeDataText(error.fix),
  };

  return {
    isError: true,
    ...text([`${data.code}: ${data.message}`, `Fix: ${data.fix}`]),
    structuredContent: data,
  };
};

const pending = (source: string, approvalId: string): McpToolResult => ({
  ...text([
    `Waiting for the user to approve ${safeDataText(source)} in this conversation; call again after they answer`,
  ]),
  structuredContent: { pending: true, approvalId: safeDataText(approvalId) },
});

const scrubResult = (
  result: McpToolResult,
  known: ReadonlyArray<Redacted.Redacted<string>>
): McpToolResult => {
  const content = result.content.map((item) => ({ ...item, text: scrubKnown(item.text, known) }));

  if (result.structuredContent === undefined) return { ...result, content };

  const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    JSON.stringify(result.structuredContent)
  );

  const structuredContent = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
    scrubKnownJson(json, known)
  );

  return { ...result, content, structuredContent };
};

const withApproval = <A>(
  run: Effect.Effect<A, Parameters<typeof handle>[0]>,
  data: DataSessionTools,
  render: (value: A) => McpToolResult
) =>
  run.pipe(
    Effect.map(render),
    Effect.catchTag("DataApprovalRequired", (required) =>
      data.awaitApproval(required.approvalId, 50_000).pipe(
        Effect.flatMap((outcome) =>
          Match.value(outcome).pipe(
            Match.when({ status: "pending" }, () =>
              Effect.succeed(pending(required.sourceName, required.approvalId))
            ),
            Match.when({ status: "denied" }, ({ reason }) =>
              Effect.succeed(
                failure(
                  new DataError({
                    code: "E-DATA-DENIED",
                    message: reason || "The user denied this data source",
                    fix: "Don't retry; ask the user.",
                  })
                )
              )
            ),
            Match.when({ status: "approved" }, () =>
              run.pipe(
                Effect.map(render),
                Effect.catchTag("DataApprovalRequired", (again) =>
                  Effect.succeed(pending(again.sourceName, again.approvalId))
                )
              )
            ),
            Match.exhaustive
          )
        )
      )
    ),
    Effect.catch(handle)
  );

const handle = (error: Effect.Error<ReturnType<DataSessionTools["describe"]>>) =>
  Match.value(error).pipe(
    Match.tag("DataError", (error) => Effect.succeed(failure(error))),
    Match.tag("Unsupported", () =>
      Effect.fail(
        rejection(
          "E-NOT-READY",
          "Data isn't connected on this host",
          "The user can check it in Data (⌘4)."
        )
      )
    ),
    Match.tag("NotFound", () =>
      Effect.fail(
        rejection(
          "E-SESSION",
          "This agent session isn't on this host",
          "Call from an agent session on this host."
        )
      )
    ),
    Match.tag("DataApprovalRequired", (error) =>
      Effect.succeed(pending(error.sourceName, error.approvalId))
    ),
    Match.exhaustive
  );

const makeDataTools = (
  sessionId: SessionId,
  sessions: SessionTools,
  known: ReadonlyArray<Redacted.Redacted<string>>
) => {
  const connected = (): Effect.Effect<DataSessionTools, ConstellationRejected> =>
    sessions.data === undefined
      ? Effect.fail(
          rejection(
            "E-NOT-READY",
            "Data isn't connected on this host",
            "The user can check it in Data (⌘4)."
          )
        )
      : Effect.succeed(sessions.data);

  const tools = [
    sessionTool(
      "data_sources",
      "List this checkout's data sources by name, without credentials. Call before describe or query.",
      Schema.Record(Schema.String, Schema.Never),
      () =>
        connected().pipe(
          Effect.flatMap((data) =>
            data.sources(sessionId).pipe(
              Effect.map(({ checkout, sources }) => {
                const view = sourcesView(checkout, sources, known);

                return { ...text([cappedLines(view.lines)]), structuredContent: view.data };
              }),
              Effect.catch(handle)
            )
          )
        )
    ),
    sessionTool(
      "describe",
      "Describe a data source's schemas, or a table's columns, indexes and constraints. Optional sample (0–20) reads rows through the logged read-only path. Remote sources need the user's approval.",
      DescribeInput,
      (input) =>
        connected().pipe(
          Effect.flatMap((data) =>
            withApproval(data.describe({ sessionId, ...input }), data, (value) => {
              const view = describeView(value, known);

              return { ...text([cappedLines(view.lines)]), structuredContent: view.data };
            })
          )
        )
    ),
    sessionTool(
      "query",
      "Run one SQL statement in a read-only transaction with a 30 s timeout. Binds params; limit defaults to 200 and cannot exceed 200. Remote sources need the user's approval. Returns an aligned table and a query log id.",
      QueryInput,
      (input) =>
        connected().pipe(
          Effect.flatMap((data) =>
            withApproval(data.query({ sessionId, ...input }), data, (value) => {
              const view = queryView(value, known);

              return { ...text([view.text]), structuredContent: view.data };
            })
          )
        )
    ),
  ];

  return tools;
};

export const dataTools = (sessionId: SessionId, sessions: SessionTools) =>
  makeDataTools(sessionId, sessions, []).map((tool) => ({
    ...tool,
    annotations: { readOnlyHint: true },
    inputSchema:
      tool.name === "data_sources" ? { ...tool.inputSchema, properties: {} } : tool.inputSchema,
    call: (input: typeof Schema.Json.Type) => {
      if (sessions.data === undefined) return tool.call(input);

      return Effect.runPromise(
        sessions.data.credentials(sessionId).pipe(
          Effect.flatMap((known) => {
            const ready = makeDataTools(sessionId, sessions, known).find(
              (entry) => entry.name === tool.name
            )!;

            return Effect.promise(() => ready.call(input)).pipe(
              Effect.map((result) => scrubResult(result, known))
            );
          }),
          Effect.catch(handle),
          Effect.catchTag("ConstellationRejected", (error) => Effect.succeed(errorResult(error)))
        )
      );
    },
  }));
