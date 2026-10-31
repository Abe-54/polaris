import { afterEach, expect, test } from "bun:test";
import { SessionId, TraceAvailability, type TracesSnapshot } from "@polaris/protocol";
import { standInBridge } from "../../bridge.ts";
import { installFakeBridge } from "../../../test/bridge.testing.ts";
import { liveTracesApi } from "./api.ts";

const at = { hostKey: "host", sessionId: SessionId.make("session") };

const endpoint = "http://127.0.0.1:4319/otlp/private-session-token";

const page = (endpoint: string | null): TracesSnapshot => ({
  availability: TraceAvailability.cases.Listening.make({}),
  userExported: false,
  endpoint,
  traces: [],
  total: 0,
});

afterEach(() => standInBridge(null));

test("the initial endpoint survives sparse pages, including one IPC batch, only within its watch", () => {
  const bridge = installFakeBridge();
  const seen: TracesSnapshot[] = [];
  const stop = liveTracesApi.watch(at, undefined, { next: (value) => seen.push(value) });
  const feed = bridge.feeds("traces.watch")[0]!;
  feed.listener.items([page(endpoint), page(null)]);
  feed.listener.items([page(null)]);
  expect(seen.map((value) => value.endpoint)).toEqual([endpoint, endpoint]);
  stop();
  feed.listener.items([page("late-token")]);
  expect(seen).toHaveLength(2);
  const other: TracesSnapshot[] = [];

  const stopOther = liveTracesApi.watch({ ...at, sessionId: SessionId.make("other") }, undefined, {
    next: (value) => other.push(value),
  });

  bridge.feeds("traces.watch")[1]!.listener.items([page(null)]);
  expect(other[0]?.endpoint).toBeNull();
  stopOther();
});

test.each(["unavailable", "user-exported"] as const)(
  "%s to local availability refreshes the initial page once",
  async (reason) => {
    const bridge = installFakeBridge();
    const seen: TracesSnapshot[] = [];
    const stop = liveTracesApi.watch(at, undefined, { next: (value) => seen.push(value) });
    const feed = bridge.feeds("traces.watch")[0]!;

    const disabled =
      reason === "user-exported"
        ? { ...page(null), userExported: true }
        : {
            ...page(null),
            availability: TraceAvailability.cases.Unavailable.make({
              code: "EADDRINUSE",
              message: "In use",
              owner: null,
            }),
          };

    feed.listener.items([disabled]);
    feed.listener.items([page(null)]);
    await Promise.resolve();
    expect(bridge.feeds("traces.watch")).toHaveLength(2);
    const fresh = bridge.feeds("traces.watch")[1]!;
    fresh.listener.items([page(endpoint), page(null)]);
    expect(seen.at(-1)?.endpoint).toBe(endpoint);
    fresh.listener.items([disabled]);
    expect(seen.at(-1)?.endpoint).toBeNull();
    fresh.listener.items([page(null)]);
    await Promise.resolve();
    expect(seen.at(-1)?.endpoint).toBe(endpoint);
    expect(bridge.feeds("traces.watch")).toHaveLength(2);
    stop();
  }
);

test("an inactive session with no initial endpoint does not resubscribe forever", async () => {
  const bridge = installFakeBridge();
  const seen: TracesSnapshot[] = [];
  const stop = liveTracesApi.watch(at, undefined, { next: (value) => seen.push(value) });
  bridge.feeds("traces.watch")[0]!.listener.items([page(null), page(null)]);
  await Promise.resolve();
  expect(seen[0]?.endpoint).toBeNull();
  expect(bridge.feeds("traces.watch")).toHaveLength(1);
  stop();
});
