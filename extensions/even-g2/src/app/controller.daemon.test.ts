/**
 * The glasses app against the real Daemon over its gateway, with fake glasses
 * at the bridge: sessions on the list, an approval jumping to the front and
 * answered from the menu, a Grant it lacks, and voice through `transcribe`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPolaris, type HostView, type PolarisClient, type Transcript } from "@polaris/sdk";
import { launchDaemon, type TestDaemon } from "../../../../packages/sdk/src/daemon.testing.ts";
import { fakeGlasses, type FakeGlasses } from "../glasses/fake.testing.ts";
import { type App, startApp } from "./controller.ts";

/** Bench Harness Turns: one item, behind an approval or not. */
const APPROVAL = { items: 1, approvalEvery: 1, deltaIntervalMs: 0 };

const QUICK = { items: 1, deltaIntervalMs: 0 };

let daemon: TestDaemon;

let workspaceId: string;

let admin: PolarisClient;

const cleanups: Array<() => Promise<void>> = [];

const connect = async (pairings: ReadonlyArray<string>) => {
  const polaris = await createPolaris({
    pairings,
    clientName: "even-g2-tests",
    computerUse: true,
  });

  cleanups.push(() => polaris.close());

  return polaris;
};

beforeAll(async () => {
  daemon = await launchDaemon();
  workspaceId = await daemon.registerWorkspace();
  admin = await connect([
    await daemon.pair("Admin", ["read", "approve", "turn", "start"], "gateway"),
  ]);
}, 60_000);

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  await daemon.stop();
});

const until = async <A>(feed: AsyncIterable<A>, done: (item: A) => boolean) => {
  for await (const item of feed) if (done(item)) return item;
  throw new Error("the feed ended");
};

const hostView = (done: (view: HostView) => boolean) =>
  until(admin.subscribeHost(daemon.hostId), done);

let made = 0;

/** A bench Turn; the tag makes each session's prompt, and so its title, its own. */
interface BenchScript {
  readonly items: number;
  readonly deltaIntervalMs: number;
  readonly approvalEvery?: number;
  readonly approvalApp?: { readonly kind: "app" | "headed-input"; readonly name: string };
}

const bench = (script: BenchScript) => `bench:${JSON.stringify({ ...script, tag: ++made })}`;

const startSession = async (prompt: string) => {
  const sessionId = await admin.startSession(daemon.hostId, {
    workspaceId,
    harness: "claude",
    prompt,
  });

  await hostView((view) =>
    view.sessions.some(
      (s) =>
        s.session.id === sessionId && (s.session.state === "idle" || s.pendingApprovals.length > 0)
    )
  );

  return sessionId;
};

const titleOf = async (sessionId: string) =>
  (await hostView(() => true)).sessions.find((s) => s.session.id === sessionId)?.session.title ??
  "";

/** Opens a session from the list by its title. */
const open = async (glasses: FakeGlasses, title: string) => {
  await glasses.until((g) => g.rows().some((row) => row.includes(title)), `${title} in the list`);
  glasses.send({ kind: "click", index: glasses.rows().findIndex((row) => row.includes(title)) });
  await glasses.until((g) => g.text().startsWith(title), title);
};

const launch = async (
  grant: Parameters<TestDaemon["pair"]>[1],
  wrap: (client: PolarisClient) => PolarisClient = (client) => client
): Promise<{ readonly app: App; readonly glasses: FakeGlasses }> => {
  const glasses = fakeGlasses();
  const pairing = await daemon.pair("Even G2", grant, "gateway");

  const app = startApp({
    glasses,
    connect: async (pairings) => wrap(await connect(pairings)),
    renderDelayMs: 10,
  });

  cleanups.push(() => app.close());
  await app.pair([pairing]);

  return { app, glasses };
};

test("lists the Host's sessions, jumps to a new approval and approves it from the menu", async () => {
  const idle = await startSession(bench(QUICK));
  const { app, glasses } = await launch(["read", "approve", "turn"]);

  await glasses.until((g) => g.rows().some((row) => row.startsWith("Idle · ")), "the idle session");
  await app.reconnect();
  const waiting = await startSession(bench(APPROVAL));
  const title = await titleOf(waiting);

  await glasses.until(
    (g) => g.text().startsWith(title) && g.text().includes("Approval: "),
    "the approval"
  );
  expect(app.state().screen).toEqual({
    kind: "session",
    key: { hostId: daemon.hostId, sessionId: waiting },
  });

  glasses.send({ kind: "click", index: 0 });
  await glasses.until((g) => g.rows()[0] === "Approve", "the menu");
  glasses.send({ kind: "click", index: 0 });
  await glasses.until((g) => g.text().includes("\nApproved"), "the outcome");

  const after = await hostView((view) => !view.approvals.some((a) => a.sessionId === waiting));

  expect(after.sessions.find((s) => s.session.id === idle)?.session.state).toBe("idle");
}, 60_000);

test.each([
  { kind: "app", line: "Use Simulator?" },
  { kind: "headed-input", line: "Take mouse and keyboard?" },
] as const)(
  "answers a $kind approval with Allow once, which the Daemon takes",
  async (c) => {
    const { glasses } = await launch(["read", "approve", "turn"]);

    await glasses.until((g) => g.rows().length > 0, "the list");

    const waiting = await startSession(
      bench({ ...APPROVAL, approvalApp: { kind: c.kind, name: "Simulator" } })
    );

    const title = await titleOf(waiting);

    await glasses.until((g) => g.text().startsWith(title) && g.text().includes(c.line), c.line);
    glasses.send({ kind: "click", index: 0 });
    await glasses.until((g) => g.rows()[0] === "Allow once", "the menu");
    expect(glasses.rows().slice(0, 2)).toEqual(["Allow once", "Deny"]);
    glasses.send({ kind: "click", index: 0 });
    await glasses.until((g) => g.text().includes("\nApproved"), "the outcome");
    await hostView((view) => !view.approvals.some((a) => a.sessionId === waiting));
  },
  60_000
);

test("a pairing without the approve Grant says which Grant to pair again with", async () => {
  const { glasses } = await launch(["read"]);

  await glasses.until((g) => g.rows().length > 0, "the list");
  const waiting = await startSession(bench(APPROVAL));
  const title = await titleOf(waiting);

  await glasses.until(
    (g) => g.text().startsWith(title) && g.text().includes("Approval: "),
    "the approval"
  );
  glasses.send({ kind: "click", index: 0 });
  await glasses.until((g) => g.rows()[0] === "Approve", "the menu");
  glasses.send({ kind: "click", index: 0 });
  await glasses.until(
    (g) => g.text().includes("Not allowed: pair again with the approve grant"),
    "the refusal"
  );

  const view = await hostView(() => true);

  expect(view.approvals.some((a) => a.sessionId === waiting)).toBe(true);
}, 60_000);

describe("voice", () => {
  /** The speech provider's side: hears the glasses' audio and reports how much arrived. */
  const fakeProvider =
    (heard: Array<number>) =>
    (client: PolarisClient): PolarisClient => ({
      ...client,
      transcribe: async function* (_hostId: string, audio: AsyncIterable<Uint8Array>) {
        let bytes = 0;

        for await (const chunk of audio) {
          bytes += chunk.length;
          yield { finalText: "", interimText: "run the", finished: false } satisfies Transcript;
        }

        heard.push(bytes);
        yield { finalText: "run the tests", interimText: "", finished: true } satisfies Transcript;
      },
    });

  const toVoice = async (glasses: FakeGlasses, sessionId: string) => {
    await open(glasses, await titleOf(sessionId));
    glasses.send({ kind: "long-press" });
    await glasses.until((g) => g.microphoneOn() && g.text().startsWith("Listening"), "listening");
    glasses.send({ kind: "audio", pcm: new Uint8Array(3200) });
    glasses.send({ kind: "audio", pcm: new Uint8Array(3200) });
    await glasses.until((g) => g.text().includes("run the"), "interim text");
    glasses.send({ kind: "long-press-release" });
    await glasses.until((g) => g.rows().join() === "Send,Retry,Cancel", "the transcript");
  };

  const turnsOf = async (sessionId: string) =>
    (await hostView(() => true)).sessions.find((s) => s.session.id === sessionId)?.session
      .turnCount ?? -1;

  test("streams the glasses' audio, shows the transcript, and sends it only on Send", async () => {
    const sessionId = await startSession(bench(QUICK));
    const heard: Array<number> = [];
    const { glasses } = await launch(["read", "turn"], fakeProvider(heard));

    await toVoice(glasses, sessionId);
    expect(heard).toEqual([6400]);
    expect(glasses.microphoneOn()).toBe(false);
    expect(glasses.text()).toBe("run the tests");

    const before = await turnsOf(sessionId);

    glasses.send({ kind: "click", index: 2 });
    await glasses.until((g) => g.text().includes("Tap: actions"), "the session");
    expect(await turnsOf(sessionId)).toBe(before);

    glasses.send({ kind: "long-press" });
    await glasses.until((g) => g.microphoneOn(), "listening again");
    glasses.send({ kind: "long-press-release" });
    await glasses.until((g) => g.rows()[0] === "Send", "the transcript");
    glasses.send({ kind: "click", index: 0 });
    await glasses.until((g) => g.text().includes("\nSent"), "sent");
    await hostView((view) =>
      view.sessions.some((s) => s.session.id === sessionId && s.lastTurnPreview === "run the tests")
    );
  }, 60_000);

  test("says so when the Host has no speech-to-text key", async () => {
    const sessionId = await startSession(bench(QUICK));
    const { glasses } = await launch(["read", "turn", "voice"]);

    await open(glasses, await titleOf(sessionId));
    glasses.send({ kind: "long-press" });
    glasses.send({ kind: "audio", pcm: new Uint8Array(3200) });
    glasses.send({ kind: "long-press-release" });
    await glasses.until((g) => g.rows().join() === "Retry,Cancel", "the failure");
    expect(glasses.text().toLowerCase()).toContain("key");
    expect(glasses.microphoneOn()).toBe(false);
  }, 60_000);
});
