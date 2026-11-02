/**
 * Home against a real Daemon over the dev bridge: a bench agent session's command approval and
 * question land under needs you, and answering them from Home resolves them on the Host.
 */
import { launchDaemon, type TestDaemon } from "@polaris/sdk/testing";
import { Command, SessionId, SessionPlacement, WorkspaceId } from "@polaris/protocol";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { followHost, type FollowedHost } from "../src/home/feed/follow.ts";
import { buildHome, type SessionRow } from "../src/home/model/home.ts";
import { newCommandId, type Reply, respond } from "../src/home/model/respond.ts";
import { devBridgeTransport } from "../src/runtime/devBridge.ts";
import { type HostConnection, openHostConnection } from "../src/runtime/hostConnection.ts";
import { type DevBridgeServer, startDevBridge } from "./devBridge.ts";

let daemon: TestDaemon;

let bridge: DevBridgeServer;

let connection: HostConnection;

let workspaceId: WorkspaceId;

let latest: FollowedHost | null = null;

let stopFollowing = () => {};

const until = async <A>(read: () => A | undefined, what: string): Promise<A> => {
  for (let tries = 0; tries < 600; tries++) {
    const value = read();

    if (value !== undefined) return value;
    await Bun.sleep(50);
  }

  throw new Error(`timed out waiting for ${what}`);
};

beforeAll(async () => {
  daemon = await launchDaemon();
  bridge = startDevBridge(daemon.socketPath);
  workspaceId = WorkspaceId.make(await daemon.registerWorkspace());
  connection = openHostConnection({
    hostId: daemon.hostId,
    name: "Dev Daemon",
    transport: devBridgeTransport({
      hostId: daemon.hostId,
      port: bridge.port,
      token: bridge.token,
    }),
  });
  stopFollowing = followHost(connection, (followed) => {
    latest = followed;
  });
  await until(() => latest?.seen || undefined, "the host feed");
}, 60_000);

afterAll(async () => {
  stopFollowing();
  await connection.close();
  bridge.stop();
  await daemon.stop();
});

const needsYou = (): ReadonlyArray<SessionRow> =>
  latest === null
    ? []
    : buildHome(
        [{ hostId: daemon.hostId, name: "Dev Daemon", connection: "connected", followed: latest }],
        null
      ).sections.needsYou;

/** A supervised bench agent session whose first item asks for approval. */
interface BenchScript {
  readonly approvalCommand?: string;
  readonly approvalQuestion?: {
    readonly question: string;
    readonly choices: ReadonlyArray<string>;
  };
}

const start = async (script: BenchScript) => {
  const sessionId = SessionId.make(`home-${crypto.randomUUID()}`);

  await connection.run((client) =>
    client.dispatch({
      commandId: newCommandId(),
      command: Command.cases.StartSession.make({
        sessionId,
        workspaceId,
        harness: "claude",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: `bench:${JSON.stringify({ items: 2, approvalEvery: 1, ...script })}`,
        attachments: [],
      }),
    })
  );

  return sessionId;
};

const asked = (sessionId: SessionId) =>
  until(
    () => needsYou().find((row) => row.session.id === sessionId && row.approval !== null),
    "the approval under needs you"
  );

const cleared = (sessionId: SessionId) =>
  until(
    () => (needsYou().some((row) => row.session.id === sessionId) ? undefined : true),
    "needs you to clear"
  );

const answer = (row: SessionRow, reply: Reply) => {
  const approval = row.approval;

  if (approval === null) throw new Error("the row has no approval");

  return connection.run((client) => respond(client, approval, reply));
};

test.each([
  ["Approve", { kind: "approve" }],
  ["Always here", { kind: "always" }],
  ["Deny", { kind: "deny" }],
] as const)(
  "%s on a command resolves it on the Host",
  async (_, reply) => {
    const sessionId = await start({ approvalCommand: "cargo build --release" });
    const row = await asked(sessionId);

    expect(row.approval?.detail).toBe("cargo build --release");
    await answer(row, reply);
    await cleared(sessionId);
  },
  60_000
);

test("a question is answered with one of its choices", async () => {
  const sessionId = await start({
    approvalQuestion: { question: "Monthly or annually?", choices: ["Annual", "Monthly"] },
  });

  const row = await asked(sessionId);

  expect(row.approval?.kind).toBe("question");
  expect(row.approval?.options).toEqual(["Annual", "Monthly"]);
  await answer(row, { kind: "answer", text: "Annual" });
  await cleared(sessionId);
}, 60_000);
