import { expect, test } from "bun:test";
import { WorkspaceId } from "@polaris/protocol";
import { ForwardQueue, forwardHeaders } from "./forwardQueue.ts";

const workspaceId = WorkspaceId.make("forward-test");

const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Collector did not receive the request");
    await Bun.sleep(5);
  }
};

test("a failed collector backs off, then receives the original bytes and application headers", async () => {
  const received: Array<{ bytes: Uint8Array; headers: Headers; at: number }> = [];
  let available = false;

  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push({
        bytes: new Uint8Array(await request.arrayBuffer()),
        headers: request.headers,
        at: Date.now(),
      });

      return new Response(null, { status: available ? 200 : 503 });
    },
  });

  const queue = new ForwardQueue({ retryMs: 30 });
  const bytes = new Uint8Array([0, 255, 17, 10, 13]);

  try {
    queue.enqueue({
      workspaceId,
      url: `http://127.0.0.1:${collector.port}/v1/traces`,
      bytes,
      headers: forwardHeaders(
        new Headers({
          authorization: "Bearer private-app",
          "content-type": "application/x-protobuf; charset=binary",
        }),
        {},
        { passesAppHeaders: true, launchHeaderNames: [] }
      ),
    });
    await until(() => received.length >= 2);
    expect(received[1]!.at - received[0]!.at).toBeGreaterThanOrEqual(25);
    available = true;
    await until(() => queue.stats.delivered === 1);
    expect(received.at(-1)!.bytes).toEqual(bytes);
    expect(received.at(-1)!.headers.get("authorization")).toBe("Bearer private-app");
    expect(received.at(-1)!.headers.get("content-type")).toBe(
      "application/x-protobuf; charset=binary"
    );
    expect(queue.stats.bytes).toBe(0);
  } finally {
    queue.close();
    await collector.stop(true);
  }
});

for (const [limit, maxItems, maxBytes] of [
  ["request count", 2, 4096],
  ["bytes", 32, 1024],
] as const)
  test(`backpressure by ${limit} drops the oldest request and sends the newest after recovery`, async () => {
    const received: string[] = [];
    let available = false;

    const collector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = await request.text();

        if (available) received.push(body);

        return new Response(null, { status: available ? 200 : 503 });
      },
    });

    const queue = new ForwardQueue({ maxItems, maxBytes, retryMs: 100 });

    const send = (body: string) =>
      queue.enqueue({
        workspaceId,
        url: `http://127.0.0.1:${collector.port}/v1/traces`,
        headers: new Headers(),
        bytes: new TextEncoder().encode(body.padEnd(300, ".")),
      });

    try {
      send("oldest");
      await until(() => queue.stats.failed === 1);
      send("middle");
      send("newest");
      expect(queue.stats.queued).toBe(2);
      expect(queue.stats.dropped).toBe(1);
      expect(queue.stats.bytes).toBeLessThanOrEqual(maxBytes);
      available = true;
      await until(() => queue.stats.delivered === 2);
      expect(received).toEqual(["middle".padEnd(300, "."), "newest".padEnd(300, ".")]);
      expect(queue.stats.bytes).toBe(0);
    } finally {
      queue.close();
      await collector.stop(true);
    }
  });

test("turning forwarding off clears queued credentials and cancels retries", async () => {
  let calls = 0;

  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls++;

      return new Response(null, { status: 503 });
    },
  });

  const queue = new ForwardQueue({ retryMs: 30 });

  try {
    queue.enqueue({
      workspaceId,
      url: `http://127.0.0.1:${collector.port}`,
      headers: new Headers({ authorization: "secret" }),
      bytes: new Uint8Array([1]),
    });
    await until(() => queue.stats.failed === 1);
    queue.cancel(workspaceId);
    await Bun.sleep(100);
    expect(calls).toBe(1);
    expect(queue.stats).toMatchObject({ queued: 0, bytes: 0 });
  } finally {
    queue.close();
    await collector.stop(true);
  }
});

test("a redirect cannot send application credentials to another collector", async () => {
  let destinationCalls = 0;

  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      destinationCalls++;

      return new Response();
    },
  });

  const redirect = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(null, {
        status: 307,
        headers: { location: `http://127.0.0.1:${destination.port}` },
      }),
  });

  const queue = new ForwardQueue();

  try {
    queue.enqueue({
      workspaceId,
      url: `http://127.0.0.1:${redirect.port}`,
      headers: new Headers({ authorization: "secret" }),
      bytes: new Uint8Array([1]),
    });
    await until(() => queue.stats.failed === 1);
    expect(destinationCalls).toBe(0);
    expect(queue.stats.queued).toBe(0);
  } finally {
    queue.close();
    await redirect.stop(true);
    await destination.stop(true);
  }
});
