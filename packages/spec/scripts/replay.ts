#!/usr/bin/env bun
/**
 * Trace validation: replay logs the real Engine committed against polaris.qnt.
 *
 *   POLARIS_TRACE_DIR=/tmp/traces bun test apps/daemon/src/verification/engine.model.slow.test.ts
 *   bun packages/spec/scripts/replay.ts /tmp/traces
 *
 * The Engine's model-based test writes, per run, the committed log (abstracted),
 * the commands the Clients sent, and where the Daemon restarted. For each trace
 * this script maps the log to the spec's events, splits it into the decisions
 * that produced it (a Client command, a Harness report, a restart's recovery),
 * and writes a Quint run that replays those decisions through the spec's own
 * actions (`clientSends`, `harnessReports`, `commitBatch`, `publishBatch`,
 * `reactorRuns`, `crash`, `restart`). `quint test` then checks that the spec
 * records exactly the same events, in the same order, and that `safety` holds
 * after every decision. A mismatch means the spec and the code disagree.
 *
 * The mapping is the spec's abstraction (README.md): Starting counts as
 * Working, and events the spec leaves out (checkpoints, cursors, renames,
 * Workspaces) are dropped. Anything it cannot map is reported as an error.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Match, Schema } from "effect";

const TEvent = Schema.Struct({
  seq: Schema.Number,
  commandId: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  tag: Schema.String,
  what: Schema.String,
  turnId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  index: Schema.optional(Schema.Number),
  autonomous: Schema.optional(Schema.Boolean),
  inputRefused: Schema.optional(Schema.Boolean),
});

type TEvent = typeof TEvent.Type;

const SessionCommand = <Tag extends string>(tag: Tag) =>
  Schema.TaggedStruct(tag, { sessionId: Schema.String });

/** The commands the spec models, then any other command (only its tag is read). */
const TCommand = Schema.Union([
  SessionCommand("SendTurn"),
  SessionCommand("Continue"),
  SessionCommand("Retry"),
  Schema.TaggedStruct("RespondToApproval", {
    sessionId: Schema.String,
    requestId: Schema.String,
  }),
  SessionCommand("ArchiveSession"),
  SessionCommand("UnarchiveSession"),
  Schema.TaggedStruct("AcceptTurns", { sessionId: Schema.String, throughTurnId: Schema.String }),
  Schema.Struct({ _tag: Schema.String, sessionId: Schema.optional(Schema.String) }),
]);

type TCommand = typeof TCommand.Type;

const Trace = Schema.Struct({
  log: Schema.Array(TEvent),
  commands: Schema.Record(
    Schema.String,
    Schema.Struct({ device: Schema.String, command: TCommand })
  ),
  restarts: Schema.Array(Schema.Number),
});

type Trace = typeof Trace.Type;

const decodeTrace = Schema.decodeUnknownSync(Schema.fromJsonString(Trace));

interface SpecEvent {
  readonly session: string;
  readonly cmd: string;
  readonly kind: string;
}

interface Unit {
  /** Quint actions, in order. */
  readonly actions: ReadonlyArray<string>;
  readonly events: ReadonlyArray<SpecEvent>;
  readonly label: string;
}

/** A trace as spec decisions, and the session each approval request belongs to. */
export interface Replay {
  readonly units: Array<Unit>;
  readonly requests: Map<string, string>;
}

const DROPPED = new Set([
  "SessionCreated",
  "CheckpointRecorded",
  "SessionCursorUpdated",
  "SessionRenamed",
  "SessionPinned",
  "SessionPermissionModeChanged",
  "SessionModelChanged",
  "SessionContextUsed",
  "SessionSetupChanged",
  "SubagentStarted",
  "SubagentEnded",
  "WorkspaceRegistered",
  "WorkspaceUpdated",
  "WorkspaceRemoved",
  "WorktreeDetected",
  "WorktreeRemoved",
]);

/** Outside the spec even with a command id (an agent's `notify`, a failed move): left out of the log. */
const UNMODELLED = new Set(["SessionNotified", "SessionBackgroundCommandFailed"]);

const SESSIONS = ["s1", "s2"];

const COMMIT = ["commitBatch", "publishBatch"];

const q = (s: string) => JSON.stringify(s);

/** The spec has no Starting: it counts as Working. */
const norm = (state: string) => (state === "starting" ? "working" : state);

const byOf = (e: TEvent) => e.what.split(":")[2]!;

/** The Daemon withdrawing a Secret Request that timed out (`engine/secretRequests.ts`). */
const isExpiry = (e: TEvent) =>
  e.tag === "ApprovalWithdrawn" && byOf(e) === "daemon" && e.reason === "The request timed out";

const withdrawalOf = (e: TEvent): "HExpire" | "HWithdraw" | null => {
  if (isExpiry(e)) return "HExpire";

  return e.tag === "ApprovalWithdrawn" && byOf(e) === "harness" ? "HWithdraw" : null;
};

const isRecovery = (e: TEvent) =>
  e.commandId === null &&
  !isExpiry(e) &&
  ((e.tag === "TurnEnded" && e.status === "interrupted") ||
    (e.tag === "ApprovalWithdrawn" && byOf(e) === "daemon") ||
    (e.tag === "SessionStateChanged" &&
      ((e.state === "needs-you" && e.reason === "interrupted") ||
        (e.state === "dormant" && e.reason === "daemon-restart"))));

/** Each restart's recovery: the recovery-shaped Daemon events right before its point. */
const recoveryPoints = (trace: Trace): Map<number, number> => {
  const log = trace.log;
  const recoveryOf = new Map<number, number>();
  trace.restarts.forEach((point, r) => {
    for (let i = point - 1; i >= 0 && isRecovery(log[i]!) && !recoveryOf.has(log[i]!.seq); i--) {
      recoveryOf.set(log[i]!.seq, r);
    }
  });

  return recoveryOf;
};

/**
 * The spec's command for a Client command in session `s`; null if the spec has
 * none. `turnNumber` is the spec's number of a Turn (0 for one it never saw).
 */
const specCommand = (
  command: TCommand,
  s: string,
  turnNumber: (turnId: string) => number
): string | null =>
  Match.value(command).pipe(
    Match.tag("SendTurn", () => `SendTurn(${q(s)})`),
    Match.tag("Continue", () => `Continue(${q(s)})`),
    Match.tag("Retry", () => `Retry(${q(s)})`),
    Match.tag("RespondToApproval", (c) => `Respond({ session: ${q(s)}, req: ${q(c.requestId)} })`),
    Match.tag("ArchiveSession", () => `Archive(${q(s)})`),
    Match.tag("UnarchiveSession", () => `Unarchive(${q(s)})`),
    Match.tag(
      "AcceptTurns",
      (c) => `AcceptTurns({ session: ${q(s)}, through: ${turnNumber(c.throughTurnId)} })`
    ),
    Match.orElse(() => null)
  );

/** The Turn ends a Harness reports: completed goes Idle, failed goes Failed. */
const ENDS = new Set(["completed", "failed"]);

/** A usage limit ends the Turn Interrupted, then the session goes Limited. */
const limitEndAt = (log: ReadonlyArray<TEvent>, j: number): boolean => {
  const e = log[j]!;

  if (e.tag !== "TurnEnded" || e.status !== "interrupted" || e.commandId !== null) return false;
  let k = j + 1;

  while (k < log.length && log[k]!.session === e.session && DROPPED.has(log[k]!.tag)) k++;

  return (
    k < log.length &&
    log[k]!.commandId === null &&
    log[k]!.tag === "SessionStateChanged" &&
    log[k]!.state === "limited"
  );
};

/** A Turn's end the Harness reported (not a restart's or a Client's). */
const harnessEndAt = (log: ReadonlyArray<TEvent>, j: number): boolean =>
  log[j]!.commandId === null &&
  log[j]!.tag === "TurnEnded" &&
  (ENDS.has(log[j]!.status!) || limitEndAt(log, j));

/** A Turn's reactor opens the Harness; Archive's stops it. */
const REACTS = new Set(["SendTurn", "Continue", "Retry", "ArchiveSession"]);

class Replayer {
  private readonly state = new Map<string, string>();
  private readonly turns = new Map<string, Set<string>>();
  private readonly requests = new Map<string, string>();
  private readonly units: Array<Unit> = [];
  private readonly recoveryOf: Map<number, number>;
  private readonly log: ReadonlyArray<TEvent>;
  private nextRestart = 0;
  private i = 0;

  constructor(private readonly trace: Trace) {
    this.log = trace.log.filter((e) => !UNMODELLED.has(e.tag));
    this.recoveryOf = recoveryPoints(trace);
  }

  run(): Replay {
    while (this.i < this.log.length) this.step(this.log[this.i]!);
    this.flushRestarts(Number.POSITIVE_INFINITY);

    return { units: this.units, requests: this.requests };
  }

  private stateOf(s: string) {
    return this.state.get(s) ?? "dormant";
  }

  /** The spec event for an engine event, updating the tracked state; null if dropped. */
  private map(e: TEvent, cmd: string, keepSameState: boolean): SpecEvent | null {
    if (DROPPED.has(e.tag) || e.session === null) return null;
    const s = e.session;
    const out = (kind: string): SpecEvent => ({ session: s, cmd, kind });

    switch (e.tag) {
      case "TurnStarted": {
        const continued = this.startTurn(s, e.turnId!);

        return out(
          cmd === "" && e.autonomous === false && !continued
            ? "UserTurnStarted"
            : `TurnStarted(${continued})`
        );
      }

      case "TurnEnded":
        return out(`TurnEnded(${q(e.status!)})`);
      case "TurnItemCompleted":
        return out("ItemCompleted");
      case "SessionStateChanged": {
        const n = norm(e.state!);

        if (!keepSameState && n === this.stateOf(s)) return null;
        this.state.set(s, n);

        return out(`StateChanged(${q(n)})`);
      }

      case "ApprovalRequested":
        this.requests.set(e.requestId!, s);

        return out(`ApprovalRequested(${q(e.requestId!)})`);
      case "ApprovalResolved":
        return out(`ApprovalResolved({ req: ${q(e.requestId!)}, by: ${q(byOf(e))} })`);
      case "ApprovalWithdrawn":
        return out(`ApprovalWithdrawn({ req: ${q(e.requestId!)}, by: ${q(byOf(e))} })`);
      case "TurnsAccepted":
        return out(`TurnsAccepted(${e.index! + 1})`);
      default:
        throw new Error(`seq ${e.seq}: no spec event for ${e.tag}`);
    }
  }

  /** The spec's number of a Turn: its position among the session's Turns, from 1 (0: unknown). */
  private turnNumber(s: string, turnId: string): number {
    return [...(this.turns.get(s) ?? [])].indexOf(turnId) + 1;
  }

  /** Records a Turn as started; true if it had started before (a continuation). */
  private startTurn(s: string, turnId: string): boolean {
    const known = this.turns.get(s) ?? new Set();
    const continued = known.has(turnId);
    known.add(turnId);
    this.turns.set(s, known);

    return continued;
  }

  private mapAll(events: ReadonlyArray<TEvent>, cmd: string): Array<SpecEvent> {
    return events.flatMap((e) => this.map(e, cmd, true) ?? []);
  }

  private flushRestarts(beforeSeq: number) {
    const restarts = this.trace.restarts;

    while (this.nextRestart < restarts.length && restarts[this.nextRestart]! < beforeSeq) {
      const r = this.nextRestart++;
      const recovery = this.log.filter((e) => this.recoveryOf.get(e.seq) === r);
      const events = this.mapAll(recovery, "");
      // The sessions in the order the engine recovered them, then the ones it left alone.
      const order = [...new Set([...recovery.map((e) => e.session!), ...SESSIONS])];
      this.units.push({
        actions: ["crash", `restartIn([${order.map(q).join(", ")}])`],
        events,
        label: `restart ${r + 1}`,
      });
    }
  }

  private step(e: TEvent) {
    if (this.recoveryOf.has(e.seq)) {
      this.i++;

      return;
    }

    this.flushRestarts(e.seq);

    if (e.commandId !== null) this.clientCommand(e, e.commandId);
    // Something the Daemon recorded on its own: a Harness report, one decision each.
    else if (DROPPED.has(e.tag)) this.i++;
    else this.daemonDecision(e, e.session!);
  }

  /** A Client command: its events are contiguous (checked by the test itself). */
  private clientCommand(e: TEvent, id: string) {
    const block: Array<TEvent> = [];

    while (this.i < this.log.length && this.log[this.i]!.commandId === id) {
      block.push(this.log[this.i++]!);
    }

    const setup = /^setup-(s\d+)-/.exec(id);

    if (setup !== null) {
      this.startSession(id, setup[1]!, block);

      return;
    }

    const events = this.mapAll(block, id);

    if (events.length === 0) return; // RenameSession, PinSession, RegisterWorkspace: nothing the spec models
    const sent = this.trace.commands[id];

    if (sent === undefined) throw new Error(`seq ${e.seq}: unknown command ${id}`);
    const s = sent.command.sessionId!;
    const command = specCommand(sent.command, s, (turnId) => this.turnNumber(s, turnId));

    if (command === null) throw new Error(`seq ${e.seq}: no spec command for ${sent.command._tag}`);
    this.units.push({
      actions: [
        `clientSends(${q(sent.device)}, ${q(id)}, ${command})`,
        ...COMMIT,
        ...(REACTS.has(sent.command._tag) ? [`reactorRuns(${q(s)})`] : []),
      ],
      events,
      label: `${id} ${sent.command._tag}`,
    });
  }

  /** StartSession: the spec's sessions exist from the start, Dormant; starting one is a SendTurn. */
  private startSession(id: string, s: string, block: ReadonlyArray<TEvent>) {
    const events = this.mapAll(block, id);
    this.state.set(s, "working");
    this.units.push({
      actions: [
        `clientSends("mac", ${q(id)}, SendTurn(${q(s)}))`,
        ...COMMIT,
        `reactorRuns(${q(s)})`,
      ],
      events: [...events, { session: s, cmd: id, kind: 'StateChanged("working")' }],
      label: `${id} StartSession`,
    });
  }

  private turnStarted(e: TEvent, s: string) {
    this.i++;

    const followed = this.take(s, (x) => x.tag === "SessionStateChanged" && x.state === "working");

    this.harness(
      s,
      e.autonomous === false ? "HUserTurnStarted" : "HTurnStarted",
      followed ? [e, followed] : [e]
    );
  }

  private daemonDecision(e: TEvent, s: string) {
    if (e.tag === "TurnStarted") {
      this.turnStarted(e, s);
    } else if (e.tag === "ApprovalRequested") {
      this.i++;

      const followed = this.take(
        s,
        (x) => x.tag === "SessionStateChanged" && x.state === "needs-you"
      );

      this.harness(s, `HRequest(${q(e.requestId!)})`, followed ? [e, followed] : [e]);
    } else if (e.tag === "TurnItemCompleted") {
      this.i++;
      this.harness(s, e.inputRefused === true ? "HInputRefused" : "HItem", [e]);
    } else if (this.endsTurn(e, s)) {
      this.turnEnded(e, s);
    } else if (withdrawalOf(e) !== null) {
      this.withdrawal(e, s);
    } else if (e.tag === "SessionStateChanged" && norm(e.state!) === this.stateOf(s)) {
      // The reactor moving Starting → Working: no change in the spec's terms.
      this.i++;
    } else {
      throw new Error(`seq ${e.seq}: cannot map ${e.what} (${s}) to a spec decision`);
    }
  }

  /** A single request withdrawn mid-Turn: by its Harness, or by the Daemon when it timed out. */
  private withdrawal(e: TEvent, s: string) {
    this.i++;

    const followed = this.take(s, (x) => x.tag === "SessionStateChanged" && x.state === "working");

    this.harness(s, `${withdrawalOf(e)}(${q(e.requestId!)})`, followed ? [e, followed] : [e]);
  }

  private endsTurn(e: TEvent, s: string): boolean {
    return (
      (e.tag === "ApprovalWithdrawn" && byOf(e) === "harness" && this.endsTurnAfter(this.i, s)) ||
      harnessEndAt(this.log, this.i)
    );
  }

  private turnEnded(e: TEvent, s: string) {
    const events: Array<TEvent> = [];

    while (this.log[this.i]!.tag !== "TurnEnded") {
      if (!DROPPED.has(this.log[this.i]!.tag)) events.push(this.log[this.i]!);
      this.i++;
    }

    const ended = this.log[this.i++]!;
    events.push(ended);

    const [next, report] = Match.value(ended.status).pipe(
      Match.when("failed", () => ["failed", "HTurnFailed"] as const),
      Match.when("interrupted", () => ["limited", "HTurnLimited"] as const),
      Match.orElse(() => ["idle", "HTurnEnded"] as const)
    );

    const closing = this.take(s, (x) => x.tag === "SessionStateChanged" && x.state === next);

    if (closing === null) throw new Error(`seq ${e.seq}: a Turn ended without going ${next}`);
    this.harness(s, report, [...events, closing]);
  }

  /** The next Daemon event of session `s` if `pred` holds for it, skipping dropped ones. */
  private take(s: string, pred: (x: TEvent) => boolean): TEvent | null {
    const log = this.log;
    let j = this.i;

    while (j < log.length && log[j]!.commandId === null && DROPPED.has(log[j]!.tag)) j++;

    if (j < log.length && log[j]!.commandId === null && log[j]!.session === s && pred(log[j]!)) {
      this.i = j + 1;

      return log[j]!;
    }

    return null;
  }

  private harness(s: string, report: string, events: ReadonlyArray<TEvent>) {
    this.units.push({
      actions: [`harnessReports(${q(s)}, ${report})`, ...COMMIT],
      events: this.mapAll(events, ""),
      label: `${s} ${report}`,
    });
  }

  /**
   * Whether the harness withdrawal at `from` opens a Turn's end. That block records
   * its checkpoint before its withdrawals, so one followed by a checkpoint stood alone.
   */
  private endsTurnAfter(from: number, s: string): boolean {
    const log = this.log;
    let j = from;

    while (
      j < log.length &&
      log[j]!.commandId === null &&
      log[j]!.session === s &&
      (log[j]!.tag === "ApprovalWithdrawn" || DROPPED.has(log[j]!.tag))
    ) {
      if (j > from && log[j]!.tag === "CheckpointRecorded") return false;
      j++;
    }

    return j < log.length && harnessEndAt(log, j);
  }
}

export const toUnits = (trace: Trace): Replay => new Replayer(trace).run();

export const toQuint = (name: string, trace: Trace): string => {
  const { units, requests } = toUnits(trace);
  const cmdIds = new Set<string>();

  for (const unit of units) {
    for (const action of unit.actions) {
      const m = /^clientSends\("[^"]*", "([^"]+)"/.exec(action);

      if (m) cmdIds.add(m[1]!);
    }
  }

  if (cmdIds.size === 0) cmdIds.add("unused");

  if (requests.size === 0) requests.set("unused", "s1");
  const expected: Array<string> = [];
  const lines: Array<string> = ["    init"];

  for (const unit of units) {
    for (const event of unit.events) {
      expected.push(
        `{ seq: ${expected.length + 1}, session: ${q(event.session)}, cmd: ${q(event.cmd)}, kind: ${event.kind} }`
      );
    }

    for (const action of unit.actions) lines.push(`      .then(${action})`);
    lines.push(
      `      // ${unit.label}`,
      `      .expect(log == EXPECTED.slice(0, ${expected.length}) and safety)`
    );
  }

  return `// Generated by packages/spec/scripts/replay.ts from ${name}. Do not edit.
module ${name} {
  import polaris(
    HOST_FEED_GAPLESS = false,
    ARCHIVE_IGNORES_TURN = false,
    RECORDS_LATE_REQUESTS = false,
    CONTINUES_ACCEPTED = false,
    REVIEW_COMMANDS = true,
    USAGE_LIMITS = true,
    WORKSPACE_REMOVAL = false,
    CLIENTS = Set("mac", "phone"),
    SESSION_LIST = ["s1", "s2"],
    CMD_IDS = Set(${[...cmdIds].map(q).join(", ")}),
    REQUESTS = Set(${[...requests.keys()].map(q).join(", ")}),
    REQUEST_SESSION = Map(${[...requests].map(([r, s]) => `${q(r)} -> ${q(s)}`).join(", ")}),
    CAPACITY = 1,
    MAX_LOG = 100000,
    MAX_CRASHES = ${trace.restarts.length + 1},
  ).* from "../polaris"

  pure val EXPECTED: List[Event] = [
    ${expected.join(",\n    ")}
  ]

  run replayTest =
${lines.join("\n")}
}
`;
};

if (import.meta.main) {
  const dir = process.argv[2];

  if (dir === undefined) {
    console.error("usage: bun scripts/replay.ts <trace dir>");
    process.exit(2);
  }

  const specDir = join(import.meta.dir, "..");
  const out = join(specDir, ".replay");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const quint = join(specDir, "node_modules", ".bin", "quint");

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let failed = 0;
  let events = 0;
  let decisions = 0;
  const jobs: Array<{ readonly file: string; readonly name: string; readonly path: string }> = [];

  for (const file of files) {
    const name = `replay_${basename(file, ".json").replace(/[^A-Za-z0-9]/g, "_")}`;

    try {
      const trace = decodeTrace(readFileSync(join(dir, file), "utf8"));
      const source = toQuint(name, trace);
      const { units } = toUnits(trace);
      decisions += units.length;
      events += units.reduce((n, u) => n + u.events.length, 0);
      const path = join(out, `${name}.qnt`);
      writeFileSync(path, source);
      jobs.push({ file, name, path });
    } catch (error) {
      failed++;
      console.error(`✗ ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The TypeScript evaluator: the Rust one hits a recursion limit on long runs.
  const check = async ({ file, name, path }: (typeof jobs)[number]) => {
    const proc = Bun.spawn(
      [quint, "test", path, `--main=${name}`, "--match=replayTest", "--backend=typescript"],
      { cwd: specDir, stdout: "pipe", stderr: "pipe" }
    );

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (code !== 0) {
      failed++;
      console.error(`✗ ${file} (${path})\n${stdout}${stderr}`);
    } else {
      console.log(`✓ ${file}`);
    }
  };

  const parallel = Math.max(1, Math.min(8, navigator.hardwareConcurrency ?? 4));

  for (let i = 0; i < jobs.length; i += parallel) {
    await Promise.all(jobs.slice(i, i + parallel).map(check));
  }

  console.log(
    `${files.length - failed}/${files.length} traces conform (${decisions} decisions, ${events} spec events)`
  );
  process.exit(failed === 0 && files.length > 0 ? 0 : 1);
}
