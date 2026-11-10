import { describe, expect, test } from "bun:test";
import { SessionStreamItem, TurnDetail, TurnItem } from "@polaris/protocol";
import { seq, session, turn, turnId } from "../../../store/fixtures.testing.ts";
import {
  applySessionItems,
  capOutput,
  emptySessionModel,
  LIVE_OUTPUT_CAP,
  type SessionModel,
} from "../../../store/sessionModel.ts";
import { liveItemView, lineCount, outputTail } from "./items.ts";

// The split-based tail and count the desktop used before ENG-903: what the scan must agree with.
const splitLines = (output: string) =>
  (output.endsWith("\n") ? output.slice(0, -1) : output).split("\n");

const splitTail = (output: string, lines: number) => {
  const all = splitLines(output);

  return all.length <= lines
    ? { text: all.join("\n"), hidden: 0 }
    : { text: all.slice(-lines).join("\n"), hidden: all.length - lines };
};

const numbered = (count: number, end = "\n") =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join(end) + end;

const OUTPUTS: ReadonlyArray<readonly [string, string]> = [
  ["empty", ""],
  ["a newline", "\n"],
  ["one line, no newline", "ok"],
  ["one line, a newline", "ok\n"],
  ["blank lines first", "\n\n\nlast"],
  ["blank lines last", "a\n\n\n"],
  ["CRLF", numbered(12, "\r\n")],
  ["CRLF, no final newline", numbered(12, "\r\n").slice(0, -2)],
  ["exactly 8 lines", numbered(8)],
  ["exactly 8 lines, no newline", numbered(8).slice(0, -1)],
  ["9 lines", numbered(9)],
  ["many lines", numbered(500)],
];

describe("command output tail and count (ENG-903)", () => {
  test.each(OUTPUTS)("%s: the scan agrees with splitting", (_, output) => {
    for (const lines of [1, 2, 8, 9, 600])
      expect(outputTail(output, lines)).toEqual(splitTail(output, lines));
    expect(lineCount(output)).toBe(splitLines(output).length);
  });
});

const S = SessionStreamItem.cases;

const running = TurnItem.cases.CommandExecution.make({
  id: "c1",
  command: "bun test",
  cwd: "/tmp",
  output: "",
  exitCode: null,
  status: "running",
});

const started: SessionModel = applySessionItems(emptySessionModel, [
  S.Snapshot.make({
    sequence: seq(1),
    session,
    turns: [new TurnDetail({ turn, items: [], subagents: [] })],
    pendingApprovals: [],
  }),
  S.ItemProgress.make({ turnId, item: running, subagentId: null }),
]);

/** `output` streamed in `chunk`-char deltas, cutting lines and CRLFs anywhere. */
const streamed = (output: string, chunk: number) => {
  const deltas = [];

  for (let at = 0; at < output.length; at += chunk)
    deltas.push(
      S.Delta.make({
        turnId,
        itemId: "c1",
        field: "output",
        text: output.slice(at, at + chunk),
        subagentId: null,
      })
    );
  const live = applySessionItems(started, deltas).turns[0]?.live.get("c1");

  if (live === undefined) throw new Error("no live command");

  return { live, view: liveItemView("c1", live) };
};

describe("live command output (ENG-903)", () => {
  test("under the cap, the live command shows what the split showed", () => {
    const output = numbered(40, "\r\n");
    const { live, view } = streamed(output, 7);

    expect(live.output).toBe(output);

    if (view.kind !== "command") throw new Error("not a command");
    expect(outputTail(view.output, 8, view.outputNewlines)).toEqual(splitTail(output, 8));
    expect(lineCount(view.output, view.outputNewlines)).toBe(40);
  });

  test("over the cap, it keeps whole lines from the end and still counts every line", () => {
    const output = numbered(40_000);
    const { live, view } = streamed(output, 4093);

    expect(output.length).toBeGreaterThan(LIVE_OUTPUT_CAP);
    expect(live.output.length).toBeLessThanOrEqual(LIVE_OUTPUT_CAP);
    expect(output.endsWith(live.output)).toBe(true);
    expect(live.output.startsWith("line ")).toBe(true);
    expect(output[output.length - live.output.length - 1]).toBe("\n");

    if (view.kind !== "command") throw new Error("not a command");
    expect(outputTail(view.output, 8, view.outputNewlines)).toEqual(splitTail(output, 8));
    expect(lineCount(view.output, view.outputNewlines)).toBe(40_000);
  });

  test("one line longer than the cap is cut mid-line rather than dropped", () => {
    const line = "x".repeat(LIVE_OUTPUT_CAP + 10);

    expect(capOutput(`${line}\n`)).toBe(`${line}\n`.slice(-LIVE_OUTPUT_CAP));
    expect(capOutput(`short\n${line}`)).toBe(line.slice(-LIVE_OUTPUT_CAP));
  });

  test("a capped tail too short for the lines asked still counts the dropped ones as hidden", () => {
    // Two lines kept of five: the cap dropped three.
    expect(outputTail("d\ne\n", 8, 5)).toEqual({ text: "d\ne", hidden: 3 });
  });
});
