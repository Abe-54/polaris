/**
 * HTTP and SSE to one `opencode serve`, scoped to one directory: every request
 * carries basic auth and the Workspace directory in `x-opencode-directory`
 * (URL-encoded; the server decodes it), so one server serves every Workspace.
 */
import { Effect, Stream } from "effect";
import type { HarnessError } from "../HarnessDriver.ts";
import { readLines } from "../../lines.ts";
import type * as P from "./protocol.ts";
import { opencodeError, type ServerHandle } from "./Server.ts";

export interface OpenCodeClient {
  /** The parsed JSON response, or null for an empty one (204). */
  readonly get: (path: string) => Effect.Effect<P.Payload, HarnessError>;
  readonly send: (
    method: "POST" | "PATCH",
    path: string,
    body?: P.Outgoing
  ) => Effect.Effect<P.Payload, HarnessError>;
  /**
   * The directory's `/event` stream: each `data:` payload, parsed. Ends when the
   * server closes it; aborting `signal` ends it too (interruption alone waits for the next event).
   */
  readonly events: (signal: AbortSignal) => Stream.Stream<P.Payload, HarnessError>;
}

const headersFor = (handle: ServerHandle, directory: string) => ({
  authorization: `Basic ${btoa(`opencode:${handle.password}`)}`,
  "x-opencode-directory": encodeURIComponent(directory),
});

/** Splits an SSE body into the JSON of each event's `data:` lines. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<P.Payload> {
  let data: Array<string> = [];

  for await (const raw of readLines(body)) {
    const line = raw.replace(/\r$/, "");

    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    else if (line === "" && data.length > 0) {
      const payload = data.join("\n");
      data = [];

      try {
        const parsed: P.Payload = JSON.parse(payload);
        yield parsed;
      } catch {
        // A malformed event is skipped, like an unknown one.
      }
    }
  }
}

export const clientFor = (handle: ServerHandle, directory: string): OpenCodeClient => {
  const headers = headersFor(handle, directory);

  const request = (method: string, path: string, init: RequestInit) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${handle.url}${path}`, { ...init, method, signal });

        const text = await response.text();

        if (!response.ok)
          throw new Error(
            `${method} ${path} → ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`
          );

        const parsed: P.Payload = text === "" ? null : JSON.parse(text);

        return parsed;
      },
      catch: (cause) =>
        opencodeError(cause instanceof Error ? cause.message : `${method} ${path} failed`, cause),
    });

  const events = (signal: AbortSignal) =>
    Stream.unwrap(
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${handle.url}/event`, {
            headers: { ...headers, accept: "text/event-stream" },
            signal,
          });

          if (!response.ok || response.body === null)
            throw new Error(`GET /event → ${response.status}`);

          return response.body;
        },
        catch: (cause) => opencodeError("couldn't subscribe to OpenCode's events", cause),
      }).pipe(
        Effect.map((body) =>
          Stream.fromAsyncIterable(sseData(body), (cause) =>
            opencodeError("OpenCode's event stream failed", cause)
          )
        )
      )
    );

  return {
    get: (path) => request("GET", path, { headers }),
    send: (method, path, body) =>
      request(
        method,
        path,
        body === undefined
          ? { headers }
          : {
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify(body),
            }
      ),
    events,
  };
};
