/**
 * Computer use approvals against the real Daemon (ENG-846): the bench Harness asks an `app` or
 * `headed-input` approval; only an Extension that announced `computer-use` sees it, it may allow
 * or deny but never always-allow, and nobody may always-allow headed input.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApprovalDecision } from "@polaris/protocol";
import { launchDaemon, type TestDaemon } from "./daemon.testing.ts";
import {
  alwaysAllowable,
  CommandRejected,
  createPolaris,
  type HostView,
  type PolarisClient,
  type SessionView,
} from "./index.ts";

let daemon: TestDaemon;

let workspaceId: string;

let opted: PolarisClient;

let plain: PolarisClient;

const opened: Array<PolarisClient> = [];

const client = async (pairing: string, computerUse: boolean) => {
  const polaris = await createPolaris({
    pairings: [pairing],
    clientName: "sdk-tests",
    computerUse,
  });

  opened.push(polaris);

  return polaris;
};

beforeAll(async () => {
  daemon = await launchDaemon();
  process.env.POLARIS_HOME = daemon.home;
  workspaceId = await daemon.registerWorkspace();
  const grant = ["read", "approve", "turn", "start"] as const;

  opted = await client(await daemon.pair("Glasses", grant), true);
  plain = await client(await daemon.pair("Older", grant), false);
}, 60_000);

afterAll(async () => {
  await Promise.all(opened.map((polaris) => polaris.close()));
  await daemon.stop();
});

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

const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: Error) => error
  );

/** Starts a session whose Turn asks a computer use approval and resolves with it. */
const asking = async (kind: "app" | "headed-input") => {
  const prompt = `bench:${JSON.stringify({
    items: 1,
    approvalEvery: 1,
    deltaIntervalMs: 0,
    approvalApp: { kind, name: "Simulator" },
    tag: crypto.randomUUID(),
  })}`;

  const sessionId = await opted.startSession(daemon.hostId, {
    workspaceId,
    harness: "claude",
    prompt,
  });

  const view = await until(opted.subscribeHost(daemon.hostId), (v: HostView) =>
    v.approvals.some((a) => a.sessionId === sessionId)
  );

  const approval = view.approvals.find((a) => a.sessionId === sessionId);

  if (approval === undefined) throw new Error("no approval");

  return { sessionId, approval };
};

const resolved = (sessionId: string) =>
  until(
    opted.subscribeSession(daemon.hostId, sessionId),
    (v: SessionView) => v.pendingApprovals.length === 0
  );

describe("an app approval", () => {
  test("reaches only the Extension that announced computer-use", async () => {
    const { sessionId, approval } = await asking("app");

    expect(approval.kind).toBe("app");
    expect(alwaysAllowable(approval)).toBe(false);

    const older = await until(plain.subscribeHost(daemon.hostId), (v: HostView) =>
      v.sessions.some((s) => s.session.id === sessionId && s.session.state === "needs-you")
    );

    expect(older.approvals.filter((a) => a.sessionId === sessionId)).toEqual([]);
  }, 60_000);

  test("an Extension's always-allow is refused and the approval stays; allow resolves it", async () => {
    const { sessionId, approval } = await asking("app");

    const refusal = await rejected(
      opted.respondToApproval(daemon.hostId, sessionId, approval.id, {
        kind: "allow",
        remember: true,
      })
    );

    expect(refusal).toBeInstanceOf(CommandRejected);
    const still = await until(opted.subscribeSession(daemon.hostId, sessionId), () => true);

    expect(still.pendingApprovals.map((a) => a.id)).toEqual([approval.id]);

    await opted.respondToApproval(daemon.hostId, sessionId, approval.id, { kind: "allow" });
    await resolved(sessionId);
    expect(await daemon.resolution(sessionId, approval.id)).toEqual(
      ApprovalDecision.cases.Allow.make({ remember: false })
    );
  }, 60_000);

  test("the Desktop App's always-allow is taken", async () => {
    const { sessionId, approval } = await asking("app");
    const always = ApprovalDecision.cases.Allow.make({ remember: true });

    await daemon.respondAsClient(sessionId, approval.id, always);
    expect(await daemon.resolution(sessionId, approval.id)).toEqual(always);
  }, 60_000);
});

describe("a headed-input approval", () => {
  test("is never always-allowed, even by the Desktop App; deny resolves it", async () => {
    const { sessionId, approval } = await asking("headed-input");

    expect(approval.kind).toBe("headed-input");

    const refusal = await rejected(
      daemon.respondAsClient(
        sessionId,
        approval.id,
        ApprovalDecision.cases.Allow.make({ remember: true })
      )
    );

    expect(refusal).not.toBeNull();

    await opted.respondToApproval(daemon.hostId, sessionId, approval.id, { kind: "deny" });
    await resolved(sessionId);
    expect(await daemon.resolution(sessionId, approval.id)).toEqual(
      ApprovalDecision.cases.Deny.make({ reason: null })
    );
  }, 60_000);
});
