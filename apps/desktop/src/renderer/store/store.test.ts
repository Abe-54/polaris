import { describe, expect, test } from "bun:test";
import { DomainEvent, HostStreamItem, SessionStreamItem } from "@polaris/protocol";
import type { CachedHost, HostView } from "../../shared/api.ts";
import { envelope, seq, session, sessionId, workspace } from "./fixtures.testing.ts";
import { emptyHostModel, type HostModel } from "./hostModel.ts";
import { cacheWrites, initialState, reduceUpdates, sessionKey } from "./store.ts";

const host: HostView = {
  key: "local",
  label: "This Mac",
  colour: null,
  alias: null,
  kind: "local",
  proofHarness: true,
  status: {
    state: "connected",
    failure: null,
    attempt: 0,
    since: 0,
    nextAttemptAt: null,
    host: null,
    capabilities: [],
    epoch: 1,
    latencyMs: null,
    lastSeenAt: null,
  },
};

describe("store updates", () => {
  test("one frame's updates fold per Host and per session, and keep untouched slices", () => {
    const key = sessionKey("local", sessionId);

    const state = reduceUpdates(initialState, [
      { kind: "hosts", hosts: [host] },
      {
        kind: "host",
        hostKey: "local",
        item: HostStreamItem.cases.Snapshot.make({
          sequence: seq(1),
          workspaces: [workspace],
          worktrees: [],
          sessions: [],
        }),
      },
      {
        kind: "session",
        key,
        item: SessionStreamItem.cases.Snapshot.make({
          sequence: seq(1),
          session,
          turns: [],
          pendingApprovals: [],
        }),
      },
      {
        kind: "host",
        hostKey: "local",
        item: HostStreamItem.cases.Event.make({
          envelope: envelope(2, DomainEvent.cases.SessionCreated.make({ session })),
        }),
      },
    ]);

    expect(state.hosts).toEqual([host]);
    expect(state.hostModels.local?.sequence).toBe(seq(2));
    expect(state.hostModels.local?.sessions.size).toBe(1);
    expect(state.sessions[key]?.session?.id).toBe(sessionId);
    expect(initialState.hostModels).toEqual({});
    expect(initialState.sessions).toEqual({});

    const next = reduceUpdates(state, [{ kind: "hosts", hosts: [] }]);

    expect(next.hostModels.local).toBe(state.hostModels.local);
    expect(next.sessions[key]).toBe(state.sessions[key]);
  });

  test("an empty Host list counts as listed only once main has sent it", () => {
    expect(reduceUpdates(initialState, []).hostsListed).toBe(false);
    expect(reduceUpdates(initialState, [{ kind: "hosts", hosts: [] }]).hostsListed).toBe(true);
  });
});

describe("cache writes", () => {
  const synced = (sequence: number): HostModel => ({
    ...emptyHostModel,
    synchronized: true,
    sequence: seq(sequence),
  });

  const writer = (delayMs: number) => {
    const models = new Map<string, HostModel>();
    const puts: Array<string> = [];

    const writes = cacheWrites({
      model: (hostKey) => models.get(hostKey) ?? emptyHostModel,
      put: async (host: CachedHost) => {
        await Bun.sleep(1);
        puts.push(`${host.hostKey}@${host.sequence}`);
      },
      delayMs,
    });

    const change = (hostKey: string, sequence: number) => {
      models.set(hostKey, synced(sequence));
      writes.changed(hostKey);
    };

    return { writes, puts, change };
  };

  test("a busy Host is put once per delay, with its latest model", async () => {
    const { puts, change } = writer(40);
    const start = performance.now();

    for (let sequence = 1; sequence <= 10; sequence++) change("local", sequence);

    while (puts.length === 0) await Bun.sleep(5);

    expect(performance.now() - start).toBeGreaterThanOrEqual(35);
    expect(puts).toEqual(["local@10"]);
  });

  test("a flush puts the waiting Hosts at once and resolves after main has them", async () => {
    const { writes, puts, change } = writer(60_000);

    change("local", 2);
    change("studio", 5);
    await writes.flush();
    expect(puts.toSorted()).toEqual(["local@2", "studio@5"]);

    await writes.flush();
    expect(puts).toHaveLength(2);
  });
});
