import { expect, test } from "bun:test";
import { DomainEvent, HostStreamItem, SessionSummary } from "@polaris/protocol";
import {
  applyHostItems,
  emptyHostModel,
  type BackgroundFailure,
} from "../../../store/hostModel.ts";
import { envelope, seq, session, sessionId, workspace } from "../../../store/fixtures.testing.ts";
import { backgroundFailureMessage, unseenFailures } from "./backgroundFailures.ts";

const H = HostStreamItem.cases;

const snapshot = H.Snapshot.make({
  sequence: seq(3),
  workspaces: [workspace],
  worktrees: [],
  sessions: [
    new SessionSummary({ session, pendingApprovals: [], lastTurnPreview: null, subagents: [] }),
  ],
});

const failed = (sequence: number, itemId: string | null, reason: string) =>
  H.Event.make({
    envelope: envelope(
      sequence,
      DomainEvent.cases.SessionBackgroundCommandFailed.make({ sessionId, itemId, reason })
    ),
  });

const renamed = (sequence: number) =>
  H.Event.make({
    envelope: envelope(sequence, DomainEvent.cases.SessionRenamed.make({ sessionId, title: "x" })),
  });

// ENG-389: each failure the Host stream brings toasts once, even as the session changes after it.
test("each Run in background failure is toasted once, with the Harness's reason", () => {
  const seen = new WeakSet<BackgroundFailure>();

  const toasts = (model: Parameters<typeof applyHostItems>[0]) =>
    unseenFailures({ host: model }, seen).map(backgroundFailureMessage);

  const first = applyHostItems(emptyHostModel, [
    snapshot,
    failed(4, "c1", "the command already finished"),
  ]);

  const later = applyHostItems(first, [renamed(5)]);
  const again = applyHostItems(later, [failed(6, null, "background tasks are disabled")]);

  expect([
    toasts(applyHostItems(emptyHostModel, [snapshot])),
    toasts(first),
    toasts(later),
    toasts(again),
  ]).toEqual([[], ["The command already finished"], [], ["Background tasks are disabled"]]);
});
