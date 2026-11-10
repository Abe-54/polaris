import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { OpenTransport } from "./connection.ts";
import { HostUnreachable } from "./errors.ts";
import type { ParsedPairing } from "./pairing.ts";
import { createPolarisWith } from "./promise.ts";

const pairing: ParsedPairing = {
  hostId: "down-host",
  hostName: "Down Host",
  url: null,
  token: "pol_ext_test",
  name: "Test",
};

/** A Host that refuses every connection, counting the attempts. */
const refusing = () => {
  const attempts = { count: 0 };

  const openTransport: OpenTransport = () =>
    Effect.suspend(() => {
      attempts.count++;

      return Effect.fail(new HostUnreachable({ hostId: pairing.hostId, detail: "refused" }));
    });

  return { attempts, openTransport };
};

const options = { pairings: [pairing], clientName: "test", maxReconnectDelay: 5 };

test("subscribeHosts keeps retrying a Host it hasn't reached yet, showing it disconnected", async () => {
  const { attempts, openTransport } = refusing();
  const client = await createPolarisWith(options, openTransport);
  const seen: Array<boolean> = [];

  for await (const views of client.subscribeHosts()) {
    seen.push(views[0]?.connected ?? true);

    if (attempts.count >= 3) break;
  }

  await client.close();
  expect(attempts.count).toBeGreaterThanOrEqual(3);
  expect(seen.every((connected) => !connected)).toBe(true);
});

test("subscribeHost fails at once on a Host it never reached", async () => {
  const { attempts, openTransport } = refusing();
  const client = await createPolarisWith(options, openTransport);

  const outcome = await (async () => {
    for await (const _ of client.subscribeHost(pairing.hostId)) return "emitted";

    return "ended";
  })().catch((error: Error) => error);

  await client.close();
  expect(outcome).toBeInstanceOf(HostUnreachable);
  expect(attempts.count).toBe(1);
});

test("with reconnect off, subscribeHosts shows an unreachable Host once and ends", async () => {
  const { attempts, openTransport } = refusing();
  const client = await createPolarisWith({ ...options, reconnect: false }, openTransport);
  const emitted: Array<string | undefined> = [];

  for await (const views of client.subscribeHosts()) emitted.push(views[0]?.error?.message);

  await client.close();
  expect(emitted).toHaveLength(1);
  expect(attempts.count).toBe(1);
});
