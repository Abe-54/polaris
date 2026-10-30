import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ByteTransport,
  type CdpMessage,
  CdpMessageDecoder,
  encodeCdpMessage,
  NO_DESKTOP_APP_MESSAGE,
  NoDesktopApp,
  parseCdpMessage,
  SessionId,
} from "@polaris/protocol";
import { type Cause, Context, Effect, Exit, Latch, Layer, Queue, Scope, Stream } from "effect";
import { shortTemp } from "../platform/testing.ts";
import {
  CdpRelay,
  type CdpRelayOptions,
  CdpSessionNotLive,
  RELAY_MAX_SOCKETS_PER_SESSION,
  type SessionPresence,
} from "./cdpRelay.ts";
import { BrowserHosting } from "./hosting.ts";
import { CdpRelayStore } from "./relayStore.ts";

const s1 = SessionId.make("session-one");

const s2 = SessionId.make("session-two");

/** The Desktop App's end of a `cdp` stream, in memory. */
interface DesktopEnd {
  readonly received: Array<CdpMessage>;
  readonly write: (bytes: Uint8Array) => void;
  readonly close: () => void;
}

const desktops = new Map<SessionId, DesktopEnd>();

const hosted = new Set<SessionId>([s1, s2]);

/** Session State as the relay sees it; sessions not listed are live. */
const presence = new Map<SessionId, SessionPresence>();

const sessions: CdpRelayOptions["sessions"] = {
  presence: (sessionId) => Effect.succeed(presence.get(sessionId) ?? "live"),
};

/** Closed to hold every Browser stream in its opening state. */
const opening = Latch.makeUnsafe(true);

const unused = () => Effect.die(new Error("not part of this test"));

const fakeHosting = Layer.succeed(BrowserHosting)(
  BrowserHosting.of({
    register: unused,
    claim: unused,
    release: unused,
    accept: unused,
    close: unused,
    credit: unused,
    awaitingClaims: () => 0,
    current: (sessionId) =>
      hosted.has(sessionId) ? Effect.succeed(1) : Effect.fail(new NoDesktopApp({ sessionId })),
    open: (sessionId) =>
      Effect.gen(function* () {
        if (!hosted.has(sessionId)) return yield* new NoDesktopApp({ sessionId });
        yield* opening.await;
        const toDesktop = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const toDaemon = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const decoder = new CdpMessageDecoder();
        const received: Array<CdpMessage> = [];
        yield* Stream.fromQueue(toDesktop).pipe(
          Stream.runForEach((chunk) => Effect.sync(() => received.push(...decoder.feed(chunk)))),
          Effect.forkScoped
        );
        desktops.set(sessionId, {
          received,
          write: (bytes) => void Queue.offerUnsafe(toDaemon, bytes),
          close: () => Queue.endUnsafe(toDaemon),
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            Queue.endUnsafe(toDesktop);
            Queue.endUnsafe(toDaemon);
          })
        );

        const transport: ByteTransport = {
          incoming: Stream.fromQueue(toDaemon),
          write: (bytes) => Effect.sync(() => void Queue.offerUnsafe(toDesktop, bytes)),
          close: Effect.sync(() => Queue.endUnsafe(toDesktop)),
        };

        return transport;
      }),
  })
);

const root = mkdtempSync(shortTemp("polaris-cdp-"));

const scope = Effect.runSync(Scope.make());

let relay: CdpRelay["Service"];

beforeAll(async () => {
  relay = await Effect.runPromise(
    Layer.build(CdpRelay.layer({ home: root, version: "0.0.0-test", sessions })).pipe(
      Effect.map((context) => Context.get(context, CdpRelay)),
      Effect.provide(fakeHosting),
      Scope.provide(scope)
    )
  );
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(root, { recursive: true, force: true });
});

const until = async (condition: () => boolean, what: string) => {
  const deadline = Date.now() + 4000;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

interface Agent {
  readonly socket: WebSocket;
  readonly messages: Array<CdpMessage | null>;
  readonly closed: Promise<{ code: number; reason: string }>;
}

const connect = async (url: string): Promise<Agent> => {
  const socket = new WebSocket(url);
  const messages: Array<CdpMessage | null> = [];
  socket.addEventListener("message", (event) => messages.push(parseCdpMessage(String(event.data))));

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason })
    );
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("connect failed")));
  });

  return { socket, messages, closed };
};

const httpOf = (url: string) => url.replace(/^ws:/, "http:");

test("the token guards the socket and discovery, and discovery is scoped to the session", async () => {
  const { url } = await Effect.runPromise(relay.issue(s1));
  const other = await Effect.runPromise(relay.issue(s2));
  expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/browser\/session-one\/[a-f0-9]{64}$/);
  expect(await Effect.runPromise(relay.issue(s1))).toEqual({ url });

  const store = await Effect.runPromise(
    Layer.build(CdpRelayStore.layer(join(root, "browser-cdp.sqlite"))).pipe(
      Effect.map((c) => Context.get(c, CdpRelayStore)),
      Scope.provide(scope)
    )
  );

  await Effect.runPromise(
    store.remember(s1, [{ targetId: "t1", url: "http://localhost:3000/", title: "App" }])
  );
  await Effect.runPromise(
    store.remember(s2, [{ targetId: "t2", url: "http://localhost:4000/", title: "Other" }])
  );

  const base = httpOf(url);
  const wrongToken = base.replace(/[a-f0-9]{64}$/, "0".repeat(64));
  expect((await fetch(`${wrongToken}/json/version`)).status).toBe(401);
  expect((await fetch(`${base.replace(/\/browser\/.*$/, "")}/json/version`)).status).toBe(404);
  expect(
    (await fetch(`${base}/json/version`, { headers: { origin: "http://evil.example" } })).status
  ).toBe(403);
  // Another session's token does not open this session's path.
  const crossed = base.replace(/[a-f0-9]{64}$/, other.url.slice(-64));
  expect((await fetch(`${crossed}/json/version`)).status).toBe(401);

  const version = await (await fetch(`${base}/json/version`)).json();
  expect(version).toEqual({
    Browser: "Polaris/0.0.0-test",
    "Protocol-Version": "1.3",
    webSocketDebuggerUrl: url,
  });
  const list = await (await fetch(`${base}/json/list`)).json();
  expect(list).toEqual([
    {
      id: "t1",
      type: "page",
      title: "App",
      url: "http://localhost:3000/",
      description: "",
      devtoolsFrontendUrl: "",
      webSocketDebuggerUrl: url,
    },
  ]);
  expect((await fetch(`${base}/json/version`, { method: "POST" })).status).toBe(405);
  expect((await fetch(base)).status).toBe(426);
}, 15_000);

test("messages relay compact in both directions; the relay's own messages never reach the agent", async () => {
  const { url } = await Effect.runPromise(relay.issue(s1));
  const agent = await connect(url);
  await until(() => desktops.has(s1), "the Browser stream");
  const desktop = desktops.get(s1)!;
  await until(() => desktop.received.length >= 1, "hello");
  expect(desktop.received[0]).toEqual({
    method: "Polaris.hello",
    params: { tabs: [{ targetId: "t1", url: "http://localhost:3000/", title: "App" }] },
  });

  agent.socket.send('{\n  "id": 1,\n  "method": "Target.getTargets"\n}');
  await until(() => desktop.received.length >= 2, "the agent's command");
  expect(desktop.received[1]).toEqual({ id: 1, method: "Target.getTargets" });

  const reply = encodeCdpMessage({ id: 1, result: { targetInfos: [] } });

  const tabs = encodeCdpMessage({
    method: "Polaris.tabs",
    params: { tabs: [{ targetId: "t9", url: "http://localhost:3000/next", title: "Next" }] },
  });

  const created = encodeCdpMessage({ method: "Target.targetCreated", params: { targetInfo: {} } });
  // Chunk boundaries fall anywhere: inside a message, and across two messages.
  desktop.write(reply.subarray(0, 9));
  const rest = new Uint8Array(reply.length - 9 + tabs.length + 5);
  rest.set(reply.subarray(9));
  rest.set(tabs, reply.length - 9);
  rest.set(created.subarray(0, 5), reply.length - 9 + tabs.length);
  desktop.write(rest);
  desktop.write(created.subarray(5));
  await until(() => agent.messages.length >= 2, "two messages at the agent");
  expect(agent.messages).toEqual([
    { id: 1, result: { targetInfos: [] } },
    { method: "Target.targetCreated", params: { targetInfo: {} } },
  ]);

  expect(await (await fetch(`${httpOf(url)}/json/list`)).json()).toEqual([
    {
      id: "t9",
      type: "page",
      title: "Next",
      url: "http://localhost:3000/next",
      description: "",
      devtoolsFrontendUrl: "",
      webSocketDebuggerUrl: url,
    },
  ]);

  agent.socket.send("not json");
  await until(() => agent.messages.length >= 3, "the parse error");
  expect(agent.messages[2]).toEqual({
    id: null,
    error: { code: -32000, message: "Message must be a CDP message" },
  });

  // The relay's private vocabulary is refused from the agent's side, not forwarded.
  agent.socket.send('{"id":7,"method":"Polaris.hello","params":{"tabs":[]}}');
  await until(() => agent.messages.length >= 4, "the reserved-method error");
  expect(agent.messages[3]).toEqual({
    id: 7,
    error: { code: -32000, message: "Polaris.* is reserved" },
  });
  expect(desktop.received).toHaveLength(2);

  desktop.close();
  const closed = await agent.closed;
  expect(closed.code).toBe(1000);
}, 15_000);

test("with no Desktop App the first command fails with the product copy and the socket closes", async () => {
  hosted.delete(s2);
  const { url } = await Effect.runPromise(relay.issue(s2));
  expect((await fetch(`${httpOf(url)}/json/version`)).status).toBe(503);
  expect(await (await fetch(`${httpOf(url)}/json/version`)).text()).toBe(NO_DESKTOP_APP_MESSAGE);

  const agent = await connect(url);
  agent.socket.send(JSON.stringify({ id: 7, method: "Browser.getVersion" }));
  const closed = await agent.closed;
  expect(agent.messages).toEqual([
    { id: 7, error: { code: -32000, message: NO_DESKTOP_APP_MESSAGE } },
  ]);
  expect(closed.code).toBe(1011);
  expect(closed.reason).toBe(NO_DESKTOP_APP_MESSAGE);
}, 15_000);

test("revoking closes the session's sockets, refuses its URL, and issues a fresh one", async () => {
  const { url } = await Effect.runPromise(relay.issue(s1));
  const agent = await connect(url);
  await until(() => desktops.get(s1)?.received.length === 1, "hello");
  await Effect.runPromise(relay.revoke(s1));
  const closed = await agent.closed;
  expect(closed.code).toBe(1008);
  expect((await fetch(`${httpOf(url)}/json/version`)).status).toBe(401);
  const next = await Effect.runPromise(relay.issue(s1));
  expect(next.url).not.toBe(url);
  expect((await fetch(`${httpOf(next.url)}/json/version`)).status).toBe(200);
}, 15_000);

test("only token hashes persist; a restarted store still authenticates an issued token", async () => {
  const path = join(mkdtempSync(shortTemp("polaris-cdp-store-")), "browser-cdp.sqlite");

  const once = <A, E>(body: (store: CdpRelayStore["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* body(yield* CdpRelayStore);
      }).pipe(Effect.provide(CdpRelayStore.layer(path)))
    );

  const token = await once((store) => store.issue(s1));
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(path).includes(Buffer.from(token))).toBe(false);
  expect(await once((store) => store.authenticate(s1, token))).toBe(true);
  expect(await once((store) => store.authenticate(s2, token))).toBe(false);
  // A restart issues a new token for new agents; the old one keeps working until revoked.
  const reissued = await once((store) => store.issue(s1));
  expect(reissued).not.toBe(token);
  expect(await once((store) => store.authenticate(s1, token))).toBe(true);
  await once((store) => store.revoke(s1));
  expect(await once((store) => store.authenticate(s1, token))).toBe(false);
  expect(await once((store) => store.authenticate(s1, reissued))).toBe(false);
}, 15_000);

test("a flooding agent is closed: too many commands held while the stream opens, or too many sockets", async () => {
  const { url } = await Effect.runPromise(relay.issue(s1));
  opening.closeUnsafe();
  const held = await connect(url);

  for (let id = 1; id <= 65; id++)
    held.socket.send(
      JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: "1" } })
    );
  const closed = await held.closed;
  expect(closed.code).toBe(1009);
  expect(closed.reason).toBe("input buffer full");

  const big = await connect(url);
  big.socket.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "x".repeat(1024 * 1024 + 1) },
    })
  );
  expect((await big.closed).code).toBe(1009);
  opening.openUnsafe();

  const agents = [];

  for (let i = 0; i < RELAY_MAX_SOCKETS_PER_SESSION; i++) agents.push(await connect(url));
  const extra = await connect(url);
  const refused = await extra.closed;
  expect(refused.code).toBe(1013);
  expect(refused.reason).toBe("too many connections");
  agents.forEach((agent) => agent.socket.close());
  await Promise.all(agents.map((agent) => agent.closed));
  // The refused socket never counted: the next one is admitted.
  const again = await connect(url);
  await until(() => desktops.get(s1)?.received.length === 1, "hello");
  again.socket.close();
}, 15_000);

test("a token is issued and admitted only for a live session, and dies with the session", async () => {
  const s3 = SessionId.make("session-three");
  const unknown = SessionId.make("session-nobody");
  hosted.add(s3);
  presence.set(unknown, "unknown");
  const refused = await Effect.runPromise(Effect.flip(relay.issue(unknown)));
  expect(refused).toBeInstanceOf(CdpSessionNotLive);
  expect([refused.sessionId, refused.presence]).toEqual([unknown, "unknown"]);

  const { url } = await Effect.runPromise(relay.issue(s3));
  const agent = await connect(url);
  await until(() => desktops.get(s3)?.received.length === 1, "hello");
  // Archived without the live event reaching the relay: the next request sees it.
  presence.set(s3, "archived");
  expect((await fetch(`${httpOf(url)}/json/version`)).status).toBe(401);
  expect((await agent.closed).code).toBe(1008);

  const admitted = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(url);
    socket.addEventListener("error", () => resolve(false));
    socket.addEventListener("open", () => resolve(true));
  });

  expect(admitted).toBe(false);
  const gone = await Effect.runPromise(Effect.flip(relay.issue(s3)));
  expect(gone.presence).toBe("archived");
}, 15_000);

test("tokens of sessions archived while the Daemon was down die when it starts", async () => {
  const home = mkdtempSync(shortTemp("polaris-cdp-restart-"));
  const s4 = SessionId.make("session-four");
  hosted.add(s4);

  const withRelay = <A>(body: (relay: CdpRelay["Service"]) => Promise<A>) =>
    Effect.runPromise(
      Effect.scoped(
        Layer.build(CdpRelay.layer({ home, version: "0.0.0-test", sessions })).pipe(
          Effect.flatMap((context) => Effect.promise(() => body(Context.get(context, CdpRelay)))),
          Effect.provide(fakeHosting)
        )
      )
    );

  const url = await withRelay(async (first) => (await Effect.runPromise(first.issue(s4))).url);
  presence.set(s4, "archived");
  await withRelay(async (second) => {
    // Same token, same session: refused before any socket or event, by the startup sweep.
    const sameToken = url.slice(url.lastIndexOf("/") + 1);

    const store = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* CdpRelayStore).authenticate(s4, sameToken);
      }).pipe(Effect.provide(CdpRelayStore.layer(join(home, "browser-cdp.sqlite"))))
    );

    expect(store).toBe(false);
    const gone = await Effect.runPromise(Effect.flip(second.issue(s4)));
    expect(gone.presence).toBe("archived");
  });
  rmSync(home, { recursive: true, force: true });
}, 15_000);
