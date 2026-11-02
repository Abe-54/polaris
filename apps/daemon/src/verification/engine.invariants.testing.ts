/**
 * What the Engine model-based test checks after every step (`engine.model.slow.test.ts`):
 * the committed log, every answer, approvals, the read model and every Client feed.
 */
import { expect } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { Predicate } from "effect";
import type { ReadModel } from "../store/model.ts";
import {
  type AEvent,
  type View,
  fold,
  referenceDecide,
  SESSIONS,
  sessionOfCommand,
  streamSeqs,
  workingTurnOf,
} from "./engine.reference.testing.ts";
import {
  type FeedState,
  reached,
  type Sent,
  viewOfFeed,
  type World,
} from "./engine.world.testing.ts";
import { isPrefix } from "./pbt.ts";

type Block = ReadonlyArray<AEvent>;

type Blocks = ReadonlyMap<string, Block>;

/** A feed's state copied before the log is read, so whatever it saw is already in the log. */
interface FeedCopy {
  readonly fs: FeedState;
  readonly seen: FeedState["seen"];
  readonly snapshots: FeedState["snapshots"];
  readonly errors: ReadonlyArray<string>;
}

/** Each command id's events: one contiguous block, one decision. */
const commandBlocks = (log: ReadonlyArray<AEvent>): Blocks => {
  const blocks = new Map<string, Array<AEvent>>();

  for (const e of log) {
    if (e.commandId === null) continue;
    blocks.set(e.commandId, [...(blocks.get(e.commandId) ?? []), e]);
  }

  for (const [id, events] of blocks) {
    const first = events[0]!.seq;

    if (!events.every((e, i) => e.seq === first + i)) {
      throw new Error(`${id}'s events are not contiguous: ${events.map((e) => e.seq).join(",")}`);
    }
  }

  return blocks;
};

/** Every answer the same for each retry, and an ack backed by the command's events. */
const checkAnswers = (id: string, sends: ReadonlyArray<Sent>, block: Block | undefined) => {
  const answers = sends.flatMap((s) => (s.answer === null ? [] : [s.answer]));

  for (const answer of answers) {
    if (answer.startsWith("failed:")) throw new Error(`${id} failed: ${answer}`);
  }

  if (new Set(answers).size > 1) {
    throw new Error(`${id} was answered differently: ${answers.join(",")}`);
  }

  const answer = answers[0];

  if (answer?.startsWith("seq:") && answer !== "seq:null") {
    const seq = Number(answer.slice(4));

    if (block === undefined || block.at(-1)!.seq !== seq) {
      throw new Error(`${id} was acked with ${seq} but its events are ${JSON.stringify(block)}`);
    }
  }

  if (answer?.startsWith("rejected:") && block !== undefined) {
    throw new Error(`${id} was rejected but has events`);
  }
};

/** The block a command recorded is what the reference decider expects from the log before it. */
const checkBlock = (world: World, log: ReadonlyArray<AEvent>, first: Sent, block: Block) => {
  const id = first.id;
  const view = fold(log, block[0]!.seq - 1).get(sessionOfCommand(first.command))!;
  const expected = referenceDecide(view, first.command, first.device);
  const recorded = block.map((e) => e.what).join(" ");

  if (expected === "reject" || expected.join(" ") !== recorded) {
    throw new Error(
      `${id} ${first.command._tag} recorded [${recorded}]; ` +
        `the reference expected ${expected === "reject" ? "a rejection" : `[${expected.join(" ")}]`}`
    );
  }

  if (Predicate.isTagged(first.command, "Continue")) reached.continued++;

  if (Predicate.isTagged(first.command, "Retry")) reached.retried++;
  world.checkedBlocks.add(id);
};

/** A rejection must have been right at some point while the command was in flight. */
const checkRejection = (world: World, log: ReadonlyArray<AEvent>, id: string, rejected: Sent) => {
  const to = Math.min(rejected.to!, log.length);
  let justified = false;

  for (let k = rejected.from; k <= to && !justified; k++) {
    const view = fold(log, k).get(sessionOfCommand(rejected.command))!;
    justified = referenceDecide(view, rejected.command, rejected.device) === "reject";
  }

  if (!justified) {
    throw new Error(`${id} ${rejected.command._tag} was rejected but was acceptable throughout`);
  }

  world.checkedBlocks.add(`rejected:${id}`);
};

/** Answers: backed by the log, the same for every retry, and right per the reference decider. */
const checkCommands = (world: World, log: ReadonlyArray<AEvent>, blocks: Blocks) => {
  const byId = new Map<string, Array<Sent>>();

  for (const sent of world.sent) byId.set(sent.id, [...(byId.get(sent.id) ?? []), sent]);

  for (const [id, sends] of byId) {
    const block = blocks.get(id);
    checkAnswers(id, sends, block);

    if (block !== undefined && !world.checkedBlocks.has(id))
      checkBlock(world, log, sends[0]!, block);
    const rejected = sends.find((s) => s.answer?.startsWith("rejected:") && s.to !== null);

    if (
      rejected !== undefined &&
      block === undefined &&
      !world.checkedBlocks.has(`rejected:${id}`)
    ) {
      checkRejection(world, log, id, rejected);
    }
  }
};

/** Each request closes at most once, after it was opened. */
const closedRequests = (log: ReadonlyArray<AEvent>) => {
  const opened = new Map<string, number>();
  const closed = new Map<string, AEvent>();

  for (const e of log) {
    if (e.tag === "ApprovalRequested") {
      if (opened.has(e.requestId!)) throw new Error(`${e.requestId} was requested twice`);
      opened.set(e.requestId!, e.seq);
    }

    if (e.tag === "ApprovalResolved" || e.tag === "ApprovalWithdrawn") {
      if (closed.has(e.requestId!)) throw new Error(`${e.requestId} was closed twice`);

      if (!opened.has(e.requestId!)) throw new Error(`${e.requestId} was closed before it opened`);
      closed.set(e.requestId!, e);
    }
  }

  return closed;
};

/** Approvals: closed at most once, after they were opened; the first answer wins. */
const checkApprovals = (world: World, log: ReadonlyArray<AEvent>) => {
  const closed = closedRequests(log);
  const accepted = new Map<string, Array<Sent>>();

  for (const sent of world.sent) {
    if (!Predicate.isTagged(sent.command, "RespondToApproval") || !sent.answer?.startsWith("seq:"))
      continue;
    const r: string = sent.command.requestId;

    if (!(accepted.get(r) ?? []).some((s) => s.id === sent.id)) {
      accepted.set(r, [...(accepted.get(r) ?? []), sent]);
    }
  }

  for (const [r, winners] of accepted) {
    if (winners.length > 1) throw new Error(`${r} accepted ${winners.length} answers`);
    const resolved = closed.get(r);
    expect(resolved?.what).toBe(`resolved:${r}:${winners[0]!.device}`);
    expect(resolved?.commandId).toBe(winners[0]!.id);
  }
};

const acceptsDeferredInput = (before: View | undefined) =>
  before !== undefined &&
  workingTurnOf(before) === undefined &&
  (["idle", "dormant", "failed", "limited"].includes(before.state) ||
    (before.state === "needs-you" && before.pending.size === 0));

/** Only a live idle Harness starts a fresh Turn; approval requests need their Turn in flight. */
const checkHarnessReports = (log: ReadonlyArray<AEvent>) => {
  for (const e of log) {
    if (e.tag === "TurnStarted" && e.commandId === null) {
      const before = fold(log, e.seq - 1).get(e.session!);

      const allowed = e.autonomous ? before?.state === "idle" : acceptsDeferredInput(before);

      if (!allowed || before?.turns.has(e.turnId!))
        throw new Error(`Unexpected Harness Turn at ${e.seq}`);
    }

    if (e.tag !== "ApprovalRequested") continue;
    const v = fold(log, e.seq - 1).get(e.session!);

    if (v === undefined || workingTurnOf(v) !== e.turnId) {
      throw new Error(`${e.requestId} was recorded at ${e.seq} for ${e.turnId}, not in flight`);
    }
  }
};

/** Nothing is pending, and no session Working, without a Turn in flight; Archived holds neither. */
const checkTurnsInFlight = (log: ReadonlyArray<AEvent>) => {
  for (const [s, v] of fold(log)) {
    const working = workingTurnOf(v) !== undefined;

    if (v.pending.size > 0 && !working) throw new Error(`${s} has approvals pending with no Turn`);

    if (v.state === "working" && !working) throw new Error(`${s} is Working with no Turn`);

    if (v.state === "archived" && working)
      throw new Error(`${s} is Archived with a Turn in flight`);

    if (working && v.accepted !== null && v.order.length - 1 <= v.accepted)
      throw new Error(`${s} has an accepted Turn in flight`);
  }
};

/** The read model is the reference fold of the log. */
const checkReadModel = (model: ReadModel, log: ReadonlyArray<AEvent>) => {
  const views = fold(log);

  for (const s of SESSIONS) {
    const record = model.sessions.get(SessionId.make(s));
    const view = views.get(s);

    if (record === undefined || view === undefined) continue;

    if (model.sequence !== log.length) break; // it moved on while we read; next step checks it
    const state: string = record.session.state;
    expect({ s, state }).toEqual({ s, state: view.state });
    expect({ s, pending: [...record.pending.keys()].map(String).sort() }).toEqual({
      s,
      pending: [...view.pending].sort(),
    });
    const last = record.turns.at(-1);

    if (last !== undefined) expect(view.turns.get(last.id)).toBe(last.status);
  }
};

/** Each Snapshot a feed received matches the log at its sequence. */
const checkSnapshots = (label: string, copy: FeedCopy, log: ReadonlyArray<AEvent>) => {
  for (const snapshot of copy.snapshots) {
    const at = fold(log, snapshot.seq);

    for (const [s, [state, pending]] of snapshot.sessions) {
      const v = at.get(s);

      if (v === undefined) throw new Error(`${label} snapshot at ${snapshot.seq} has unknown ${s}`);
      expect({ label, s, seq: snapshot.seq, state, pending }).toEqual({
        label,
        s,
        seq: snapshot.seq,
        state: v.state,
        pending: [...v.pending].sort(),
      });
    }
  }
};

/** Feeds: a prefix of their stream, no duplicates, Snapshots that match the log. */
const checkFeeds = (feeds: ReadonlyArray<FeedCopy>, log: ReadonlyArray<AEvent>) => {
  for (const copy of feeds) {
    const { fs, seen, errors } = copy;
    const label = `${fs.client}/${fs.stream}`;

    if (errors.length > 0) throw new Error(`${label}: ${errors.join("; ")}`);
    const view = viewOfFeed({ ...fs, seen }, log);
    const stream = streamSeqs(log, fs.stream);

    if (!isPrefix(view, stream)) {
      throw new Error(`${label} saw ${view.join(",")} of ${stream.join(",")}`);
    }

    checkSnapshots(label, copy, log);
    fs.snapshots.splice(0, copy.snapshots.length);
  }
};

export const checkInvariants = async (world: World) => {
  // Feeds first: whatever they saw must already be in the log read next.
  const feeds = world.feeds.map((fs): FeedCopy => ({
    fs,
    seen: [...fs.seen],
    snapshots: [...fs.snapshots],
    errors: [...fs.errors],
  }));

  const log = await world.readLog();
  const model = world.model();

  // Gapless, and exactly what the read model has folded.
  for (const [i, e] of log.entries()) expect(e.seq).toBe(i + 1);
  expect(model.sequence).toBeGreaterThanOrEqual(log.length);

  checkCommands(world, log, commandBlocks(log));
  checkApprovals(world, log);
  checkHarnessReports(log);
  checkTurnsInFlight(log);
  checkReadModel(model, log);
  checkFeeds(feeds, log);
};
