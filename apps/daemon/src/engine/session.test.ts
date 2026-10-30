import { describe, expect, test } from "bun:test";
import {
  ApprovalDecision,
  ApprovalRequest,
  DomainEvent,
  RequestId,
  type SessionState,
  Turn,
  TurnId,
} from "@polaris/protocol";
import { adjacencyMapToArray, getAdjacencyMap } from "xstate/graph";
import { foldSession, type SessionRecord, workingTurn } from "../store/model.ts";
import {
  ALL_STEPS,
  AT,
  initialSnapshot,
  type ModelOptions,
  type ModelSnapshot,
  modelLogic,
  pathsFor,
  SESSION,
  type Step,
  serialize,
  stepModel,
} from "./session.testing.ts";
import { decideSession, type SessionInput, snapshotOf, stateOf } from "./session.ts";

const claude: ModelOptions = { harness: "claude", liveCoAttach: false, switchModel: false };

const codex: ModelOptions = { harness: "codex", liveCoAttach: true, switchModel: true };

const run = (steps: ReadonlyArray<Step["type"]>, options = claude): ModelSnapshot => {
  let snapshot = initialSnapshot();

  for (const type of steps) {
    const { next, rejection } = stepModel(snapshot, { type }, options);

    if (rejection !== null) throw new Error(`${type}: ${rejection}`);
    snapshot = next;
  }

  return snapshot;
};

const record = (snapshot: ModelSnapshot) => snapshot.machine.context.record!;

/** A record as a log folds to it, for states the machine no longer produces (older logs). */
const folded = (from: SessionRecord, events: ReadonlyArray<DomainEvent>) =>
  foldSession(SESSION, from, events, AT)!;

const requestFor = (turnId: TurnId, id = "r-legacy") =>
  new ApprovalRequest({
    id: RequestId.make(id),
    sessionId: SESSION,
    turnId,
    kind: "command",
    title: "legacy",
    detail: null,
    options: [],
    openedAt: AT,
  });

/** A new Turn in flight, otherwise like `from`. */
const workingCopy = (from: Turn, id: string, index: number) =>
  new Turn({
    id: TurnId.make(id),
    sessionId: from.sessionId,
    index,
    prompt: from.prompt,
    attachments: from.attachments,
    model: null,
    effort: null,
    status: "working",
    checkpointBefore: from.checkpointBefore,
    checkpointAfter: from.checkpointAfter,
    startedAt: from.startedAt,
    endedAt: null,
  });

const records = (snapshots: ReadonlyArray<ModelSnapshot>): ReadonlyArray<SessionRecord> =>
  snapshots.flatMap((s) => (s.machine.context.record === null ? [] : [s.machine.context.record]));

/** Every snapshot the model reaches, with every Step tried from it. */
const everyEdge = (options: ModelOptions) => {
  const adjacency = getAdjacencyMap<ModelSnapshot, Step, unknown>(modelLogic(options), {
    events: ALL_STEPS,
    serializeState: serialize,
  });

  // Every Step is tried from every snapshot, so each one is the source of some edge.
  const vertices = new Map(
    adjacencyMapToArray(adjacency).map(({ state }) => [serialize(state), state])
  );

  return [...vertices.values()];
};

describe("session machine", () => {
  test("reaches all nine Session States", () => {
    for (const options of [claude, codex]) {
      const states = new Set(everyEdge(options).map((s) => stateOf(s.machine)));
      expect([...states].sort()).toEqual(
        (
          [
            "new",
            "starting",
            "working",
            "needs-you",
            "idle",
            "in-terminal",
            "dormant",
            "failed",
            "limited",
            "archived",
          ] satisfies Array<SessionState | "new">
        )
          .filter((s) => s !== "starting") // transient: the Engine opens the Harness at once
          .sort()
      );
    }
  });

  test("every snapshot is the one its folded record gives (a restart derives the same)", () => {
    for (const options of [claude, codex]) {
      for (const snapshot of everyEdge(options)) {
        for (const step of ALL_STEPS) {
          const { next } = stepModel(snapshot, step, options);
          const rebuilt = snapshotOf(next.machine.context.record ?? undefined);
          expect(rebuilt.value).toEqual(next.machine.value);
          expect(stateOf(next.machine)).toBe(next.machine.context.record?.session.state ?? "new");
        }
      }
    }
  });

  test("graph path counts", () => {
    const counts = [claude, codex].map((options) => {
      const paths = pathsFor(options);

      return [paths.states.length, paths.transitions.length];
    });

    // Update README.md when these move.
    expect(counts).toEqual([
      [47, 277],
      [55, 367],
    ]);
  });

  describe("guards", () => {
    const refusal = (snapshot: ModelSnapshot, type: Step["type"], options = claude) =>
      stepModel(snapshot, { type }, options).rejection;

    test("no new Turn while one is in flight", () => {
      const working = run(["start"]);
      expect(stateOf(working.machine)).toBe("working");
      expect(refusal(working, "send")).toBe("the session is working; wait for the Turn to end");
      const waiting = run(["start", "requestApproval"]);
      expect(stateOf(waiting.machine)).toBe("needs-you");
      expect(refusal(waiting, "send")).toBe("the session is needs-you; wait for the Turn to end");
    });

    test("steering needs a Turn in flight, outside the terminal, on a Harness that steers", () => {
      const steer = (snapshot: ModelSnapshot, canSteer = true) =>
        decideSession(record(snapshot), { type: "turn.steer", canSteer, takesAttachments: true })
          .rejection;

      expect(steer(run(["start"]))).toBeNull();
      expect(steer(run(["start", "complete"]))).toBe("there is no Turn in flight to steer");
      expect(steer(run(["start", "complete", "openTerminal", "terminalTurn"]))).toBe(
        "there is no Turn in flight to steer"
      );
      expect(steer(run(["start"]), false)).toBe("claude does not support steering");
    });

    test("Continue only for an Interrupted Turn", () => {
      expect(refusal(run(["start", "complete"]), "continue")).toBe(
        "there is no Interrupted Turn to continue"
      );
      expect(refusal(run(["start", "interrupt"]), "continue")).toBeNull();
    });

    test("accepting waits for the Turn to end; an accepted Interrupted Turn can't be continued", () => {
      const interrupted = record(run(["start", "interrupt"]));
      const last = interrupted.turns.at(-1)!;

      const accept: SessionInput = {
        type: "turns.accept",
        turnId: last.id,
        index: last.index,
        status: last.status,
        revertLaterTurns: false,
        acceptedBy: "Mac",
      };

      const accepted = decideSession(interrupted, accept);
      expect(accepted.rejection).toBeNull();
      expect(
        decideSession(folded(interrupted, accepted.events), { type: "turn.continue" })
      ).toMatchObject({
        rejection: "the Interrupted Turn is accepted; send a new Turn instead",
      });

      const working = record(run(["start"]));
      const inFlight = working.turns.at(-1)!;
      expect(
        decideSession(working, { ...accept, turnId: inFlight.id, status: inFlight.status })
          .rejection
      ).toBe("the session is working; wait for the Turn to end");
    });

    test("Retry only for a Failed Turn, as a new Turn", () => {
      expect(refusal(run(["start", "complete"]), "retry")).toBe("there is no Failed Turn to retry");
      expect(refusal(run(["start", "interrupt"]), "retry")).toBe(
        "there is no Failed Turn to retry"
      );
      const failed = run(["start", "failTurn"]);
      expect(stateOf(failed.machine)).toBe("failed");
      const retried = run(["start", "failTurn", "retry"]);
      expect(stateOf(retried.machine)).toBe("working");
      expect(retried.machine.context.record?.turns.map((t) => t.status)).toEqual([
        "failed",
        "working",
      ]);
      expect(refusal(retried, "retry")).toBe("there is no Failed Turn to retry");
    });

    test("In Terminal and Archived take no Turns", () => {
      expect(refusal(run(["start", "complete", "openTerminal"]), "send")).toBe(
        "the session is In Terminal; return it first"
      );
      expect(refusal(run(["start", "complete", "archive"]), "send")).toBe(
        "the session is Archived"
      );
    });

    test("a live Turn must be interrupted before archiving", () => {
      expect(refusal(run(["start"]), "archive")).toBe(
        "interrupt the Turn in flight before archiving"
      );
      expect(refusal(run(["start", "complete", "archive"]), "archive")).toBe(
        "the session is already Archived"
      );
    });

    // Finding 2 (ENG-209): Archive used to be refused only in the live states.
    test("a Turn in flight must be interrupted before archiving, in every state", () => {
      for (const options of [claude, codex]) {
        const inTerminal = run(["start", "complete", "openTerminal", "terminalTurn"], options);
        expect(stateOf(inTerminal.machine)).toBe("in-terminal");
        expect(refusal(inTerminal, "archive", options)).toBe(
          "interrupt the Turn in flight before archiving"
        );

        const asking = run(
          ["start", "complete", "openTerminal", "terminalTurn", "requestApproval"],
          options
        );

        expect(record(asking).pending.size).toBe(1);
        expect(refusal(asking, "archive", options)).toBe(
          "interrupt the Turn in flight before archiving"
        );
      }

      // Starting: a Turn sent to a Dormant session, its Harness still opening.
      const dormant = record(run(["start", "complete", "exit"]));

      const sent = decideSession(dormant, {
        type: "turn.send",
        turn: workingCopy(dormant.turns.at(-1)!, "t-starting", dormant.session.turnCount),
      }).next.context.record!;

      expect(sent.session.state).toBe("starting");
      expect(decideSession(sent, { type: "session.archive", at: AT }).rejection).toBe(
        "interrupt the Turn in flight before archiving"
      );
    });

    test("no reachable Archived session holds a Turn or a pending approval", () => {
      for (const options of [claude, codex]) {
        for (const r of records(everyEdge(options))) {
          if (r.session.state !== "archived") continue;
          expect(workingTurn(r)).toBeUndefined();
          expect(r.pending.size).toBe(0);
        }
      }
    });

    // Finding 3 (ENG-209): a request for a Turn that had ended used to be recorded.
    test("an approval request for a Turn that is not in flight is ignored", () => {
      for (const options of [claude, codex]) {
        for (const steps of [
          ["start", "complete", "lateApproval"],
          ["start", "complete", "send", "lateApproval"],
          ["start", "interrupt", "lateApproval"],
          ["start", "complete", "openTerminal", "lateApproval"],
        ] as const) {
          const before = run(steps.slice(0, -1), options);
          expect(record(run(steps, options))).toEqual(record(before));
        }
      }
    });

    test("in every reachable snapshot, pending approvals and Working need a Turn in flight", () => {
      for (const options of [claude, codex]) {
        for (const r of records(everyEdge(options))) {
          if (r.pending.size > 0 || r.session.state === "working") {
            expect(workingTurn(r)).toBeDefined();
          }
        }
      }
    });

    test("answering an approval moves to Working only with a Turn in flight", () => {
      // An older log: a request recorded after its Turn ended, the session Needs You.
      const idle = record(run(["start", "complete"]));
      const ended = idle.turns.at(-1)!;

      const stuck = folded(idle, [
        DomainEvent.cases.ApprovalRequested.make({ request: requestFor(ended.id) }),
        DomainEvent.cases.SessionStateChanged.make({
          sessionId: SESSION,
          state: "needs-you",
          reason: null,
        }),
      ]);

      const answered = decideSession(stuck, {
        type: "approval.respond",
        requestId: RequestId.make("r-legacy"),
        decision: ApprovalDecision.cases.Allow.make({ remember: false }),
        resolvedBy: "mac",
      });

      expect(answered.events.map((e) => e._tag)).toEqual(["ApprovalResolved"]);
      const after = answered.next.context.record!;
      expect(after.session.state).toBe("needs-you");

      // …and it takes a new Turn.
      const next = workingCopy(ended, "t-next", after.session.turnCount);

      expect(decideSession(after, { type: "turn.send", turn: next }).rejection).toBeNull();

      // The Harness withdrawing it instead: no Working without a Turn either.
      const withdrawn = decideSession(stuck, {
        type: "harness.approvalWithdrawn",
        requestId: RequestId.make("r-legacy"),
      });

      expect(withdrawn.events.map((e) => e._tag)).toEqual(["ApprovalWithdrawn"]);
      expect(withdrawn.next.context.record!.session.state).toBe("needs-you");
    });

    test("the terminal opens from Idle, Dormant or Failed only", () => {
      expect(refusal(run(["start"]), "openTerminal")).toBe("the session is working");

      for (const steps of [
        ["start", "complete"],
        ["start", "complete", "exit"],
        ["start", "failTurn"],
      ] as const) {
        expect(refusal(run(steps), "openTerminal")).toBeNull();
      }
    });
  });

  describe("restart recovery", () => {
    test("a Turn in flight is Interrupted and the session Needs You; nothing continues it", () => {
      const before = run(["start", "requestApproval"]);

      const decision = decideSession(record(before), {
        type: "daemon.recover",
        cause: "restart",
        at: AT,
      });

      expect(decision.events.map((e) => e._tag)).toEqual([
        "TurnEnded",
        "ApprovalWithdrawn",
        "SessionStateChanged",
      ]);
      const after = decision.next.context.record!;
      expect(after.session.state).toBe("needs-you");
      expect(workingTurn(after)).toBeUndefined();
      expect(after.turns.at(-1)?.status).toBe("interrupted");
      // And again after another restart: still waiting on Continue.
      expect(
        decideSession(after, { type: "daemon.recover", cause: "restart", at: AT }).events
      ).toEqual([]);
    });

    test("Dormant and Archived sessions have nothing to recover", () => {
      for (const steps of [
        ["start", "complete", "exit"],
        ["start", "complete", "archive"],
      ] as const) {
        const decision = decideSession(record(run(steps)), {
          type: "daemon.recover",
          cause: "restart",
          at: AT,
        });

        expect(decision.events).toEqual([]);
      }
    });

    test("an Archived session an older log left open is closed, and stays Archived", () => {
      // Before finding 2's fix: archived In Terminal with a Turn in flight asking for approval.
      const asking = record(
        run(["start", "complete", "openTerminal", "terminalTurn", "requestApproval"], codex)
      );

      const archived = folded(asking, [
        DomainEvent.cases.SessionStateChanged.make({
          sessionId: SESSION,
          state: "archived",
          reason: null,
        }),
      ]);

      const decision = decideSession(archived, {
        type: "daemon.recover",
        cause: "restart",
        at: AT,
      });

      expect(decision.events.map((e) => e._tag)).toEqual(["TurnEnded", "ApprovalWithdrawn"]);
      const after = decision.next.context.record!;
      expect(after.session.state).toBe("archived");
      expect(workingTurn(after)).toBeUndefined();
      expect(after.pending.size).toBe(0);
    });

    test("an upgrade leaves a terminal UI alone", () => {
      const inTerminal = record(run(["start", "complete", "openTerminal"], codex));
      expect(
        decideSession(inTerminal, { type: "daemon.recover", cause: "upgrade", at: AT }).events
      ).toEqual([]);
    });
  });

  describe("effects", () => {
    test("entering Idle schedules the idle stop; the idle timeout stops the Harness", () => {
      const working = record(run(["start"]));

      const ended = decideSession(working, {
        type: "harness.turnEnded",
        turnId: workingTurn(working)!.id,
        status: "completed",
        error: null,
        checkpoint: null,
        at: AT,
      });

      expect(ended.effects).toEqual(["scheduleIdleStop"]);
      const idle = ended.next.context.record!;
      const timedOut = decideSession(idle, { type: "idle.timeout", harnessLive: true });
      expect(timedOut.effects).toEqual(["stopHarness"]);
      expect(timedOut.next.context.record!.session.state satisfies SessionState).toBe("dormant");
      // A Harness that is already gone: nothing to do.
      expect(decideSession(idle, { type: "idle.timeout", harnessLive: false }).events).toEqual([]);
    });
  });
});
