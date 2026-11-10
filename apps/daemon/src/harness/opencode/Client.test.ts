import { afterEach, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { clientFor } from "./Client.ts";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(async () => {
  await server?.stop(true);
  server = null;
});

/** Serves `body` as the `/event` stream, enqueued one byte at a time. */
const serveBytewise = (body: string) => {
  const bytes = new TextEncoder().encode(body);

  server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 1) controller.enqueue(bytes.subarray(i, i + 1));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      ),
  });

  return clientFor(
    { url: `http://localhost:${server.port}`, password: "secret", opencodePath: "opencode" },
    "/tmp"
  );
};

test("SSE events split into single bytes keep their framing", async () => {
  const client = serveBytewise(
    [
      'data: {"type":"a","text":"é😀"}\r\n\r\n',
      ": a comment\n",
      'data: {"type":"b",\n',
      'data:"lines":2}\n\n',
      "data: not json\n\n",
      "\n",
      'data: {"type":"cut short"}\n',
    ].join("")
  );

  const events = await Effect.runPromise(
    Stream.runCollect(client.events(new AbortController().signal))
  );

  expect(events).toEqual([
    { type: "a", text: "é😀" },
    { type: "b", lines: 2 },
  ]);
});
