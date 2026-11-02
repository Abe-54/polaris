import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { AttemptId, BackgroundTask, CommandId, type HarnessKind } from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import { TestClock } from "effect/testing";
import { C, CID, HOST, report } from "../../engine/constellation.testing.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { emptyResources } from "../../resources/model.ts";
import { EventStore } from "../../store/EventStore.ts";
import { workerLine } from "../slots.ts";
import { stallAudit } from "../stall.ts";
import { Constellations } from "../service.ts";
import { WAIT_CEILING_MS, WAIT_GRACE_MS } from "../waiting.ts";
import { ConstellationDelivery } from "./index.ts";
import { newTurn } from "./turns.ts";
import { WORKER, finish, send, setup, signal, wait, world } from "./testing.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

// After every wall-clock Turn start in the fixture, so Turn ends read as later than they began.
const T0 = Date.now() + 3_600_000;

const iso = (ms: number) => new Date(ms).toISOString();

const ATTEMPT = AttemptId.make("a1");

const SCRIPT = new BackgroundTask({ id: "bash-1", kind: "command", description: "bench.sh" });

const background = (tasks: ReadonlyArray<BackgroundTask>) =>
  signal(WORKER, { type: "harness.backgroundTasksChanged", tasks });

/** The Attempt's brief Turn (`a1:start`), as startup submits it. */
const brief = Effect.fnUntraced(function* () {
  const record = (yield* (yield* EventStore).model).sessions.get(WORKER)!;

  return yield* signal(WORKER, {
    type: "turn.send",
    turn: newTurn(record.session, "Brief", new Date().toISOString(), `${ATTEMPT}:start`),
  });
});

/** A Turn started at `at` on the test clock, like a user message after the wait was declared. */
const turnAt = Effect.fnUntraced(function* (text: string, at: number) {
  const record = (yield* (yield* EventStore).model).sessions.get(WORKER)!;

  return yield* signal(WORKER, { type: "turn.send", turn: newTurn(record.session, text, iso(at)) });
});

const graph = Effect.fnUntraced(function* () {
  const model = yield* (yield* EventStore).model;

  return { record: model.constellations.get(CID)!, sessions: model.sessions };
});

const stopped = Effect.fnUntraced(function* () {
  const { record } = yield* graph();

  return record.graph.pendingNotifications.filter((n) => Predicate.isTagged(n.item, "Stopped"));
});

/** Waits until exactly one Stopped notification is queued for the Lead. */
const stoppedOnce = Effect.fnUntraced(function* () {
  const store = yield* EventStore;

  yield* wait(() =>
    stopped().pipe(
      Effect.map((s) => s.length === 1),
      Effect.provideService(EventStore, store)
    )
  );
});

const host = (now: number) => ({ hostId: HOST, resources: emptyResources(), now });

/** The worker line and stall audit the Lead's `status` and digest read at `now`. */
const seen = Effect.fnUntraced(function* (now: number) {
  const { record, sessions } = yield* graph();
  const attempt = record.graph.attempts.find((a) => a.id === ATTEMPT)!;

  return {
    line: workerLine(record, attempt, sessions.get(WORKER)!, host(now)),
    audit: stallAudit(record, sessions, host(now)),
  };
});

/** The worker's brief Turn ends silently once, so it is nudged; the nudge Turn is left running. */
const nudgedOnce = Effect.fnUntraced(function* (w: ReturnType<typeof world>, at: number) {
  yield* TestClock.setTime(at);
  yield* brief();
  yield* (yield* ConstellationDelivery).start();
  yield* finish(WORKER, "completed", iso(at));
  yield* wait(() => Effect.succeed(w.turns.length === 1));
});

const declare = (on: string, minutes: number, now: number) =>
  Effect.gen(function* () {
    const graphs = yield* Constellations;
    yield* graphs.command(
      { kind: "session", sessionId: WORKER },
      CommandId.make(crypto.randomUUID()),
      C.WorkerProgress.make({
        constellationId: CID,
        attemptId: ATTEMPT,
        note: `Waiting on ${on}`,
        completed: null,
        total: null,
        waiting: { on, until: iso(now + minutes * 60_000) },
      })
    );
  });

const claudeWorld = (file?: string) => world(file, { canSteer: false });

const start = (harness: HarnessKind) => setup(undefined, harness);

test("a Claude Code worker that ends its Turn on a background command is waiting, not stopped or stalled", async () => {
  const w = claudeWorld();
  await w.run(
    Effect.gen(function* () {
      yield* start("claude");
      yield* nudgedOnce(w, T0);
      // The nudge Turn starts a 9-minute script in the background and ends to wait on it.
      yield* background([SCRIPT]);
      yield* finish(WORKER, "completed", iso(T0 + 1000));
      yield* (yield* ConstellationDelivery).flush();

      for (const now of [T0 + 1000, T0 + 9 * 60_000]) {
        yield* TestClock.setTime(now);
        yield* (yield* ConstellationDelivery).flush();
        expect(yield* stopped()).toEqual([]);
        const { line, audit } = yield* seen(now);
        expect(line).toStartWith("Worker: waiting on a command");
        expect(line).toContain("(bench.sh)");
        expect(audit).toBeNull();
      }

      expect(w.turns).toHaveLength(1);

      // The script reports and Claude Code starts its own Turn: the worker is working again.
      yield* background([]);
      yield* send(WORKER, "[Background task continuation]");
      expect((yield* seen(T0 + 9 * 60_000 + 1000)).line).toBe("Worker: Turn running");
    })
  );
});

test("background work that ends with no Turn after the grace gets the silent end: nudge, then Stopped", async () => {
  const w = claudeWorld();
  await w.run(
    Effect.gen(function* () {
      yield* start("claude");
      yield* TestClock.setTime(T0);
      yield* brief();
      yield* (yield* ConstellationDelivery).start();
      yield* background([SCRIPT]);
      yield* finish(WORKER, "completed", iso(T0));
      yield* TestClock.setTime(T0 + 5 * 60_000);
      yield* background([]);
      expect((yield* seen(T0 + 5 * 60_000)).line).toStartWith("Worker: waiting on background work");

      // Claude Code would start its Turn within a second; none comes.
      yield* TestClock.adjust(WAIT_GRACE_MS - 1);
      expect(w.turns).toHaveLength(0);
      yield* TestClock.adjust(1);
      yield* wait(() => Effect.succeed(w.turns.length === 1));
      expect(w.prompts[0]).toContain("Your Attempt isn't claimed");

      // The nudged worker waits on a second command that also never wakes it: now it stopped.
      yield* background([SCRIPT]);
      yield* finish(WORKER, "completed", iso(T0 + 8 * 60_000));
      yield* TestClock.setTime(T0 + 9 * 60_000);
      yield* background([]);
      expect(yield* stopped()).toEqual([]);
      yield* TestClock.adjust(WAIT_GRACE_MS);
      yield* stoppedOnce();
      expect(w.turns).toHaveLength(1);
    })
  );
});

test("a wait past the ceiling is a silent end, and the wake survives a Daemon restart", async () => {
  const dir = newTempDir("wait-ceiling-", { short: true });
  dirs.push(dir);
  const file = join(dir, "state.sqlite");

  const w = claudeWorld(file);
  await w.run(
    Effect.gen(function* () {
      yield* start("claude");
      yield* nudgedOnce(w, T0);
      yield* background([SCRIPT]);
      yield* finish(WORKER, "completed", iso(T0 + 1000));
    })
  );

  const restarted = claudeWorld(file);
  await restarted.run(
    Effect.gen(function* () {
      const delivery = yield* ConstellationDelivery;
      yield* TestClock.setTime(T0 + 1000);
      yield* delivery.start();
      yield* TestClock.setTime(T0 + 1000 + WAIT_CEILING_MS - 1);
      expect(yield* stopped()).toEqual([]);
      expect((yield* seen(T0 + 1000 + WAIT_CEILING_MS - 1)).audit).toBeNull();
      yield* TestClock.adjust(1);
      yield* stoppedOnce();
      // Past the ceiling the Lead's status no longer calls it waiting.
      const later = T0 + 1000 + WAIT_CEILING_MS;
      expect((yield* seen(later)).line).toStartWith("Worker: idle");
    })
  );
});

test("a declared wait holds until the worker's next Turn, and a Claim clears it", async () => {
  const w = claudeWorld();
  await w.run(
    Effect.gen(function* () {
      // Codex never wakes on its own, so only the declared wait holds off the nudge.
      yield* start("codex");
      yield* TestClock.setTime(T0);
      yield* brief();
      yield* (yield* ConstellationDelivery).start();
      yield* declare("pre-push hook", 10, T0);
      yield* finish(WORKER, "completed", iso(T0 + 1000));
      // The observer handles the Turn end on its own fiber; give a wrong nudge time to land.
      yield* Effect.promise(() => Bun.sleep(50));
      yield* (yield* ConstellationDelivery).flush();
      expect(w.turns).toHaveLength(0);
      expect((yield* seen(T0 + 60_000)).line).toStartWith("Worker: waiting on pre-push hook");

      // The user messages the worker: that Turn clears the wait, so its silent end is nudged.
      yield* turnAt("How is it going?", T0 + 110_000);
      yield* finish(WORKER, "completed", iso(T0 + 120_000));
      yield* wait(() => Effect.succeed(w.turns.length === 1));

      // Declared again in the nudge Turn, then the worker claims: the Claim ends the wait.
      yield* declare("pre-push hook", 10, T0 + 130_000);
      const graphs = yield* Constellations;
      yield* graphs.command(
        { kind: "session", sessionId: WORKER },
        CommandId.make(crypto.randomUUID()),
        C.WorkerClaim.make({ constellationId: CID, attemptId: ATTEMPT, claim: report() })
      );
      yield* finish(WORKER, "completed", iso(T0 + 140_000));
      const { record, sessions } = yield* graph();
      const attempt = record.graph.attempts.find((a) => a.id === ATTEMPT)!;
      expect(attempt.state).toBe("review");
      expect(workerLine(record, attempt, sessions.get(WORKER)!, host(T0 + 150_000))).not.toContain(
        "waiting"
      );
    })
  );
});

test("a Codex worker with background processes is nudged at once, as before", async () => {
  const w = claudeWorld();
  await w.run(
    Effect.gen(function* () {
      yield* start("codex");
      yield* TestClock.setTime(T0);
      yield* brief();
      yield* (yield* ConstellationDelivery).start();
      yield* background([SCRIPT]);
      yield* finish(WORKER, "completed", iso(T0));
      yield* wait(() => Effect.succeed(w.turns.length === 1));
      expect(w.prompts[0]).toContain("Your Attempt isn't claimed");
    })
  );
});
