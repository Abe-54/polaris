/** How `send_request` shows a Send to the agent; the Send Log already masked its secrets. */
import type { Send } from "@polaris/protocol";
import { Match } from "effect";
import { text } from "./session.ts";
import type { McpToolResult } from "./shared.ts";

export const BODY_CHARACTERS = 16_000;

export const failure = (code: string, message: string, fix: string): McpToolResult => ({
  isError: true,
  ...text([`${code}: ${message}`, `Fix: ${fix}`]),
  structuredContent: { code, message, fix },
});

export const pending = (origin: string, approvalId: string): McpToolResult => ({
  ...text([
    `Waiting for the user to approve sending to ${origin} in this conversation; call send_request again with the same input after they answer.`,
  ]),
  structuredContent: { pending: true, approvalId, origin },
});

export const approvedCallAgain: McpToolResult = {
  ...text(["Approved; call send_request again with the same input to send it."]),
  structuredContent: { approved: true },
};

const traceLine = (traceId: string) =>
  `Trace ${traceId}: call trace with this id to see what the server did for this request.`;

const unsent = (send: Send) =>
  Match.value(send.outcome).pipe(
    Match.when("denied", () => ({
      code: "E-ORIGIN-DENIED",
      fix: "Don't resend; read the user's reason and ask them before trying this origin again.",
    })),
    Match.when("refused", () => ({
      code: "E-SEND-REFUSED",
      fix: "Nothing is listening there; start the server or check the URL's host and port.",
    })),
    Match.when("timeout", () => ({
      code: "E-SEND-TIMEOUT",
      fix: "The server didn't answer within 30 s; check that it isn't stuck, then retry.",
    })),
    Match.orElse(() => ({
      code: "E-SEND-FAILED",
      fix: "Check the URL, its scheme and the network.",
    }))
  );

/** The body for the agent: at most 16,000 characters, saying when there was more. */
const bodyView = (send: Send) => {
  const body = send.responseBody ?? "";
  const truncated = body.length > BODY_CHARACTERS || send.responseTruncated;

  const total =
    send.responseBytes === undefined ? `${body.length} characters` : `${send.responseBytes} bytes`;

  return {
    body: body.slice(0, BODY_CHARACTERS),
    truncated,
    note: truncated
      ? `[Body truncated: showing the first ${Math.min(body.length, BODY_CHARACTERS)} characters of ${total}.]`
      : undefined,
  };
};

export const sendResult = (send: Send): McpToolResult => {
  if (send.status === undefined) {
    const { code, fix } = unsent(send);
    const message = send.errorMessage ?? `The request wasn't sent (${send.outcome}).`;

    return {
      isError: true,
      ...text([
        `${code}: ${message}`,
        `Fix: ${fix}`,
        ...(send.traceId === null ? [] : [traceLine(send.traceId)]),
      ]),
      structuredContent: {
        code,
        message,
        fix,
        outcome: send.outcome,
        sendId: send.id,
        traceId: send.traceId,
      },
    };
  }

  const view = bodyView(send);
  const durationMs = Math.round(send.durationMs);

  return {
    ...text([
      `HTTP ${send.status} ${send.statusText ?? ""}`.trimEnd() + ` · ${durationMs} ms`,
      ...send.responseHeaders.map((header) => `${header.name}: ${header.value}`),
      "",
      view.body,
      ...(view.note === undefined ? [] : [view.note]),
      ...(send.traceId === null ? [] : ["", traceLine(send.traceId)]),
    ]),
    structuredContent: {
      status: send.status,
      statusText: send.statusText ?? "",
      headers: send.responseHeaders.map((header) => ({ ...header })),
      body: view.body,
      bodyTruncated: view.truncated,
      durationMs,
      traceId: send.traceId,
      sendId: send.id,
      outcome: send.outcome,
    },
  };
};
