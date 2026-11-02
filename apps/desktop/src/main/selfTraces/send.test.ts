/** `ingestOn` against a stand-in Host directory with a recording `traces.ingestSelf`. */
import { describe, expect, test } from "bun:test";
import type { HostConnection, LiveSession } from "@polaris/client";
import { type Capability, type SelfTraceBatch, SelfTraceRejected } from "@polaris/protocol";
import { Effect, Layer, SubscriptionRef } from "effect";
import type { HostView } from "../../shared/api.ts";
import { HostDirectory, UnknownHost } from "../hosts.ts";
import { MAIN_SERVICE } from "./index.ts";
import { ingestOn } from "./send.ts";

interface FakeHost {
  readonly capabilities?: ReadonlyArray<Capability>;
  readonly rejects?: SelfTraceRejected["reason"];
  readonly ingested?: Array<SelfTraceBatch>;
}

const fakeClient = (host: FakeHost) => ({
  "traces.ingestSelf": (batch: SelfTraceBatch) =>
    host.rejects === undefined
      ? Effect.sync(() => {
          host.ingested?.push(batch);

          return { accepted: batch.spans.length };
        })
      : Effect.fail(new SelfTraceRejected({ reason: host.rejects, message: "refused" })),
});

const fakeSession = (host: FakeHost): LiveSession => {
  const session: Partial<LiveSession> = {
    capabilities: host.capabilities ?? ["traces.self"],
    // SAFETY: the code under test calls only the RPC faked in `fakeClient`.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a partial fake of a generic RPC client
    client: fakeClient(host) as unknown as LiveSession["client"],
  };

  // SAFETY: the code under test reads only `capabilities` and `client`.
  return session as LiveSession;
};

const directory = (session: LiveSession | null) =>
  Layer.effect(
    HostDirectory,
    Effect.map(SubscriptionRef.make<ReadonlyArray<HostView>>([]), (views) =>
      HostDirectory.of({
        views,
        entry: () => undefined,
        connection: (key) => {
          if (session === null) return Effect.fail(new UnknownHost(key));
          const connection: Partial<HostConnection> = { session: Effect.succeed(session) };

          // SAFETY: `ingestOn` reads only `session` from a HostConnection.
          return Effect.succeed(connection as HostConnection);
        },
        add: () => Effect.void,
        remove: () => Effect.void,
      })
    )
  );

describe("ingestOn", () => {
  const batch: SelfTraceBatch = {
    service: MAIN_SERVICE,
    spans: [
      {
        traceId: "1".repeat(32),
        id: "2".repeat(16),
        parentId: null,
        name: "turn",
        kind: "internal",
        status: "unset",
        statusMessage: "",
        traceState: "",
        startTimeUnixNano: "1",
        endTimeUnixNano: "2",
        attributes: {},
        resource: {},
        scope: { name: "main", version: "1.0.0", attributes: {} },
        events: [],
        links: [],
        droppedAttributes: 0,
        droppedEvents: 0,
        droppedLinks: 0,
      },
    ],
  };

  const send = (session: LiveSession | null) =>
    Effect.runPromise(ingestOn("studio", batch).pipe(Effect.provide(directory(session))));

  test("delivers to a Host that takes Self-Traces", async () => {
    const ingested: Array<SelfTraceBatch> = [];

    expect(await send(fakeSession({ ingested }))).toBe("sent");
    expect(ingested).toEqual([batch]);
  });

  test("drops for a Host that can't take them, and waits for one that isn't there", async () => {
    expect(await send(fakeSession({ capabilities: [] }))).toBe("dropped");
    expect(await send(null)).toBe("unreachable");
  });

  test("a busy trace store keeps the batch for a retry; a refusal drops it", async () => {
    expect(await send(fakeSession({ rejects: "busy" }))).toBe("unreachable");
    expect(await send(fakeSession({ rejects: "storage" }))).toBe("dropped");
  });
});
