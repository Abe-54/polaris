/** Host stream items for push tests: one Claude Code session, its Turns, approvals and notifications. */
import {
  AgentSession,
  ApprovalRequest,
  BackgroundTask,
  ConstellationId,
  DomainEvent,
  EventEnvelope,
  HostStreamItem,
  RequestId,
  Sequence,
  SessionId,
  SessionNotification,
  SessionSummary,
  Turn,
  TurnId,
  WorkspaceId,
} from "@polaris/protocol";
import { fromBase64Url, HostSlice, LIVE_HPKE_INFO, PUSH_ENC_BYTES } from "@polaris/protocol/relay";
import { Effect, Option, Schema } from "effect";
import { patchSession } from "../store/model.ts";

const at = "2026-10-27T12:00:00.000Z";

/** Polls until `probe` finds something; a stuck wait dies naming `what`. */
export const waitUntil = <A>(probe: () => A | undefined, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      const found = probe();

      if (found !== undefined) return found;
      yield* Effect.sleep("25 millis");
    }

    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });

export const SESSION_ID = SessionId.make("s1");

export const session = new AgentSession({
  id: SESSION_ID,
  workspaceId: WorkspaceId.make("w1"),
  harness: "claude",
  title: "Fix the flaky test",
  cwd: "/repo",
  worktreeId: null,
  state: "working",
  permissionMode: "supervised",
  model: null,
  effort: null,
  parentSessionId: null,
  forkedFromTurnId: null,
  harnessCursor: null,
  turnCount: 1,
  contextUsage: null,
  lastError: null,
  createdAt: at,
  updatedAt: at,
});

/** The session as a Constellation worker's, as the Host stream's Snapshot marks it. */
export const workerSession = patchSession(session, {
  worker: { constellationId: ConstellationId.make("c1") },
});

export const snapshot = (listed: AgentSession = session): HostStreamItem =>
  HostStreamItem.cases.Snapshot.make({
    sequence: Sequence.make(1),
    workspaces: [],
    worktrees: [],
    sessions: [
      new SessionSummary({
        session: listed,
        pendingApprovals: [],
        lastTurnPreview: null,
        subagents: [],
      }),
    ],
  });

export const synchronized = (): HostStreamItem =>
  HostStreamItem.cases.Synchronized.make({ sequence: Sequence.make(1) });

let sequence = 1;

export const event = (domain: DomainEvent): HostStreamItem =>
  HostStreamItem.cases.Event.make({
    envelope: new EventEnvelope({
      sequence: Sequence.make(++sequence),
      occurredAt: at,
      commandId: null,
      event: domain,
    }),
  });

export const turn = (id: string, replyPreview: string | null = null) =>
  new Turn({
    id: TurnId.make(id),
    sessionId: SESSION_ID,
    index: 0,
    prompt: "go",
    replyPreview,
    attachments: [],
    model: null,
    effort: null,
    status: replyPreview === null ? "working" : "completed",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: at,
    endedAt: null,
  });

export const approval = (id: string, kind: ApprovalRequest["kind"] = "command") =>
  new ApprovalRequest({
    id: RequestId.make(id),
    sessionId: SESSION_ID,
    turnId: TurnId.make("t1"),
    kind,
    title: "Run bun test",
    detail: "bun test apps/daemon",
    options: [],
    questions: [],
    openedAt: at,
  });

export const turnStarted = (id: string) =>
  event(DomainEvent.cases.TurnStarted.make({ turn: turn(id), actor: null }));

export const turnEnded = (id: string, reply: string) =>
  event(DomainEvent.cases.TurnEnded.make({ turn: turn(id, reply) }));

export const approvalRequested = (id: string, kind?: ApprovalRequest["kind"]) =>
  event(DomainEvent.cases.ApprovalRequested.make({ request: approval(id, kind) }));

export const backgroundTasks = (count: number) =>
  event(
    DomainEvent.cases.SessionBackgroundTasksChanged.make({
      sessionId: SESSION_ID,
      tasks: Array.from(
        { length: count },
        (_, i) => new BackgroundTask({ id: `task${i}`, kind: "command", description: "watch" })
      ),
    })
  );

export const notified = (id: string, automatic: boolean) =>
  event(
    DomainEvent.cases.SessionNotified.make({
      sessionId: SESSION_ID,
      notification: new SessionNotification({
        id,
        title: automatic ? "A asks you" : "Done",
        body: automatic ? "Which base should I use?" : "All green",
        at,
        automatic,
        constellationId: automatic ? "c1" : null,
      }),
    })
  );

export const sessionCreated = (created: AgentSession) =>
  event(DomainEvent.cases.SessionCreated.make({ session: created, actor: null }));

/** Opens a slice `sealSlice` sealed to the key pair whose private half is `recipientKey`. */
export const openSlice = async (recipientKey: CryptoKey, sealed: string): Promise<HostSlice> => {
  const { pushSuite } = await import("./seal.ts");
  const bytes = Option.getOrThrow(fromBase64Url(sealed));

  const recipient = await pushSuite.createRecipientContext({
    recipientKey,
    enc: new Uint8Array(bytes.subarray(0, PUSH_ENC_BYTES)),
    info: new TextEncoder().encode(LIVE_HPKE_INFO),
  });

  const plain = new TextDecoder().decode(
    await recipient.open(new Uint8Array(bytes.subarray(PUSH_ENC_BYTES)))
  );

  return Schema.decodeUnknownSync(Schema.fromJsonString(HostSlice))(plain);
};
