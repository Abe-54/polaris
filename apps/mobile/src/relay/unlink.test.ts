import { expect, test } from "bun:test";
import { checkLinkedHosts, type LinkedHost } from "@polaris/client/relay";
import { RelayAddress } from "@polaris/protocol/relay";
import { Effect, Schema } from "effect";
import { leaving, revokeOnHosts, type RevokingHost, unlinkFrom } from "./unlink.ts";

// SAFETY: these fakes answer `run` without a client, as a Host that revoked, refused or hung.
const host = (hostId: string, run: () => Promise<void>) => ({ hostId, run }) as RevokingHost;

test("only Hosts that answered count as revoked; a hung or offline Host doesn't hold Unlink", async () => {
  const started = Date.now();

  const revoked = await revokeOnHosts(
    [
      host("studio", () => Promise.resolve()),
      host("pi", () => Promise.reject(new Error("not connected"))),
      host("vm", () => new Promise<never>(() => {})),
    ],
    50
  );

  expect([...revoked]).toEqual(["studio"]);
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("unlinking one Host revokes only it; the others stay linked and keep trusting", async () => {
  const asked: Array<string> = [];

  const answering = (hostId: string) =>
    host(hostId, () => {
      asked.push(hostId);

      return Promise.resolve();
    });

  const linked = [{ hostId: "studio" }, { hostId: "pi" }, { hostId: "vm" }];

  const result = await unlinkFrom(
    linked,
    [answering("studio"), answering("pi"), answering("vm")],
    new Set(["pi"]),
    { revoke: 50, unregister: 50 }
  );

  expect([...result.revoked]).toEqual(["pi"]);
  expect(result.kept.map((h) => h.hostId)).toEqual(["studio", "vm"]);
  expect(result.stillTrusting).toEqual([]);
  expect(asked.every((id) => id === "pi")).toBe(true);
});

test("a targeted Host that doesn't answer stays linked, and is named as still trusting", async () => {
  const result = await unlinkFrom(
    [{ hostId: "studio" }, { hostId: "pi" }],
    [host("pi", () => Promise.reject(new Error("not connected")))],
    new Set(["pi"]),
    { revoke: 50, unregister: 50 }
  );

  expect(result.kept.map((h) => h.hostId)).toEqual(["studio", "pi"]);
  expect(result.stillTrusting.map((h) => h.hostId)).toEqual(["pi"]);
});

const linkedHost = (hostId: string, hostNoiseKey: string): LinkedHost => ({
  hostId,
  hostName: hostId,
  relayUrl: "wss://relay.example",
  hostAddress: Schema.decodeSync(RelayAddress)(hostId.padEnd(22, "a")),
  hostNoiseKey,
});

const linkAccepted = (linked: ReadonlyArray<LinkedHost>, named: LinkedHost) =>
  Effect.runPromise(
    checkLinkedHosts(linked, [named]).pipe(
      Effect.as(true),
      Effect.catchTag("LinkFailed", () => Effect.succeed(false))
    )
  );

test("a Host forgotten without answering can be linked again; one still kept is refused a new key", async () => {
  const studio = linkedHost("studio", "studio-key");
  const pi = linkedHost("pi", "pi-key");
  const { kept, forgetKeys } = leaving([studio, pi], new Set(["pi"]));

  expect(kept).toEqual([studio]);
  expect(forgetKeys).toBe(false);
  expect(await linkAccepted([studio, pi], linkedHost("pi", "pi-new-key"))).toBe(false);
  expect(await linkAccepted(kept, linkedHost("pi", "pi-new-key"))).toBe(true);
  expect(await linkAccepted(kept, linkedHost("studio", "studio-new-key"))).toBe(false);
});

test("forgetting the last Host forgets the keys too", () => {
  expect(leaving([{ hostId: "pi" }], new Set(["pi"]))).toEqual({ kept: [], forgetKeys: true });
});
