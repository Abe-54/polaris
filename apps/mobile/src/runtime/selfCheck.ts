/**
 * Proves the shared runtime works on the engine running it: Effect 4, the protocol's frame codec
 * and Schemas, the client's Connection State machine and resumable feed, and the Markdown parser.
 * The Hermes test runs this on the `hermes` VM; the app runs it at startup in development.
 */
import {
  connectionMachine,
  connectionStateOf,
  DEFAULT_POLICY,
  initialConnection,
} from "@polaris/client/connection";
import { ConnectFailure } from "@polaris/client/failures";
import { makeFeed, type SequenceMark } from "@polaris/client/resume";
import {
  decodePairingString,
  encodeBlob,
  encodeJsonFrame,
  encodePairingString,
  FrameDecoder,
  PairingPayload,
  readTraceContext,
  SelfTraceBatch,
  type SelfTraceBatch as Batch,
} from "@polaris/protocol";
import { Data, Effect, Option, Schema, Stream } from "effect";
import { alignChange } from "../diff/align.ts";
import { lineOf } from "../markdown/line.ts";
import { parseAfter } from "../markdown/parse.ts";
import { openSelfTracer } from "../selfTraces/tracer.ts";

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const expectEqual = <A>(actual: A, expected: A): string | null => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  return a === e ? null : `expected ${e}, got ${a}`;
};

const Turn = Schema.Struct({ id: Schema.String, items: Schema.Array(Schema.Number) });

const effectCheck = Effect.gen(function* () {
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Turn))(
    '{"id":"t1","items":[1,2,3]}'
  );

  const sum = yield* Stream.fromIterable(decoded.items).pipe(
    Stream.mapEffect((n) => Effect.sleep("1 millis").pipe(Effect.as(n * 2))),
    Stream.runFold(
      () => 0,
      (total, n) => total + n
    )
  );

  const refused = yield* Schema.decodeUnknownEffect(Turn)({ id: 1 }).pipe(
    Effect.match({ onFailure: () => "refused", onSuccess: () => "accepted" })
  );

  return expectEqual({ sum, refused }, { sum: 12, refused: "refused" });
});

const frameCheck = Effect.sync(() => {
  const blob = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
  const bytes = [encodeJsonFrame('{"hello":"✦ polaris"}'), ...encodeBlob("b1", blob)];
  const decoder = new FrameDecoder();

  const frames = bytes.flatMap((frame) =>
    // One byte at a time: every frame arrives split across chunks.
    Array.from(frame, (byte) => decoder.push(Uint8Array.of(byte))).flat()
  );

  const json = frames[0];

  const blobBytes = frames
    .slice(1)
    .flatMap((frame) => (frame.kind === "blob" ? Array.from(frame.bytes) : []));

  const pairing = Schema.decodeUnknownSync(PairingPayload)({
    hostName: "studio",
    hostId: "h1",
    url: "ws://127.0.0.1:7477/polaris/rpc",
    token: "pol_ext_x",
    name: "phone",
  });

  const roundTrip = decodePairingString(encodePairingString(pairing));

  return expectEqual(
    {
      json: json?.kind === "json" ? json.text : null,
      blob: blobBytes.length === blob.length && blobBytes.every((b, i) => b === blob[i]),
      pending: decoder.pendingBytes,
      pairing: Option.getOrNull(roundTrip),
    },
    { json: '{"hello":"✦ polaris"}', blob: true, pending: 0, pairing }
  );
});

const machineCheck = Effect.sync(() => {
  const failure = (kind: "transient" | "needs-attention", reason: ConnectFailure["reason"]) =>
    new ConnectFailure({ kind, reason, detail: reason });

  const steps: Array<Parameters<typeof connectionMachine.transition>[1]> = [
    { type: "failed", failure: failure("transient", "unreachable"), now: 1_000, jitter: 0.5 },
    { type: "connected", epoch: 1 },
    { type: "failed", failure: failure("transient", "connection-lost"), now: 2_000, jitter: 0 },
    { type: "failed", failure: failure("needs-attention", "auth-failed"), now: 3_000, jitter: 0 },
    { type: "retry" },
  ];

  let snapshot = initialConnection(DEFAULT_POLICY, 0);
  const seen: Array<string> = [];

  for (const step of steps) {
    snapshot = connectionMachine.transition(snapshot, step)[0];
    seen.push(`${connectionStateOf(snapshot)}:${snapshot.context.delay}`);
  }

  return expectEqual(seen, [
    "reconnecting:500",
    "connected:null",
    "reconnecting:0",
    "needs-attention:null",
    "reconnecting:null",
  ]);
});

type Item = Data.TaggedEnum<{
  Snapshot: { readonly sequence: number };
  Event: { readonly sequence: number };
}>;

const { Snapshot, Event, $match } = Data.taggedEnum<Item>();

const mark = $match({
  Snapshot: (item): SequenceMark => ({ kind: "snapshot", sequence: item.sequence }),
  Event: (item): SequenceMark => ({ kind: "event", sequence: item.sequence }),
});

class Dropped extends Data.TaggedError("Dropped") {}

const resumeCheck = Effect.scoped(
  Effect.gen(function* () {
    // Each connection replays an event the last one already sent, then drops.
    const scripts: Array<Array<Item>> = [
      [Snapshot({ sequence: 0 }), Event({ sequence: 1 }), Event({ sequence: 2 })],
      [Event({ sequence: 2 }), Event({ sequence: 3 })],
    ];

    const opens: Array<number | null> = [];
    let epoch = 0;

    const feed = yield* makeFeed<number, Item, Dropped>({
      source: { next: (min) => Effect.succeed({ epoch: Math.max(min, epoch), client: 0 }) },
      open: (_client, after) => {
        opens.push(after);
        const script = scripts[epoch++];

        if (script === undefined) return Stream.never;

        return Stream.concat(Stream.fromIterable(script), Stream.fail(new Dropped()));
      },
      mark,
      isDisconnect: (error) => error instanceof Dropped,
      gapless: true,
    });

    const items = yield* feed.stream.pipe(Stream.take(4), Stream.runCollect);

    return expectEqual(
      { items: items.map((item) => `${item._tag}:${item.sequence}`), opens: opens.slice(0, 2) },
      { items: ["Snapshot:0", "Event:1", "Event:2", "Event:3"], opens: [null, 2] }
    );
  })
);

// marked and remend build their Unicode and lookbehind patterns at run time, so only a run proves them.
const markdownCheck = Effect.sync(() => {
  const streaming = parseAfter(null, "# Plan\n\n- **bo");

  const parsed = parseAfter(
    streaming,
    "# Plan\n\n- **bold** and ~~gone~~ [docs](https://x.dev) 20~25\n\n```ts\nlet a"
  );

  return expectEqual(lineOf(parsed.blocks), [
    { text: "Plan", marks: ["strong"], href: null },
    { text: "\n", marks: [], href: null },
    { text: "• ", marks: [], href: null },
    { text: "bold", marks: ["strong"], href: null },
    { text: " and ", marks: [], href: null },
    { text: "gone", marks: ["del"], href: null },
    { text: " ", marks: [], href: null },
    { text: "docs", marks: [], href: "https://x.dev" },
    { text: " 20~25", marks: [], href: null },
    { text: "\n", marks: [], href: null },
    { text: "let a", marks: ["code"], href: null },
  ]);
});

// The diff's token emphasis: syntax-diff's core over the light tokenizer's run-time patterns.
const diffCheck = Effect.sync(() => {
  const rows = alignChange(
    ["  const body = await req.text(); // café", "fn(a)"],
    ["  const body = await req.arrayBuffer(); // café", "fn(a, b)"],
    "upload.ts"
  );

  return expectEqual(
    rows.map((row) => [row.kind, row.removed, row.added]),
    [
      ["modified", [{ start: 25, end: 29 }], [{ start: 25, end: 36 }]],
      ["inserted", [], [{ start: 4, end: 7 }]],
    ]
  );
});

// Self-Traces: a traced Effect's Span, its ids, the buffer's byte count and a valid batch.
const selfTraceCheck = Effect.gen(function* () {
  const sent: Array<Batch> = [];

  const tracer = openSelfTracer({
    now: () => 1_000,
    random: Math.random,
    every: () => () => undefined,
  });

  tracer.setTarget({
    hostId: "h",
    send: (batch) => {
      sent.push(batch);

      return Promise.resolve("sent");
    },
  });
  yield* tracer.traced("check", { "polaris.check": "é" }, Effect.sleep("1 millis"));
  yield* Effect.promise(() => tracer.flush());
  const spans = sent[0]?.spans ?? [];
  const parent = readTraceContext(() => `00-${spans[0]?.traceId}-${spans[0]?.id}-01`);

  return expectEqual(
    {
      valid: sent.every(Schema.is(SelfTraceBatch)),
      names: spans.map((span) => span.name),
      parent: parent !== null,
    },
    { valid: true, names: ["check"], parent: true }
  );
});

const CHECKS: ReadonlyArray<readonly [string, Effect.Effect<string | null, unknown>]> = [
  ["effect", effectCheck],
  ["frame codec", frameCheck],
  ["connection machine", machineCheck],
  ["resume", resumeCheck],
  ["markdown", markdownCheck],
  ["diff", diffCheck],
  ["self-traces", selfTraceCheck],
];

const runOne = ([name, check]: (typeof CHECKS)[number]) =>
  check.pipe(
    Effect.timeout("5 seconds"),
    Effect.match({
      onFailure: (error): CheckResult => ({ name, ok: false, detail: String(error) }),
      onSuccess: (mismatch): CheckResult => ({
        name,
        ok: mismatch === null,
        detail: mismatch ?? "ok",
      }),
    }),
    Effect.catchDefect((defect) => Effect.succeed({ name, ok: false, detail: String(defect) }))
  );

/** Runs every check; never rejects, so a broken engine shows which part failed. */
export const runSelfCheck = (): Promise<ReadonlyArray<CheckResult>> =>
  Effect.runPromise(Effect.forEach(CHECKS, runOne));
