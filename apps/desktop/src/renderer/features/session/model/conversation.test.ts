import { describe, expect, test } from "bun:test";
import { SessionId, Subagent, SubagentId, TurnId, TurnItem } from "@polaris/protocol";
import { approval, turnWith } from "../../../store/fixtures.testing.ts";
import type { LiveItem, SubagentView, TurnView } from "../../../store/sessionModel.ts";
import {
  conversationRows,
  groupRows,
  latestTurnOpen,
  noFolds,
  summarize,
  turnReceipt,
  turnStartRow,
  turnTime,
} from "./conversation.ts";
import { completedItemView, liveItemView, outputTail, toolSummary } from "./items.ts";
import { queuedOutgoing } from "./outbox.ts";
import type { TurnGroup } from "./turnGroups.ts";

const I = TurnItem.cases;

const view = (
  index: number,
  items: ReadonlyArray<TurnItem>,
  live: ReadonlyMap<string, LiveItem> = new Map(),
  status: "working" | "completed" | "interrupted" | "failed" = "completed"
): TurnView => ({
  turn: turnWith({ id: TurnId.make(`t${index}`), index, prompt: `prompt ${index}`, status }),
  items,
  live,
  subagents: [],
});

/** A user Turn shown on its own, as `groupTurns` makes it when no Harness-started Turn follows. */
const solo = (v: TurnView): TurnGroup => ({ id: v.turn.id, number: v.turn.index + 1, views: [v] });

const turnRows = (v: TurnView, expanded: boolean, isLast: boolean) =>
  groupRows(solo(v), expanded, isLast, isLast ? v.turn.id : null);

const message = (id: string, text: string) => I.AssistantMessage.make({ id, text });

const files = (id: string, paths: ReadonlyArray<string>) =>
  I.FileChange.make({
    id,
    changes: paths.map((path) => ({ path, kind: "modify" as const })),
    status: "completed",
  });

describe("items", () => {
  test("a completed item keeps its view's identity", () => {
    const item = message("m1", "hello");

    expect(completedItemView(item)).toBe(completedItemView(item));
  });

  test("streamed text overrides the progress snapshot", () => {
    const progress = I.CommandExecution.make({
      id: "c1",
      command: "bun test",
      cwd: "/r",
      output: "",
      exitCode: null,
      status: "running",
    });

    expect(liveItemView("c1", { item: progress, text: "", output: "pass 3\n" })).toMatchObject({
      kind: "command",
      command: "bun test",
      output: "pass 3\n",
      live: true,
    });
  });

  test("an item with only output deltas is a running command", () => {
    expect(liveItemView("x", { item: null, text: "", output: "…" }).kind).toBe("command");
    expect(liveItemView("y", { item: null, text: "Hi", output: "" }).kind).toBe("message");
  });

  test("output keeps its tail", () => {
    expect(outputTail("a\nb\nc\nd\n", 2)).toEqual({ text: "c\nd", hidden: 2 });
    expect(outputTail("a\nb", 5)).toEqual({ text: "a\nb", hidden: 0 });
  });

  test("tool input on one line", () => {
    expect(toolSummary({ path: "src/index.ts" })).toBe("src/index.ts");
    expect(toolSummary({ file_path: "a.ts", limit: 20 })).toBe("a.ts");
    expect(toolSummary({ command: "bun test", timeout: 5 })).toBe("bun test");
    expect(toolSummary({ n: 1 })).toBe('{"n":1}');
    expect(toolSummary("x".repeat(300)).length).toBe(160);
    expect(toolSummary(null)).toBe("");
  });
});

describe("conversation rows", () => {
  const earlier = view(0, [message("m0", "Recorded the decision\nmore"), files("f0", ["a", "b"])]);
  const last = view(1, [message("m1", "done")], new Map(), "working");

  test("earlier Turns fold to one summary; the last stays open", () => {
    const rows = conversationRows({ turns: [earlier, last], approvals: [] });

    expect(rows.map((r) => r.kind)).toEqual(["summary", "prompt", "item"]);
    expect(rows[0]).toMatchObject({ number: 1, summary: "Recorded the decision", files: 2 });
  });

  test("a Turn the user opened expands", () => {
    const rows = conversationRows({
      turns: [earlier, last],
      approvals: [],
      folds: { chosen: new Map([["t0", true]]), openFrom: null },
    });

    expect(rows.map((r) => r.kind)).toEqual(["prompt", "item", "item", "prompt", "item"]);
    expect(rows.filter((r) => r.kind === "item").map((r) => r.lead)).toEqual([true, false, true]);
    expect(rows.filter((r) => r.kind === "item").map((r) => r.latest)).toEqual([
      false,
      false,
      true,
    ]);
  });

  test("a new Turn never folds the Turn being read", () => {
    const shown = { chosen: new Map(), openFrom: "t0" };
    const reading = view(0, [message("m0", "Here is the plan")]);
    const next = view(1, [], new Map(), "working");

    expect(
      conversationRows({ turns: [reading], approvals: [], folds: shown }).map((r) => r.kind)
    ).toEqual(["prompt", "item"]);
    expect(
      conversationRows({ turns: [reading, next], approvals: [], folds: shown }).map((r) => r.kind)
    ).toEqual(["prompt", "item", "prompt"]);
  });

  test("a digest Turn arriving keeps the Lead's earlier reply open", () => {
    const shown = { chosen: new Map(), openFrom: "t1" };

    const turns = [
      view(0, [message("m0", "old")]),
      view(1, [message("m1", "Dispatched three workers")]),
      view(2, [message("m2", "Noted F1's report")]),
      view(3, [], new Map(), "working"),
    ];

    const rows = conversationRows({ turns, approvals: [], folds: shown });

    expect(rows.map((r) => r.kind)).toEqual([
      "summary",
      "prompt",
      "item",
      "prompt",
      "item",
      "prompt",
    ]);
  });

  test("a Turn the user folded stays folded, even the latest", () => {
    const folds = { chosen: new Map([["t1", false]]), openFrom: "t0" };
    const turns = [view(0, [message("m0", "a")]), view(1, [message("m1", "b")])];

    expect(conversationRows({ turns, approvals: [], folds }).map((r) => r.kind)).toEqual([
      "prompt",
      "item",
      "summary",
    ]);
    expect(latestTurnOpen(turns, folds)).toBe(false);
    expect(latestTurnOpen(turns, noFolds)).toBe(true);
  });

  test("a running command stays where it began, above a reply that started later", () => {
    const running = I.CommandExecution.make({
      id: "c1",
      command: "sleep 20",
      cwd: "/r",
      output: "",
      exitCode: null,
      status: "running",
      startedAt: "2026-10-11T20:00:01.000Z",
    });

    const read = I.ToolCall.make({
      id: "r1",
      name: "Read",
      input: { file_path: "a.ts" },
      output: null,
      status: "completed",
      startedAt: "2026-10-11T20:00:02.000Z",
    });

    const reply = I.AssistantMessage.make({
      id: "m1",
      text: "Read a.ts while it runs",
      startedAt: "2026-10-11T20:00:03.000Z",
    });

    const live = new Map([["c1", { item: running, text: "", output: "" }]]);
    const rows = turnRows(view(0, [read, reply], live, "working"), true, true);
    const items = rows.flatMap((r) => (r.kind === "item" && r.entry.kind === "item" ? [r] : []));

    expect(items.map((r) => r.entry.kind === "item" && r.entry.item.id)).toEqual([
      "c1",
      "r1",
      "m1",
    ]);
    expect(items.map((r) => r.startedAt)).toEqual([
      "2026-10-11T20:00:01.000Z",
      "2026-10-11T20:00:02.000Z",
      "2026-10-11T20:00:03.000Z",
    ]);
  });

  test("items with no start keep completion order, live text last", () => {
    const live = new Map([["m2", { item: null, text: "still typing", output: "" }]]);

    const rows = turnRows(
      view(0, [message("m0", "a"), message("m1", "b")], live, "working"),
      true,
      true
    );

    expect(
      rows.flatMap((r) => (r.kind === "item" && r.entry.kind === "item" ? [r.entry.item.id] : []))
    ).toEqual(["m0", "m1", "m2"]);
  });

  test("a Turn's start row by id", () => {
    const rows = conversationRows({ turns: [earlier, last], approvals: [] });

    expect(turnStartRow(rows, "t0")).toBe(0);
    expect(turnStartRow(rows, "t1")).toBe(1);
    expect(turnStartRow(rows, "nope")).toBe(-1);
  });

  test("a Turn's time reads as a clock today, with the date before", () => {
    const now = new Date(2026, 9, 11, 16, 30);

    expect(turnTime(new Date(2026, 9, 11, 9, 5).toISOString(), now)).toBe("09:05");
    expect(turnTime(new Date(2026, 8, 20, 14, 2).toISOString(), now)).toBe("Sep 20 14:02");
    expect(turnTime(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe("Dec 31, 2025 23:59");
    expect(turnTime("not a time", now)).toBe("");
  });

  test("a finished Turn's receipt counts files and commands and how long it took", () => {
    const run = (id: string) =>
      I.CommandExecution.make({
        id,
        command: "bun test",
        cwd: "/r",
        output: "",
        exitCode: 0,
        status: "completed",
      });

    const done = view(3, [
      files("f1", ["a.ts", "b.ts"]),
      files("f2", ["a.ts"]),
      run("c1"),
      run("c2"),
    ]);

    const timed: TurnView = {
      ...done,
      turn: turnWith({
        id: done.turn.id,
        index: done.turn.index,
        prompt: done.turn.prompt,
        startedAt: "2026-10-28T14:00:00.000Z",
        endedAt: "2026-10-28T14:01:41.000Z",
      }),
    };

    expect(turnReceipt(summarize(solo(timed)))).toBe("2 files · 2 commands · 1m 41s");
    expect(turnReceipt(summarize(solo(view(4, [message("m1", "Looked")]))))).toBe("");
  });

  test("a huge Turn's receipt groups its thousands", () => {
    const many = Array.from({ length: 1_284 }, (_, i) => `m${i}.ts`);

    expect(turnReceipt(summarize(solo(view(5, [files("f1", many)]))))).toBe("1,284 files");
  });

  test("a summary falls back to the prompt", () => {
    expect(summarize(solo(view(2, []))).summary).toBe("prompt 2");
  });

  test("live items follow completed ones", () => {
    const live = new Map([["m2", { item: null, text: "stream", output: "" }]]);
    const rows = turnRows(view(1, [message("m1", "a")], live, "working"), true, true);

    expect(
      rows.map((r) =>
        r.kind === "item" && r.entry.kind === "item" ? [r.entry.item.id, r.entry.item.live] : r.kind
      )
    ).toEqual(["prompt", ["m1", false], ["m2", true]]);
  });

  test("rows are cached per Turn view and fold state", () => {
    const v = view(0, [message("m0", "x")]);
    const open = turnRows(v, true, false);

    expect(turnRows(v, true, false).every((row, n) => row === open[n])).toBe(true);
    const [summary] = turnRows(v, false, false);

    expect(turnRows(v, false, false)[0] === summary).toBe(true);
    expect(summary?.kind).toBe("summary");
  });

  test("approvals follow the Turn that asked", () => {
    const asking = view(0, [], new Map(), "working");
    const rows = conversationRows({ turns: [asking], approvals: [approval] });

    expect(rows.map((r) => r.kind)).toEqual(["prompt", "approval"]);
  });

  test("an approval for a Turn not loaded closes the list", () => {
    const rows = conversationRows({ turns: [], approvals: [approval] });

    expect(rows.map((r) => r.kind)).toEqual(["approval"]);
  });

  test("an interrupted last Turn offers Continue; an earlier one doesn't", () => {
    const interrupted = view(0, [], new Map(), "interrupted");
    const rows = turnRows(interrupted, true, true);

    expect(rows.at(-1)).toMatchObject({ kind: "ending", canContinue: true });
    expect(turnRows(view(0, [], new Map(), "interrupted"), true, false).at(-1)).toMatchObject({
      kind: "ending",
      canContinue: false,
    });
    expect(turnRows(view(0, [], new Map(), "completed"), true, true).at(-1)?.kind).toBe("prompt");
  });

  test("a failed last Turn offers Retry; an earlier one doesn't", () => {
    expect(turnRows(view(0, [], new Map(), "failed"), true, true).at(-1)).toMatchObject({
      kind: "ending",
      canContinue: false,
      canRetry: true,
    });
    expect(turnRows(view(0, [], new Map(), "failed"), true, false).at(-1)).toMatchObject({
      canRetry: false,
    });
  });
});

describe("steers in the conversation", () => {
  test("a landed steer is its own row; the next agent item carries the avatar again", () => {
    const rows = turnRows(
      view(0, [
        message("m1", "a"),
        I.UserMessage.make({ id: "u1", text: "b" }),
        message("m2", "c"),
      ]),
      true,
      true
    ).filter((r) => r.kind === "item");

    expect(
      rows.map((r) => [
        r.kind === "item" && r.entry.kind === "item" ? r.entry.item.kind : "",
        r.lead,
      ])
    ).toEqual([
      ["message", true],
      ["user", false],
      ["message", true],
    ]);
  });

  test("outgoing messages close the list", () => {
    const entry = queuedOutgoing("next", []);
    const outbox = [entry];

    const rows = conversationRows({
      turns: [view(0, [])],
      approvals: [],
      outbox,
    });

    expect(rows.at(-1)).toMatchObject({ kind: "outgoing", key: `outgoing:${entry.id}`, entry });
  });
});

/** An entry's item id, or its kind for a run. */
const entryId = (entry: { readonly kind: string; readonly item?: { readonly id: string } }) =>
  entry.item?.id ?? entry.kind;

describe("subagents and tool runs in the conversation", () => {
  const agent = I.ToolCall.make({
    id: "toolu_agent",
    name: "Agent",
    input: { description: "Explore" },
    output: null,
    status: "completed",
  });

  const sub = (
    id: string,
    parent: string | null,
    status: "completed" | "interrupted" = "completed"
  ): SubagentView => ({
    subagent: new Subagent({
      id: SubagentId.make(id),
      sessionId: SessionId.make("s1"),
      turnId: TurnId.make("t0"),
      parentItemId: parent,
      title: "Explore",
      agent: null,
      model: null,
      status,
      startedAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T00:00:05.000Z",
    }),
    items: [message(`${id}-m`, "found it")],
    live: new Map(),
  });

  test("a Subagent takes its Agent call's place; one without a call closes the Turn", () => {
    const turn = {
      ...view(0, [message("m1", "a"), agent, message("m2", "b")]),
      subagents: [sub("toolu_agent", "toolu_agent"), sub("bg", null)],
    };

    const rows = turnRows(turn, true, true).flatMap((r) =>
      r.kind === "item"
        ? [r.entry.kind === "subagent" ? `subagent:${r.entry.card.id}` : r.entry.kind]
        : []
    );

    expect(rows).toEqual(["item", "subagent:toolu_agent", "item", "subagent:bg"]);
  });

  test.each(["completed", "interrupted"] as const)(
    "a %s Codex Subagent sits at its spawn, before the final messages",
    (status) => {
      const spawn = I.ToolCall.make({
        id: "call_spawn",
        name: "agent.spawn",
        input: { agent: "/root/spec_review" },
        output: null,
        status: "completed",
      });

      const turn = {
        ...view(0, [
          message("m0", "Reviewing"),
          spawn,
          message("m1", "I found no regression."),
          message("m2", '{"findings":[]}'),
        ]),
        subagents: [sub("child", "call_spawn", status)],
      };

      const rows = turnRows(turn, true, true).flatMap((r) =>
        r.kind === "item"
          ? [r.entry.kind === "subagent" ? `subagent:${r.entry.card.id}` : entryId(r.entry)]
          : []
      );

      expect(rows).toEqual(["m0", "subagent:child", "m1", "m2"]);
    }
  );
});

describe("sources", () => {
  const fetchCall = (id: string, url: string) =>
    I.ToolCall.make({
      id,
      name: "WebFetch",
      kind: "fetch",
      input: { url, prompt: "read" },
      output: null,
      status: "completed",
    });

  const itemRowsOf = (items: ReadonlyArray<TurnItem>) =>
    turnRows(view(0, items), true, true).flatMap((row) => (row.kind === "item" ? [row] : []));

  test("a Turn's sources sit on its first agent row, across from the avatar, not in the flow", () => {
    const rows = itemRowsOf([
      message("m0", "Looking"),
      fetchCall("f1", "https://bun.sh/docs"),
      fetchCall("f2", "https://effect.website/docs"),
      message("m1", "Done."),
    ]);

    expect(rows.map((row) => row.entry.kind)).toEqual(["item", "item"]);
    expect(rows.map((row) => row.sources?.length ?? 0)).toEqual([2, 0]);
  });

  test("a Turn of only sources keeps the pill as its row", () => {
    const rows = itemRowsOf([fetchCall("f1", "https://bun.sh/docs")]);

    expect(rows.map((row) => [row.entry.kind, row.sources])).toEqual([["sources", undefined]]);
  });
});
