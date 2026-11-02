/**
 * Push end to end: a Daemon with the Relay route on, the real relay process, the site's push
 * route (`apps/site/scripts/pushDev.ts`, fake provider token) and a fake APNs over h2c. A
 * linked device registers, goes offline, gets a sealed Needs You it alone can open, and
 * answers through the relay; nothing the relay logs holds the content or the token.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  Actor,
  ApprovalDecision,
  Command,
  CommandId,
  DaemonRpcs,
  type HostStreamItem,
  RequestId,
  type RelayRouteStatus,
} from "@polaris/protocol";
import { decodePushMessage, fromBase64Url, toBase64Url } from "@polaris/protocol/relay";
import { signPushTicket } from "@polaris/protocol/relay/party";
import { Effect, Layer, Option, PubSub, Schema, Scope, Stream } from "effect";
import { actorOf } from "../extensions/connection.ts";
import {
  DeviceSocket,
  handshake,
  link,
  makeDevice,
  sessionTransport,
  startRelay,
  type TestDevice,
} from "../linkedDevices/device.testing.ts";
import { HostSecrets } from "../secrets/index.ts";
import { ServerRpcs } from "../transport/rpcs.ts";
import { startServer } from "../transport/server.ts";
import { PushHostEvents, PushNotifier } from "./notifier.ts";
import {
  approvalRequested,
  notified,
  SESSION_ID,
  snapshot,
  synchronized,
  turnEnded,
} from "./push.testing.ts";
import { openPush, pushSuite } from "./seal.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

const decodeApnsBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ aps: Schema.Unknown, p: Schema.String }))
);

const SECRET = "push-e2e-secret-0123456789abcdef0123";

const TOKEN = "be".repeat(32);

interface ApnsHit {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const apnsHits: Array<ApnsHit> = [];

/** The status the fake APNs answers next; 200 unless a test sets it. */
let apnsStatus = 200;

const apns = createServer();

apns.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
  let body = "";
  stream.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
  stream.on("end", () => {
    apnsHits.push({ headers, body });
    const status = apnsStatus;
    stream.respond({ ":status": status });
    stream.end(status === 200 ? "" : JSON.stringify({ reason: "Unregistered" }));
  });
});

let relay: Awaited<ReturnType<typeof startRelay>>;

let pushService: { readonly stop: () => void; readonly log: () => string };

const startPushService = async (apnsOrigin: string) => {
  const child = Bun.spawn(["bun", "scripts/pushDev.ts"], {
    cwd: join(import.meta.dir, "../../../site"),
    env: {
      ...process.env,
      PORT: "0",
      POLARIS_PUSH_SECRET: SECRET,
      POLARIS_PUSH_APNS_SANDBOX: apnsOrigin,
    },
    stdout: "pipe",
    stderr: "inherit",
  });

  const reader = child.stdout.getReader();
  let text = "";

  while (!text.includes("push.dev.start")) {
    const { value, done } = await reader.read();

    if (done) throw new Error("the push service exited");
    text += new TextDecoder().decode(value);
  }

  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;
      text += new TextDecoder().decode(value);
    }
  })();

  const port = Number(/"port":(\d+)/.exec(text)?.[1]);

  return { port, stop: () => child.kill("SIGTERM"), log: () => text };
};

beforeAll(async () => {
  const origin = await new Promise<string>((resolve) =>
    apns.listen(0, "127.0.0.1", () =>
      // SAFETY: a listening TCP server's address is an AddressInfo.
      resolve(`http://127.0.0.1:${(apns.address() as AddressInfo).port}`)
    )
  );

  const service = await startPushService(origin);
  pushService = service;
  relay = await startRelay(undefined, {
    POLARIS_RELAY_PUSH_URL: `http://127.0.0.1:${service.port}/api/push`,
    POLARIS_RELAY_PUSH_SECRET: SECRET,
  });
});

afterAll(async () => {
  await relay.stop();
  pushService.stop();
  apns.close();
});

const waitFor = async <A>(probe: () => A | undefined, what: string, ms = 10_000): Promise<A> => {
  const deadline = Date.now() + ms;

  for (;;) {
    const found = probe();

    if (found !== undefined) return found;

    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

const hello = { clientName: "test", clientVersion: "0", deviceLabel: "test", capabilities: [] };

const key = (text: string) => Option.getOrThrow(fromBase64Url(text));

test("a Needs You reaches an offline linked device sealed, and its answer comes back through the relay", async () => {
  const answers: Array<{ readonly command: Command; readonly actor: Actor }> = [];
  // Like the Engine's: live events reach only current subscribers.
  const events = Effect.runSync(PubSub.unbounded<HostStreamItem>());
  const feed = (item: HostStreamItem) => Effect.runSync(PubSub.publish(events, item));

  const handlers = Layer.mergeAll(
    ServerRpcs.toLayerHandler("dispatch", ({ command }, { client }) =>
      Effect.sync(() => {
        answers.push({ command, actor: actorOf(client) });

        return { sequence: null };
      })
    ),
    PushNotifier.pipe(
      Layer.provide(
        // Like the Engine's: every subscription starts with a Snapshot and Synchronized.
        Layer.succeed(PushHostEvents)({
          subscribe: () =>
            Stream.concat(Stream.make(snapshot(), synchronized()), Stream.fromPubSub(events)),
        })
      )
    )
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const root = newTempDir("pl-push-", { short: true });
        yield* Scope.addFinalizer(
          scope,
          Effect.promise(() => removeTempDirSettled(root))
        );

        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          handlers,
          secrets: HostSecrets.memory(),
        });

        const desktop = (yield* connectRpcWith(
          DaemonRpcs,
          yield* socketTransport(server.socketPath)
        )).client;

        yield* desktop.hello(hello);
        yield* desktop["relayRoute.enable"]({ url: relay.url });
        let status: RelayRouteStatus = yield* desktop["relayRoute.status"]();

        for (let i = 0; i < 400 && !status.connected; i++) {
          yield* Effect.sleep("25 millis");
          status = yield* desktop["relayRoute.status"]();
        }

        const phone: TestDevice = yield* Effect.promise(makeDevice);
        const offer = yield* desktop["devices.link"]();
        yield* Effect.promise(() => link(offer.linkString, phone, "Test iPhone"));
        const device = yield* desktop["devices.awaitLink"]({ linkId: offer.linkId });

        const openDevice = Effect.gen(function* () {
          const socket = yield* Effect.promise(() =>
            DeviceSocket.connect(relay.url, phone.identity)
          );

          const host = { address: status.hostAddress, noiseKey: key(status.hostNoiseKey) };
          const session = yield* Effect.promise(() => handshake(socket, host, phone.noise));

          if (session === null) throw new Error("the linked device was refused");

          const connection = yield* connectRpcWith(
            DaemonRpcs,
            sessionTransport(socket, status.hostAddress, session)
          );

          yield* connection.client.hello(hello);

          return { socket, client: connection.client };
        });

        // The device registers with a P-256 push key, as the app's Keychain holds it.
        const keys = yield* Effect.promise(() => pushSuite.kem.generateKeyPair());

        const pushKey = toBase64Url(
          new Uint8Array(
            yield* Effect.promise(() => pushSuite.kem.serializePublicKey(keys.publicKey))
          )
        );

        const registration = {
          token: TOKEN,
          environment: "sandbox" as const,
          pushKey,
          ticket: signPushTicket(phone.identity, status.hostAddress, "sandbox", TOKEN),
        };

        const phoneSide = yield* openDevice;

        // A ticket for another host's address, and the Desktop App registering, are refused.
        const otherHost = yield* Effect.promise(makeDevice);
        const wrongTicket = signPushTicket(phone.identity, otherHost.address, "sandbox", TOKEN);
        expect(
          (yield* Effect.flip(
            phoneSide.client["devices.registerPush"]({ ...registration, ticket: wrongTicket })
          )).reason
        ).toBe("failed");
        expect((yield* Effect.flip(desktop["devices.registerPush"](registration))).reason).toBe(
          "not-a-device"
        );

        yield* phoneSide.client["devices.registerPush"](registration);
        // The notifier subscribes once a device registers.
        yield* Effect.sleep("200 millis");
        // Offline from here: the phone is asleep.
        phoneSide.socket.close();
        feed(approvalRequested("r1"));

        const hit = yield* Effect.promise(() => waitFor(() => apnsHits[0], "the Needs You push"));
        expect(hit.headers).toMatchObject({
          ":path": `/3/device/${TOKEN}`,
          authorization: "bearer dev-provider-token",
          "apns-topic": "dev.lux.polaris.mobile",
          "apns-push-type": "alert",
        });
        const body = decodeApnsBody(hit.body);
        expect(body.aps).toEqual({
          alert: { title: "Polaris", body: "Open Polaris to see what changed." },
          "mutable-content": 1,
          sound: "default",
        });

        const opened = yield* Effect.promise(() => openPush(keys.privateKey, body.p));
        expect(Option.getOrThrow(decodePushMessage(opened))).toMatchObject({
          kind: "needs-you",
          hostId: server.hostInfo.hostId,
          sessionId: SESSION_ID,
          requestId: "r1",
          category: "approval",
          title: "Claude Code needs you",
          body: "Run bun test\nbun test apps/daemon",
        });

        yield* Effect.promise(() => relay.waitForLog('"outcome":"sent"'));

        // Neither the relay's log nor the push service's holds the content or the token.
        for (const log of [relay.log(), pushService.log()]) {
          expect(log).not.toContain("Run bun test");
          expect(log).not.toContain(TOKEN);
          expect(log).not.toContain(phone.address);
        }

        expect(relay.log()).toContain('"outcome":"sent"');

        // Always here, from the lock screen: the app wakes, reconnects and answers.
        const again = yield* openDevice;
        const decision = ApprovalDecision.cases.Allow.make({ remember: true });
        yield* again.client.dispatch({
          commandId: CommandId.make("answer-1"),
          command: Command.cases.RespondToApproval.make({
            sessionId: SESSION_ID,
            requestId: RequestId.make("r1"),
            decision,
          }),
        });
        expect(answers).toEqual([
          {
            command: Command.cases.RespondToApproval.make({
              sessionId: SESSION_ID,
              requestId: RequestId.make("r1"),
              decision,
            }),
            actor: Actor.cases.LinkedDevice.make({ deviceId: device.id, name: "Test iPhone" }),
          },
        ]);
        again.socket.close();

        // ENG-495: while the Desktop App reports the user present the push waits; away sends it.
        expect((yield* desktop["presence.report"]({ presence: "present" })).leaseMs).toBe(120_000);
        feed(approvalRequested("r-held"));
        yield* Effect.sleep("500 millis");
        expect(apnsHits).toHaveLength(1);
        yield* desktop["presence.report"]({ presence: "away" });

        const releasedHit = yield* Effect.promise(() =>
          waitFor(() => apnsHits[1], "the held Needs You push")
        );

        const released = yield* Effect.promise(() =>
          openPush(keys.privateKey, decodeApnsBody(releasedHit.body).p)
        );

        expect(Option.getOrThrow(decodePushMessage(released))).toMatchObject({
          kind: "needs-you",
          requestId: "r-held",
        });

        // A finished Turn follows once it settles.
        feed(turnEnded("t1", "All green"));

        const finished = yield* Effect.promise(() =>
          waitFor(() => apnsHits[2], "the finished Turn push")
        );

        const turnPush = yield* Effect.promise(() =>
          openPush(keys.privateKey, decodeApnsBody(finished.body).p)
        );

        expect(Option.getOrThrow(decodePushMessage(turnPush))).toMatchObject({
          kind: "turn-ended",
          body: "All green",
        });

        // With automatic notifications off on this device, only the agent's own notify arrives.
        const quiet = yield* openDevice;
        yield* quiet.client["devices.registerPush"]({ ...registration, automatic: false });
        yield* Effect.sleep("200 millis");
        quiet.socket.close();
        feed(notified("n-auto", true));
        feed(notified("n-agent", false));

        const agentHit = yield* Effect.promise(() =>
          waitFor(() => apnsHits[3], "the agent's notify push")
        );

        const agentPush = yield* Effect.promise(() =>
          openPush(keys.privateKey, decodeApnsBody(agentHit.body).p)
        );

        expect(Option.getOrThrow(decodePushMessage(agentPush))).toMatchObject({
          kind: "notify",
          title: "Done",
          body: "All green",
        });
        yield* Effect.sleep("500 millis");
        expect(apnsHits).toHaveLength(4);

        const restored = yield* openDevice;
        yield* restored.client["devices.registerPush"](registration);
        yield* Effect.sleep("200 millis");
        restored.socket.close();

        // APNs no longer knows the token: the Host drops it and sends nothing more.
        apnsStatus = 410;
        feed(approvalRequested("r2"));
        yield* Effect.promise(() => waitFor(() => apnsHits[4], "the push APNs refuses"));
        yield* Effect.promise(() =>
          waitFor(
            () => (relay.log().includes('"outcome":"unregistered"') ? true : undefined),
            "the relay to answer unregistered"
          )
        );
        // The woken answer is on its way to the Daemon.
        yield* Effect.sleep("300 millis");
        feed(approvalRequested("r3"));
        yield* Effect.sleep("1500 millis");
        expect(apnsHits).toHaveLength(5);

        // Registered again, then unlinked: unlinking drops the registration too.
        apnsStatus = 200;
        const back = yield* openDevice;
        yield* back.client["devices.registerPush"](registration);
        yield* Effect.sleep("200 millis");
        back.socket.close();
        feed(approvalRequested("r4"));
        yield* Effect.promise(() => waitFor(() => apnsHits[5], "the push after registering again"));
        yield* desktop["devices.unlink"]({ id: device.id });
        feed(approvalRequested("r5"));
        yield* Effect.sleep("1500 millis");
        expect(apnsHits).toHaveLength(6);
      })
    )
  );
}, 60_000);
