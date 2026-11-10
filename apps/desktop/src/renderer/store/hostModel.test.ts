import { describe, expect, test } from "bun:test";
import {
  DomainEvent,
  HostStreamItem,
  ReviewCheckout,
  ReviewCheckoutId,
  ReviewSubject,
  SessionSummary,
  SuggestedReply,
  Turn,
  TurnId,
  TurnTrigger,
  Worktree,
  WorktreeId,
  WorkspaceId,
} from "@polaris/protocol";
import { applyHostItems, emptyHostModel, sessionsOf, visibleWorkspaces } from "./hostModel.ts";
import {
  approval,
  envelope,
  seq,
  session,
  sessionId,
  turn,
  turnWith,
  workspace,
} from "./fixtures.testing.ts";
import { cachedModel, toCached } from "./store.ts";

const E = DomainEvent.cases;

const H = HostStreamItem.cases;

const event = (sequence: number, e: DomainEvent) =>
  H.Event.make({ envelope: envelope(sequence, e) });

const snapshot = H.Snapshot.make({
  sequence: seq(3),
  workspaces: [workspace],
  worktrees: [],
  sessions: [
    new SessionSummary({ session, pendingApprovals: [], lastTurnPreview: null, subagents: [] }),
  ],
});

/** What the renderer really receives: values after structured clone. */
const cloned = <A>(value: A): A => structuredClone(value);

const reviewCheckout = (state: ReviewCheckout["state"]) =>
  new ReviewCheckout({
    id: ReviewCheckoutId.make("rc1"),
    workspaceId: workspace.id,
    subject: ReviewSubject.cases.SessionTurns.make({
      sessionId,
      firstTurnId: null,
      lastTurnId: null,
    }),
    path: "/repo/.review/session-1",
    state,
    blocked: null,
    head: null,
    mergeBase: null,
    latestHead: "",
    latestBase: "",
    reviewedHead: null,
    reviewedMergeBase: null,
    openedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });

describe("host model", () => {
  test("Review Checkouts arrive in the Snapshot and follow their events", () => {
    const withCheckout = H.Snapshot.make({
      ...snapshot,
      reviewCheckouts: [reviewCheckout("fetching")],
    });

    const opened = applyHostItems(emptyHostModel, cloned([withCheckout]));

    expect(opened.reviewCheckouts.get("rc1")?.state).toBe("fetching");

    const ready = applyHostItems(
      opened,
      cloned([event(4, E.ReviewCheckoutChanged.make({ checkout: reviewCheckout("ready") }))])
    );

    expect(ready.reviewCheckouts.get("rc1")?.state).toBe("ready");

    const removed = applyHostItems(
      ready,
      cloned([
        event(
          5,
          E.ReviewCheckoutRemoved.make({
            checkoutId: ReviewCheckoutId.make("rc1"),
            workspaceId: workspace.id,
          })
        ),
      ])
    );

    expect(removed.reviewCheckouts.size).toBe(0);
  });

  test("a Snapshot resets the model; Synchronized marks it live", () => {
    const model = applyHostItems(
      emptyHostModel,
      cloned([snapshot, H.Synchronized.make({ sequence: seq(3) })])
    );

    expect(model.sequence).toBe(seq(3));
    expect(model.synchronized).toBe(true);
    expect(visibleWorkspaces(model).map((w) => w.name)).toEqual(["proof"]);
    expect(sessionsOf(model, workspace.id).map((e) => e.session.title)).toEqual(["Proof session"]);
  });

  test("events fold as the Daemon folds them", () => {
    const model = applyHostItems(
      emptyHostModel,
      cloned([
        snapshot,
        event(4, E.SessionStateChanged.make({ sessionId, state: "working", reason: null })),
        event(5, E.TurnStarted.make({ turn })),
        event(6, E.ApprovalRequested.make({ request: approval })),
        event(7, E.SessionRenamed.make({ sessionId, title: "Renamed" })),
      ])
    );

    const entry = model.sessions.get(sessionId);

    expect(model.sequence).toBe(seq(7));
    expect(entry?.session.state).toBe("working");
    expect(entry?.session.turnCount).toBe(1);
    expect(entry?.session.title).toBe("Renamed");
    expect(entry?.lastTurnPreview).toBe("count to three");
    expect(entry?.pendingApprovals.map((r) => r.id)).toEqual([approval.id]);

    const resolved = applyHostItems(
      model,
      cloned([
        event(
          8,
          E.ApprovalWithdrawn.make({
            sessionId,
            requestId: approval.id,
            withdrawnBy: "harness",
            reason: "turn ended",
          })
        ),
        event(9, E.SessionStateChanged.make({ sessionId, state: "failed", reason: "boom" })),
      ])
    );

    expect(resolved.sessions.get(sessionId)?.pendingApprovals).toEqual([]);
    expect(resolved.sessions.get(sessionId)?.session.lastError).toBe("boom");
  });

  test("a Turn the Harness started keeps the user's Turn: its id, start and prompt", () => {
    const continued = new Turn({
      sessionId: turn.sessionId,
      attachments: [],
      model: null,
      effort: null,
      status: "working",
      checkpointBefore: null,
      checkpointAfter: null,
      endedAt: null,
      id: TurnId.make("t-continued"),
      index: 1,
      prompt: "[Background task continuation]",
      trigger: TurnTrigger.cases.BackgroundTasksReported.make({
        tasks: [{ id: "bg1", kind: "command" }],
      }),
      startedAt: "2026-10-19T09:30:00.000Z",
    });

    const model = applyHostItems(
      emptyHostModel,
      cloned([
        snapshot,
        event(4, E.TurnStarted.make({ turn })),
        event(5, E.TurnStarted.make({ turn: continued })),
      ])
    );

    const entry = model.sessions.get(sessionId);

    expect(entry?.lastTurnId).toBe("t-continued");
    expect(entry?.userTurn).toEqual({
      id: turn.id,
      startedAt: turn.startedAt,
      prompt: "count to three",
    });
  });

  test("idle compaction's Turn leaves the session's last prompt, user Turn and reply as they were", () => {
    const answered = turnWith({
      status: "completed",
      replyPreview: "Parser split",
      userTurnNumber: 1,
    });

    const fields = {
      id: TurnId.make("t-compact"),
      index: 1,
      prompt: "/compact",
      idleCompaction: true,
      userTurnNumber: 1,
      startedAt: "2026-10-19T10:30:00.000Z",
    };

    const model = applyHostItems(
      emptyHostModel,
      cloned([
        snapshot,
        event(4, E.TurnStarted.make({ turn })),
        event(5, E.TurnEnded.make({ turn: answered })),
        event(6, E.TurnStarted.make({ turn: turnWith(fields) })),
        event(7, E.TurnEnded.make({ turn: turnWith({ ...fields, status: "completed" }) })),
      ])
    );

    const entry = model.sessions.get(sessionId);

    expect(entry?.lastTurnPreview).toBe("count to three");
    expect(entry?.userTurn?.id).toBe(turn.id);
    expect(entry?.session.lastReplyPreview).toBe("Parser split");
    expect(entry?.session.turnCount).toBe(2);
  });

  test("the Daemon's user Turn and reply preview reach the session (`session.user-turns`)", () => {
    const opened = { userTurnNumber: 1 };

    const continued = {
      id: TurnId.make("t-continued"),
      index: 1,
      trigger: TurnTrigger.cases.BackgroundTasksReported.make({ tasks: [] }),
      userTurnNumber: 1,
      startedAt: "2026-10-19T09:30:00.000Z",
    };

    const next = turnWith({
      id: TurnId.make("t-next"),
      index: 2,
      userTurnNumber: 2,
      startedAt: "2026-10-19T09:40:00.000Z",
    });

    const sessionAfter = (...events: ReadonlyArray<DomainEvent>) =>
      applyHostItems(
        emptyHostModel,
        cloned([snapshot, ...events.map((e, i) => event(4 + i, e))])
      ).sessions.get(sessionId)?.session;

    const throughContinuation = [
      E.TurnStarted.make({ turn: turnWith(opened) }),
      E.TurnEnded.make({ turn: turnWith({ ...opened, status: "completed", replyPreview: "A" }) }),
      E.TurnStarted.make({ turn: turnWith(continued) }),
      E.TurnEnded.make({
        turn: turnWith({ ...continued, status: "completed", replyPreview: "B" }),
      }),
    ];

    expect(sessionAfter(...throughContinuation)).toMatchObject({
      currentUserTurn: { turnId: turn.id, number: 1, startedAt: turn.startedAt },
      lastReplyPreview: "B",
    });
    expect(sessionAfter(...throughContinuation, E.TurnStarted.make({ turn: next }))).toMatchObject({
      currentUserTurn: { turnId: next.id, number: 2, startedAt: next.startedAt },
      lastReplyPreview: "B",
    });
  });

  test("a Suggested Reply folds into the session until a newer Turn starts (ENG-885)", () => {
    const reply = SuggestedReply.make({ turnId: turn.id, text: "go with B", source: "polaris" });
    const next = turnWith({ id: TurnId.make("t-next"), index: 1 });

    const sessionAfter = (...events: ReadonlyArray<DomainEvent>) =>
      applyHostItems(
        emptyHostModel,
        cloned([snapshot, ...events.map((e, i) => event(4 + i, e))])
      ).sessions.get(sessionId)?.session;

    const offered = [
      E.TurnStarted.make({ turn }),
      E.TurnEnded.make({ turn: turnWith({ status: "completed" }) }),
      E.SessionReplySuggested.make({ sessionId, reply }),
    ];

    expect(sessionAfter(...offered)?.suggestedReply).toEqual(reply);
    expect(sessionAfter(...offered, E.TurnStarted.make({ turn: next }))?.suggestedReply).toBeNull();
    expect(
      sessionAfter(
        E.TurnStarted.make({ turn }),
        E.TurnStarted.make({ turn: next }),
        E.SessionReplySuggested.make({ sessionId, reply })
      )?.suggestedReply ?? null
    ).toBeNull();
  });

  test("an event at or below the model's sequence is ignored", () => {
    const model = applyHostItems(emptyHostModel, cloned([snapshot]));

    const replayed = applyHostItems(
      model,
      cloned([event(3, E.SessionRenamed.make({ sessionId, title: "stale" }))])
    );

    expect(replayed).toBe(model);
  });

  test("removing a Workspace drops its Worktrees; archived sessions are hidden", () => {
    const worktreeOf = (id: string, workspaceId: WorkspaceId) =>
      new Worktree({
        id: WorktreeId.make(id),
        workspaceId,
        path: `/tmp/${id}`,
        branch: id,
        head: "abc1234",
        createdBySessionId: null,
        isMain: false,
      });

    const model = applyHostItems(
      emptyHostModel,
      cloned([
        H.Snapshot.make({
          ...snapshot,
          worktrees: [
            worktreeOf("ours", workspace.id),
            worktreeOf("theirs", WorkspaceId.make("w2")),
          ],
        }),
        event(4, E.SessionStateChanged.make({ sessionId, state: "archived", reason: null })),
      ])
    );

    expect(sessionsOf(model, workspace.id)).toEqual([]);

    const removed = applyHostItems(
      model,
      cloned([event(5, E.WorkspaceRemoved.make({ workspaceId: workspace.id }))])
    );

    expect(visibleWorkspaces(removed)).toEqual([]);
    expect([...removed.worktrees.keys()]).toEqual(["theirs"]);
    // Removal purges its sessions, archived ones included (docs/adr/0086).
    expect(removed.sessions.has(sessionId)).toBe(false);
  });

  test("the cache holds only synchronized live models and paints them marked as cached", () => {
    const live = applyHostItems(emptyHostModel, cloned([snapshot]));

    expect(toCached("local", live)).toBeNull();

    const synced = applyHostItems(live, [H.Synchronized.make({ sequence: seq(3) })]);
    const cached = toCached("local", synced);

    expect(cached?.sequence).toBe(seq(3));

    const painted = cachedModel(cloned(cached!));

    expect(painted.fromCache).toBe(true);
    expect(painted.synchronized).toBe(false);
    expect(painted.sessions.get(sessionId)?.session.title).toBe("Proof session");
    expect(toCached("local", painted)).toBeNull();
  });
});
