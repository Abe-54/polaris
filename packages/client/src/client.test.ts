import { describe, expect, test } from "bun:test";
import { Cause, Data, Deferred, Effect, Exit, Fiber, Option, Queue, Stream } from "effect";
import {
  classifyExit,
  type NeedsAttentionReason,
  olderSide,
  type TransientReason,
} from "./failures.ts";
import { makeFeed, reopenBackoff, type SequenceMark } from "./resume.ts";
import { sshArgv } from "./ssh.ts";

describe("classifyExit", () => {
  const cases: Array<[string, number | null, string, NeedsAttentionReason | TransientReason]> = [
    [
      "host key changed",
      255,
      "@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.",
      "host-key-changed",
    ],
    ["unknown host key", 255, "Host key verification failed.", "host-key-unknown"],
    ["auth", 255, "git@example: Permission denied (publickey).", "auth-failed"],
    ["bad perms", 255, "Bad owner or permissions on /Users/x/.ssh/config", "ssh-config-error"],
    ["no polaris", 127, "bash: line 1: polaris: command not found", "polaris-not-installed"],
    [
      "no installed Daemon",
      127,
      "bash: line 1: /home/u/.polaris/bin/current/polaris: No such file or directory",
      "polaris-not-installed",
    ],
    ["no daemon", 69, "polaris bridge: no Daemon is running on this Host", "daemon-not-running"],
    [
      "dns",
      255,
      "ssh: Could not resolve hostname pi: nodename nor servname provided",
      "unreachable",
    ],
    ["refused", 255, "ssh: connect to host pi port 22: Connection refused", "unreachable"],
    ["timeout", 255, "ssh: connect to host pi port 22: Operation timed out", "timeout"],
    ["dropped", 255, "Connection to pi closed by remote host.", "connection-lost"],
  ];

  for (const [name, code, stderr, reason] of cases) {
    test(name, () => {
      expect(classifyExit({ code, signal: null, stderr }).reason).toBe(reason);
    });
  }

  test("user-fixable failures are Needs Attention, network ones transient", () => {
    expect(classifyExit({ code: 255, signal: null, stderr: "Permission denied" }).kind).toBe(
      "needs-attention"
    );
    expect(classifyExit({ code: 255, signal: null, stderr: "No route to host" }).kind).toBe(
      "transient"
    );
  });
});

test("a protocol mismatch names the side speaking the older protocol", () => {
  expect(olderSide(1, 2)).toBe("daemon");
  expect(olderSide(3, 2)).toBe("client");
});

describe("sshArgv", () => {
  test("adds only Polaris's own options and never prompts", () => {
    const argv = sshArgv("studio", { controlDir: "/c" });
    const joined = argv.join(" ");
    expect(argv[0]).toBe("ssh");

    for (const option of [
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "UpdateHostKeys=no",
      "ControlMaster=auto",
      "ControlPath=/c/%C",
      "ControlPersist=10m",
      "Compression=yes",
      "ServerAliveInterval=15",
      "ServerAliveCountMax=3",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
    ])
      expect(joined).toContain(`-o ${option}`);
    expect(argv.slice(-3)).toEqual(["studio", "~/.polaris/bin/current/polaris", "bridge"]);
    expect(joined).not.toMatch(/HostName|IdentityFile|User=|Port=/);
  });

  test("the remote command can be replaced per Host", () => {
    expect(sshArgv("vm", { remoteCommand: ["polaris", "bridge"] }).slice(-3)).toEqual([
      "vm",
      "polaris",
      "bridge",
    ]);
  });

  test("agent forwarding is a per-Host toggle", () => {
    expect(sshArgv("pi", { forwardAgent: true }).join(" ")).toContain("-o ForwardAgent=yes");
  });
});

type Item = Data.TaggedEnum<{
  Snapshot: { readonly sequence: number };
  Event: { readonly sequence: number };
  Synchronized: { readonly sequence: number };
}>;

const { Snapshot, Event, Synchronized, $match } = Data.taggedEnum<Item>();

const mark = $match({
  Snapshot: (item): SequenceMark => ({ kind: "snapshot", sequence: item.sequence }),
  Event: (item): SequenceMark => ({ kind: "event", sequence: item.sequence }),
  Synchronized: (item): SequenceMark => ({ kind: "synchronized", sequence: item.sequence }),
});

class Disconnected {
  readonly _tag = "Disconnected";
}

describe("resumable feed", () => {
  test("resubscribes from the last sequence and drops replayed duplicates", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const opens: Array<number | null> = [];

          // Each "connection" replays one event it already sent, then fails as if dropped.
          const scripts: Array<Array<Item>> = [
            [Snapshot({ sequence: 0 }), Event({ sequence: 1 }), Event({ sequence: 2 })],
            [Event({ sequence: 2 }), Event({ sequence: 3 })],
            [Event({ sequence: 3 }), Event({ sequence: 4 }), Synchronized({ sequence: 4 })],
          ];

          let epoch = 0;

          const feed = yield* makeFeed<number, Item, Disconnected>({
            source: { next: (min) => Effect.succeed({ epoch: Math.max(min, epoch), client: 0 }) },
            open: (_client, after) => {
              opens.push(after);
              const script = scripts[epoch++];

              if (script === undefined) return Stream.never;

              return Stream.concat(Stream.fromIterable(script), Stream.fail(new Disconnected()));
            },
            mark,
            isDisconnect: (e) => e instanceof Disconnected,
            gapless: true,
          });

          const items = yield* feed.stream.pipe(Stream.take(6), Stream.runCollect);

          return { items, opens };
        })
      )
    );

    expect(result.items.map((i) => `${i._tag}:${i.sequence}`)).toEqual([
      "Snapshot:0",
      "Event:1",
      "Event:2",
      "Event:3",
      "Event:4",
      "Synchronized:4",
    ]);
    expect(result.opens.slice(0, 3)).toEqual([null, 2, 3]);
  });

  test("reopens on a gap in a gapless stream, and fails on other errors", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const opens: Array<number | null> = [];

          const feed = yield* makeFeed<number, Item, string>({
            source: { next: () => Effect.succeed({ epoch: 1, client: 0 }) },
            open: (_client, after) => {
              opens.push(after);

              return opens.length === 1
                ? Stream.fromIterable<Item>([Snapshot({ sequence: 5 }), Event({ sequence: 7 })])
                : Stream.fail("NotFound");
            },
            mark,
            isDisconnect: () => false,
            gapless: true,
          });

          const error = yield* feed.stream.pipe(Stream.runDrain, Effect.flip);

          return { error, opens };
        })
      )
    );

    expect(result.opens).toEqual([null, 5]);
    expect(result.error).toBe("NotFound");
  });

  // ENG-492: a chunk that fails to decode is a defect (`orDie`), not an RpcClientError.
  test("a defect on the upstream fails every subscriber and does not resubscribe", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let opens = 0;
          const undecodable = new Error("chunk failed to decode");
          const bothSubscribed = yield* Deferred.make<void>();

          const feed = yield* makeFeed<number, Item, Disconnected>({
            source: { next: () => Effect.succeed({ epoch: 1, client: 0 }) },
            open: () => {
              opens++;

              return Stream.fromIterable<Item>([
                Snapshot({ sequence: 1 }),
                Event({ sequence: 2 }),
              ]).pipe(
                Stream.concat(Stream.drain(Stream.fromEffect(Deferred.await(bothSubscribed)))),
                Stream.concat(Stream.die(undecodable))
              );
            },
            mark,
            isDisconnect: (e) => e instanceof Disconnected,
            gapless: false,
          });

          const subscriber = feed.stream.pipe(
            Stream.runCollect,
            Effect.exit,
            Effect.timeoutOption("1 second")
          );

          const both = yield* Effect.forkChild(
            Effect.all([subscriber, subscriber], { concurrency: "unbounded" })
          );

          while (feed.subscribers() < 2) yield* Effect.yieldNow;
          yield* Deferred.succeed(bothSubscribed, undefined);
          const [first, second] = yield* Fiber.join(both);

          return { first, second, opens, undecodable };
        })
      )
    );

    for (const outcome of [result.first, result.second]) {
      expect(Option.isSome(outcome)).toBe(true);
      const exit = Option.getOrThrow(outcome);
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(result.undecodable);
    }

    expect(result.opens).toBe(1);
  });

  // ENG-209 finding 1: the host stream leaves out session-only events, so its sequences have gaps.
  test("a stream with gaps (the host stream) is followed without reopening", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const opens: Array<number | null> = [];

          const feed = yield* makeFeed<number, Item, never>({
            source: { next: () => Effect.succeed({ epoch: 1, client: 0 }) },
            open: (_client, after) => {
              opens.push(after);

              return Stream.concat(
                Stream.fromIterable<Item>([
                  Snapshot({ sequence: 2 }),
                  Synchronized({ sequence: 2 }),
                  Event({ sequence: 4 }),
                  Event({ sequence: 7 }),
                ]),
                Stream.never
              );
            },
            mark,
            isDisconnect: () => false,
            gapless: false, // as HostConnection opens the host feed
          });

          const items = yield* feed.stream.pipe(Stream.take(4), Stream.runCollect);

          return { items, opens, last: feed.lastSequence() };
        })
      )
    );

    expect(result.items.map((i) => `${i._tag}:${i.sequence}`)).toEqual([
      "Snapshot:2",
      "Synchronized:2",
      "Event:4",
      "Event:7",
    ]);
    expect(result.opens).toEqual([null]);
    expect(result.last).toBe(7);
  });

  test("reopens that make no progress back off instead of looping hot", async () => {
    const opens = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const opens: Array<number | null> = [];

          // A gapless feed over a stream that always has the same gap: every reopen hits it again.
          const feed = yield* makeFeed<number, Item, never>({
            source: { next: () => Effect.succeed({ epoch: 1, client: 0 }) },
            open: (_client, after) => {
              opens.push(after);

              return Stream.fromIterable<Item>([
                ...(after === null ? [Snapshot({ sequence: 5 })] : []),
                Event({ sequence: 7 }),
              ]);
            },
            mark,
            isDisconnect: () => false,
            gapless: true,
          });

          yield* Effect.forkScoped(Stream.runDrain(feed.stream));
          yield* Effect.sleep(300);

          return opens;
        })
      )
    );

    // Without the backoff: thousands. With it: 0, 25, 50, 100, 200 ms…
    expect(opens.length).toBeGreaterThan(2);
    expect(opens.length).toBeLessThan(10);
    expect(opens.slice(1).every((after) => after === 5)).toBe(true);
  });

  test("the reopen backoff doubles from the first stalled reopen, up to a cap", () => {
    expect([0, 1, 2, 3].map(reopenBackoff)).toEqual([0, 25, 50, 100]);
    expect(reopenBackoff(50)).toBe(5_000);
  });

  test("a new subscriber gets the cached snapshot and events first", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* Queue.unbounded<Item>();

          const feed = yield* makeFeed<number, Item, never>({
            source: { next: () => Effect.succeed({ epoch: 1, client: 0 }) },
            open: () => Stream.fromQueue(live),
            mark,
            isDisconnect: () => false,
            gapless: true,
          });

          yield* Queue.offerAll(live, [Snapshot({ sequence: 1 }), Event({ sequence: 2 })]);
          yield* feed.stream.pipe(Stream.take(2), Stream.runDrain);

          const second = yield* Effect.forkChild(
            feed.stream.pipe(Stream.take(3), Stream.runCollect)
          );

          yield* Effect.sleep(20);
          yield* Queue.offer(live, Event({ sequence: 3 }));

          return yield* Fiber.join(second);
        })
      )
    );

    expect(items.map((i) => `${i._tag}:${i.sequence}`)).toEqual([
      "Snapshot:1",
      "Event:2",
      "Event:3",
    ]);
  });
});
