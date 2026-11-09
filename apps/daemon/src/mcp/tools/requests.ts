/** `send_request`: an agent's Send, gated by Origin Approvals like the data tools (ADR 0098). */
import { HttpMethod, RequestTarget, type RequestId, type SessionId } from "@polaris/protocol";
import { Clock, Effect, Match, Option, Schema } from "effect";
import type { OriginApprovalRequired } from "../../requests/approvals/index.ts";
import type { SessionTools } from "../sessions/index.ts";
import type { RequestSessionTools } from "../sessions/requests.ts";
import { RequestId as RetryKey, type Idempotency } from "./idempotency.ts";
import { approvedCallAgain, failure, pending, sendResult } from "./requestsFormat.ts";
import { jsonSchema, type BoundTool } from "./shared.ts";

const Name = Schema.String.check(Schema.isMinLength(1));

const Input = Schema.Struct({
  requestId: Schema.optionalKey(RetryKey),
  file: Schema.optionalKey(
    Name.annotate({ description: "A saved Request's .http file, relative to the checkout." })
  ),
  name: Schema.optionalKey(Name.annotate({ description: "The saved Request's name in file." })),
  method: Schema.optionalKey(HttpMethod),
  url: Schema.optionalKey(
    Name.annotate({ description: "An inline Request's absolute URL; {{variables}} resolve." })
  ),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(
    Name.annotate({ description: "The http-client.env.json environment for {{variables}}." })
  ),
});

type Input = typeof Input.Type;

const DESCRIPTION = [
  "Send one HTTP request and read the response: status, headers, body (first 16,000 characters) and the traceId of what it caused.",
  "Use it to exercise an API you are building or debugging, rather than curl. Give a saved Request ({file, name} from a .http file in the checkout) or an inline one ({method, url, headers?, body?}); environment picks the environment for {{variables}}.",
  "Polaris adds a traceparent header, so an instrumented server's spans join the returned trace; inspect it with trace.",
  "Local servers are sent to directly. Remote origins need the user's approval: a pending result means call again with the same input after they answer. Secret values are masked in the output.",
  "Reuse requestId with the same input to read a result you didn't see without sending twice.",
].join(" ");

/** 30 s send timeout plus 5 s headroom within the 60 s MCP budget, as the data tools keep. */
const BUDGET_MS = 55_000;

const SEND_ROOM_MS = 35_000;

const targetOf = ({ file, name, method, url, headers, body }: Input): RequestTarget | undefined => {
  if (file !== undefined && name !== undefined && method === undefined && url === undefined)
    return RequestTarget.cases.Saved.make({ ref: { file, name } });

  if (method === undefined || url === undefined || file !== undefined || name !== undefined)
    return undefined;

  return RequestTarget.cases.Inline.make({
    request: {
      method,
      url,
      headers: Object.entries(headers ?? {}).map(([header, value]) => ({ name: header, value })),
      ...(body === undefined ? undefined : { body }),
    },
  });
};

type Failure = Effect.Error<ReturnType<RequestSessionTools["send"]>>;

const handle = (error: Exclude<Failure, OriginApprovalRequired>) =>
  Match.value(error).pipe(
    Match.tag("RequestsError", (error) => failure(error.code, error.message, error.fix)),
    Match.tag("NotFound", () =>
      failure(
        "E-SESSION",
        "This agent session isn't on this host",
        "Call from an agent session on this host."
      )
    ),
    Match.exhaustive
  );

const notReady = failure(
  "E-NOT-READY",
  "Requests aren't running on this host",
  "Use curl for now, or ask the user to update Polaris."
);

export const requestTools = (
  sessionId: SessionId,
  sessions: SessionTools,
  ids: Idempotency
): BoundTool[] => {
  const run = (requests: RequestSessionTools, input: Input, target: RequestTarget) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const { requestId, ...rest } = input;
      const call = ids.begin(sessionId, "send_request", requestId, rest);
      const memo = requests.recall(call.id);

      if (memo !== undefined && "sendId" in memo && requestId !== undefined)
        return sendResult(yield* requests.get(sessionId, memo.sendId));

      const attempt = (grant: RequestId | null) =>
        requests.send(sessionId, target, input.environment, grant).pipe(
          Effect.tap((send) => Effect.sync(() => requests.remember(call.id, { sendId: send.id }))),
          Effect.map(sendResult)
        );

      const held = (required: OriginApprovalRequired) => {
        requests.remember(call.id, { approvalId: required.approvalId });

        return pending(required.origin, required.approvalId);
      };

      const grant = memo !== undefined && "approvalId" in memo ? memo.approvalId : null;

      return yield* attempt(grant).pipe(
        Effect.catchTag("OriginApprovalRequired", (required) =>
          Effect.gen(function* () {
            const elapsed = (yield* Clock.currentTimeMillis) - started;

            const outcome = yield* requests.awaitApproval(
              required.approvalId,
              required.write,
              Math.max(0, BUDGET_MS - elapsed)
            );

            if (outcome.status === "pending") return held(required);

            const now = (yield* Clock.currentTimeMillis) - started;

            if (outcome.status === "approved" && 60_000 - now < SEND_ROOM_MS)
              return approvedCallAgain;

            // A denied grant makes the gate record a `denied` Send.
            return yield* attempt(required.approvalId).pipe(
              Effect.catchTag("OriginApprovalRequired", (again) => Effect.succeed(held(again)))
            );
          })
        ),
        Effect.tapError(() => Effect.sync(call.rejected))
      );
    });

  return [
    {
      name: "send_request",
      description: DESCRIPTION,
      inputSchema: jsonSchema(Input),
      annotations: { readOnlyHint: false, openWorldHint: true },
      call: (input, signal) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const decoded = Schema.decodeUnknownOption(Input)(input, {
              onExcessProperty: "error",
            });

            const target = Option.isSome(decoded) ? targetOf(decoded.value) : undefined;

            if (Option.isNone(decoded) || target === undefined)
              return failure(
                "E-INPUT",
                "Invalid input for send_request",
                "Pass file and name for a saved Request, or method and url (with optional headers and body) for an inline one."
              );

            if (sessions.requests === undefined) return notReady;

            return yield* run(sessions.requests, decoded.value, target);
          }).pipe(Effect.catch((error) => Effect.succeed(handle(error)))),
          { signal }
        ),
    },
  ];
};
