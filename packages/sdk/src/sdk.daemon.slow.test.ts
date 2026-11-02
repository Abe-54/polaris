/**
 * The SDK against the real Daemon over its socket (ENG-403): an Extension
 * paired by a token-less Client sees its Host, starts a session, answers its
 * approval and sends a Turn; a narrower Grant is refused with the Grant it
 * lacks; a revoked token can't connect; a feed survives a Daemon restart.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { launchDaemon, type TestDaemon } from "./daemon.testing.ts";
import {
  createPolaris,
  ExtensionTokenRejected,
  type HostView,
  HostUnreachable,
  NotGranted,
  openPolaris,
  parsePairing,
  type PolarisClient,
  type SessionView,
  type Transcript,
  VoiceError,
} from "./index.ts";

let daemon: TestDaemon;

const opened: Array<PolarisClient> = [];

beforeAll(async () => {
  daemon = await launchDaemon();
  // Local pairings open `$POLARIS_HOME/daemon.sock`.
  process.env.POLARIS_HOME = daemon.home;
}, 60_000);

afterAll(async () => {
  await Promise.all(opened.map((client) => client.close()));
  await daemon.stop();
});

const client = async (pairing: string) => {
  const polaris = await createPolaris({ pairings: [pairing], clientName: "sdk-tests" });

  opened.push(polaris);

  return polaris;
};

/** The first item of `feed` that satisfies `done`; fails after `ms`. */
const until = async <A>(feed: AsyncIterable<A>, done: (item: A) => boolean, ms = 20_000) => {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timed out waiting for the feed")), ms)
  );

  const first = (async () => {
    for await (const item of feed) if (done(item)) return item;
    throw new Error("the feed ended");
  })();

  return Promise.race([first, timeout]);
};

/** The `Expected` error `promise` rejected with; fails the test on anything else. */
const rejection = async <Expected>(
  promise: Promise<unknown>,
  expected: abstract new (...args: never) => Expected
): Promise<Expected> => {
  const outcome = await promise.then(
    () => null,
    (error: Error) => error
  );

  if (!(outcome instanceof expected))
    throw new Error(`expected ${expected.name}, got ${String(outcome)}`);

  return outcome;
};

/** A bench Harness Turn: one item, behind an approval, no pacing. */
const APPROVAL_PROMPT = 'bench:{"items":1,"approvalEvery":1,"deltaIntervalMs":0}';

describe.each(["socket", "gateway"] as const)(
  "an Extension with every Grant, over the %s",
  (via) => {
    let polaris: PolarisClient;
    let workspaceId: string;

    beforeAll(async () => {
      workspaceId = await daemon.registerWorkspace();
      polaris = await client(await daemon.pair("Full", ["read", "approve", "turn", "start"], via));
    }, 30_000);

    test("sees the Host's Workspaces", async () => {
      const view = await until(polaris.subscribeHost(daemon.hostId), (v) =>
        v.workspaces.some((w) => w.id === workspaceId)
      );

      expect(view.connected).toBe(true);
      expect(polaris.hosts.map((host) => host.hostId)).toEqual([daemon.hostId]);
    }, 30_000);

    test("starts a session, answers its approval and sends a Turn", async () => {
      const sessionId = await polaris.startSession(daemon.hostId, {
        workspaceId,
        harness: "claude",
        prompt: APPROVAL_PROMPT,
      });

      const waiting = await until(polaris.subscribeHost(daemon.hostId), (v: HostView) =>
        v.approvals.some((a) => a.sessionId === sessionId)
      );

      const approval = waiting.approvals.find((a) => a.sessionId === sessionId);

      if (approval === undefined) throw new Error("no approval");
      await polaris.respondToApproval(daemon.hostId, sessionId, approval.id, { kind: "allow" });

      const first = await until(
        polaris.subscribeSession(daemon.hostId, sessionId),
        (v: SessionView) =>
          v.session.state === "idle" &&
          v.turns[0]?.items.length === 1 &&
          v.pendingApprovals.length === 0
      );

      expect(first.turns.map((t) => t.turn.prompt)).toEqual([APPROVAL_PROMPT]);

      await polaris.sendTurn(daemon.hostId, sessionId, "and again");

      const second = await until(
        polaris.subscribeSession(daemon.hostId, sessionId),
        (v: SessionView) => v.turns.length === 2 && v.session.state === "idle"
      );

      expect(second.turns.map((t) => t.turn.prompt)).toEqual([APPROVAL_PROMPT, "and again"]);
    }, 60_000);
  }
);

describe("an Extension with read only", () => {
  test("is refused a Turn with the Grant it lacks, through both APIs", async () => {
    const pairing = await daemon.pair("Reader", ["read"]);
    const polaris = await client(pairing);
    const view = await until(polaris.subscribeHost(daemon.hostId), () => true);
    const sessionId = view.sessions[0]?.session.id ?? "missing";
    const refusal = await rejection(polaris.sendTurn(daemon.hostId, sessionId, "hi"), NotGranted);

    expect(refusal.needed).toBe("turn");

    const viaEffect = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(openPolaris({ pairings: [pairing], clientName: "sdk-tests" }), (p) =>
          p.interrupt(daemon.hostId, sessionId).pipe(
            Effect.as(null),
            Effect.catchTag("NotGranted", (error) => Effect.succeed(error.needed))
          )
        )
      )
    );

    expect(viaEffect).toBe("turn");
  }, 30_000);
});

test("a revoked pairing can't connect", async () => {
  const pairing = await daemon.pair("Revoked", ["read"]);

  await daemon.revoke(pairing);
  const polaris = await client(pairing);
  const error = await rejection(polaris.connect(daemon.hostId), ExtensionTokenRejected);

  expect(error.reason).toBe("revoked");
}, 30_000);

test("a Host feed reconnects after the Daemon restarts and keeps applying events", async () => {
  const polaris = await client(await daemon.pair("Restarts", ["read"]));
  const views: Array<HostView> = [];
  const feed = polaris.subscribeHost(daemon.hostId)[Symbol.asyncIterator]();

  const next = async () => {
    const result = await feed.next();

    if (result.done === true) throw new Error("the feed ended");
    views.push(result.value);

    return result.value;
  };

  await next();
  await daemon.restart();
  const workspaceId = await daemon.registerWorkspace();

  while (!views.at(-1)?.workspaces.some((w) => w.id === workspaceId)) await next();

  expect(views.some((v) => !v.connected)).toBe(true);
  expect(views.at(-1)?.connected).toBe(true);
  await feed.return?.();
}, 60_000);

test("closing the client ends an idle Host feed", async () => {
  const polaris = await client(await daemon.pair("Closes", ["read"]));
  const feed = polaris.subscribeHost(daemon.hostId)[Symbol.asyncIterator]();

  await feed.next();
  const pending = feed.next();

  await polaris.close();
  expect(await pending).toMatchObject({ done: true });
});

test("a rejected pairing falls back to another pairing for the same Host", async () => {
  const revoked = await daemon.pair("Fallback revoked", ["read"], "gateway");
  const valid = await daemon.pair("Fallback valid", ["read"], "gateway");

  await daemon.revoke(revoked);
  const polaris = await createPolaris({ pairings: [revoked, valid], clientName: "fallback" });

  opened.push(polaris);
  const view = await until(polaris.subscribeHost(daemon.hostId), () => true);

  expect(view.connected).toBe(true);
  expect(polaris.hosts.map((host) => host.hostId)).toEqual([daemon.hostId]);
});

test("multiple Hosts keep their own Workspaces and a refused Host stays separate", async () => {
  const other = await launchDaemon();

  try {
    const localWorkspace = await daemon.registerWorkspace();
    const otherWorkspace = await other.registerWorkspace();
    const local = await daemon.pair("Local merged", ["read"], "gateway");
    const remote = await other.pair("Other merged", ["read"], "gateway");

    const polaris = await createPolaris({
      pairings: [local, remote, { ...parsePairing(local), hostId: "wrong-host" }],
      clientName: "multi-host",
    });

    opened.push(polaris);

    const views = await until(polaris.subscribeHosts(), (views) => views.length === 3);

    const workspacesOf = (hostId: string) =>
      views.find((view) => view.hostId === hostId)?.workspaces.map((w) => String(w.id));

    expect(workspacesOf(daemon.hostId)).toContain(localWorkspace);
    expect(workspacesOf(daemon.hostId)).not.toContain(otherWorkspace);
    expect(workspacesOf(other.hostId)).toEqual([otherWorkspace]);
    expect(views.find((view) => view.hostId === "wrong-host")).toMatchObject({
      connected: false,
      workspaces: [],
      sessions: [],
    });
    expect(views.find((view) => view.hostId === "wrong-host")?.error).toBeInstanceOf(
      HostUnreachable
    );
    await polaris.close();
  } finally {
    await other.stop();
  }
}, 60_000);

describe("transcribe", () => {
  /** Half a second of silence, in the 16 kHz s16le mono PCM `transcribe` takes. */
  async function* silence() {
    for (let chunk = 0; chunk < 5; chunk++) yield new Uint8Array(3200);
  }

  const collect = async (feed: AsyncIterable<Transcript>) => {
    const seen: Array<Transcript> = [];

    for await (const transcript of feed) seen.push(transcript);

    return seen;
  };

  test("reaches the Host's voice relay over the gateway, which says no key is set", async () => {
    const polaris = await client(await daemon.pair("Voice", ["voice"], "gateway"));

    const error = await rejection(
      collect(polaris.transcribe(daemon.hostId, silence())),
      VoiceError
    );

    expect(error.reason).toBe("no-key");
  }, 30_000);

  test("without the voice Grant is refused with the Grant it lacks", async () => {
    const polaris = await client(await daemon.pair("No voice", ["read"], "gateway"));

    const error = await rejection(
      collect(polaris.transcribe(daemon.hostId, silence())),
      NotGranted
    );

    expect(error.needed).toBe("voice");
  }, 30_000);
});
