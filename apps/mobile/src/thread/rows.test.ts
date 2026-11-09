import { describe, expect, test } from "bun:test";
import { Attachment, AttachmentId, DomainEvent, SessionId, TurnItem } from "@polaris/protocol";
import { applySessionItem, type SessionFold } from "./fold.ts";
import {
  headerLine,
  newestEndedOnScreen,
  outgoingRows,
  threadRows,
  type ThreadRow,
  turnHeading,
} from "./rows.ts";
import { event, snapshot, turn } from "./daemon.testing.ts";
import { SessionStreamItem, TurnId } from "@polaris/protocol";

const edit = (id: string, path: string, status: "running" | "completed" = "completed") =>
  TurnItem.cases.FileChange.make({ id, changes: [{ path, kind: "modify" }], status });

const reply = (id: string, text: string) => TurnItem.cases.AssistantMessage.make({ id, text });

const read = (id: string, title: string) =>
  TurnItem.cases.ToolCall.make({
    id,
    name: "Read",
    title,
    input: {},
    output: null,
    status: "completed",
  });

type Status = "running" | "completed" | "failed" | "declined";

type ToolInput = Extract<TurnItem, { _tag: "ToolCall" }>["input"];

const KINDS = new Map<string, "read" | "search">([
  ["Read", "read"],
  ["Grep", "search"],
]);

/** A Claude Code call as its driver classifies it. */
const call = (id: string, name: string, input: ToolInput, status: Status = "completed") =>
  TurnItem.cases.ToolCall.make({
    id,
    name,
    kind: KINDS.get(name) ?? null,
    input,
    output: null,
    status,
  });

const paper = (id: string) =>
  TurnItem.cases.ToolCall.make({
    id,
    name: "mcp__paper__write_html",
    kind: "mcp",
    mcp: { server: "paper", tool: "write_html" },
    input: {},
    output: null,
    status: "completed",
  });

const command = (id: string, line: string, exitCode: number, status: Status = "completed") =>
  TurnItem.cases.CommandExecution.make({
    id,
    command: line,
    cwd: "/repo",
    output: "",
    exitCode,
    status,
  });

/** The latest Turn, working, with `items`. */
const working = (items: ReadonlyArray<TurnItem>) =>
  snapshot([{ turn: turn(0, { prompt: "", status: "working", endedAt: null }), items }]);

/** A row as a line: steps with their index, active mark and group end ("|"). */
const line = (row: ThreadRow): string => {
  switch (row.kind) {
    case "step":
      return `${row.index} ${row.label}${row.tone === "active" ? " (active)" : ""}${row.last ? " |" : ""}`;
    case "run":
      return `run: ${row.summary}${row.open ? " (open)" : ""}${row.last ? " |" : ""}`;
    case "visualization":
      return `visualization: ${row.visualization.title}`;
    default:
      return `${row.kind}: ${row.text}`;
  }
};

const foldOf = (items: ReadonlyArray<SessionStreamItem>) =>
  items.reduce<SessionFold | null>(applySessionItem, null);

describe("thread rows", () => {
  test("every Turn shows its prompt, replies and numbered steps, oldest first", () => {
    const fold = foldOf([
      snapshot([
        {
          turn: turn(0, { replyPreview: "Recorded the Review decision" }),
          items: [reply("a", "done")],
        },
        {
          turn: turn(1, { prompt: "Prototype the layouts", status: "working", endedAt: null }),
          items: [
            reply("b", "I'll build four variants."),
            read("c", "Read the Orchestrator notes"),
            edit("d", "src/index.html"),
            edit("e", "src/serve.ts", "running"),
            reply("f", "Variant 3 is the dense table."),
          ],
        },
      ]),
    ]);

    const rows = threadRows(fold?.turns ?? [], new Set());

    expect(rows.map(line)).toEqual([
      "prompt: prompt 0",
      "reply: done",
      "prompt: Prototype the layouts",
      "reply: I'll build four variants.",
      "run: Read 1 file, edited 1 file",
      "03 Writing serve.ts (active) |",
      "reply: Variant 3 is the dense table.",
    ]);
  });

  test("a message's images stay with it: in its Turn's prompt, and while it's queued", () => {
    const shot = new Attachment({
      id: AttachmentId.make("att-1"),
      name: "shot.png",
      mimeType: "image/png",
      size: 10,
      hostPath: "/staging/att-1/shot.png",
      width: 4,
      height: 3,
    });

    const fold = foldOf([snapshot([{ turn: turn(0, { prompt: "", attachments: [shot] }) }])]);
    const [prompt] = threadRows(fold?.turns ?? [], new Set());
    const [queued] = outgoingRows([], [{ text: "and this one", attachments: [shot] }]);

    expect(prompt?.kind === "prompt" && prompt.attachments).toEqual([shot]);
    expect(queued?.kind === "outgoing" && [queued.note, queued.attachments]).toEqual([
      "Queued for after this turn",
      [shot],
    ]);
  });

  test("a long transcript: streaming into the latest Turn rebuilds only its rows", () => {
    const turns = Array.from({ length: 1000 }, (_, index) => ({
      turn: turn(index, { status: index === 999 ? "working" : "completed" }),
      items: Array.from({ length: 30 }, (_, n) => edit(`i${index}-${n}`, `f${n}.ts`)),
    }));

    const before = foldOf([snapshot(turns)]);
    const rowsBefore = threadRows(before?.turns ?? [], new Set());

    // Each Turn: its prompt, its 30 edits as one run, and its receipt once finished.
    expect(rowsBefore.length).toBe(1000 * 3 - 1);

    const after = applySessionItem(
      before,
      SessionStreamItem.cases.Delta.make({
        turnId: TurnId.make("t-999"),
        itemId: "live",
        field: "text",
        text: "Still going",
        subagentId: null,
      })
    );

    const rowsAfter = threadRows(after?.turns ?? [], new Set());

    expect(rowsAfter.at(-1)).toMatchObject({ kind: "reply", text: "Still going" });
    expect(rowsAfter[0]).toBe(rowsBefore[0]);
    expect(rowsAfter[2996]).toBe(rowsBefore[2996]);
  });
});

describe("tool runs, as the Desktop App folds them", () => {
  test("finished calls in a row fold into one run in its words, and open to their numbered steps", () => {
    const fold = foldOf([
      working([
        call("a", "Read", { file_path: "/repo/src/serve.ts" }),
        call("b", "Grep", { pattern: "subscribeSession" }),
        command("c", "bun test", 0),
        edit("d", "src/a.ts"),
        edit("e", "src/a.ts"),
        paper("f"),
        paper("g"),
        reply("h", "Done."),
      ]),
    ]);

    const folded = threadRows(fold?.turns ?? [], new Set()).map(line);

    expect(folded).toEqual([
      "run: Read 1 file, searched for 1 pattern, edited 1 file, ran 1 command, called Paper 2 times |",
      "reply: Done.",
    ]);

    const opened = threadRows(fold?.turns ?? [], new Set(["t-0:run:a"])).map(line);

    expect(opened).toEqual([
      "run: Read 1 file, searched for 1 pattern, edited 1 file, ran 1 command, called Paper 2 times (open)",
      "01 Read serve.ts",
      "02 Searched subscribeSession",
      "03 bun test",
      "04 Edited a.ts",
      "05 Edited a.ts",
      "06 Called Paper write html",
      "07 Called Paper write html |",
      "reply: Done.",
    ]);
  });

  test("a running, failed or declined call, or any other kind, keeps its row; a lone call is never folded", () => {
    const fold = foldOf([
      working([
        call("a", "Read", { file_path: "a.ts" }),
        command("b", "bun test", 1, "failed"),
        call("c", "Read", { file_path: "b.ts" }),
        call("d", "TodoWrite", {}),
        call("e", "Read", { file_path: "c.ts" }, "declined"),
        call("f", "Read", { file_path: "d.ts" }, "running"),
      ]),
    ]);

    expect(threadRows(fold?.turns ?? [], new Set()).map(line)).toEqual([
      "01 Read a.ts",
      "02 bun test",
      "03 Read b.ts",
      "04 TodoWrite",
      "05 Read c.ts",
      "06 Reading d.ts (active) |",
    ]);
  });

  test("a call in flight shows as it runs, then folds into the run once it finishes", () => {
    const turnId = TurnId.make("t-0");
    const running = call("b", "Grep", { pattern: "TODO" }, "running");
    const start = foldOf([working([call("a", "Read", { file_path: "a.ts" })])]);

    const inFlight = applySessionItem(
      start,
      SessionStreamItem.cases.ItemProgress.make({ turnId, item: running, subagentId: null })
    );

    expect(threadRows(inFlight?.turns ?? [], new Set()).map(line)).toEqual([
      "01 Read a.ts",
      "02 Searching TODO (active) |",
    ]);

    const done = applySessionItem(
      inFlight,
      event(
        2,
        DomainEvent.cases.TurnItemCompleted.make({
          sessionId: SessionId.make("s-1"),
          turnId,
          item: call("b", "Grep", { pattern: "TODO" }),
          subagentId: null,
        })
      )
    );

    expect(threadRows(done?.turns ?? [], new Set()).map(line)).toEqual([
      "run: Read 1 file, searched for 1 pattern |",
    ]);
  });
});

describe("read position", () => {
  test("the newest ended Turn on screen, never a working one", () => {
    const fold = foldOf([
      snapshot([
        { turn: turn(0) },
        { turn: turn(1) },
        { turn: turn(2, { status: "working", endedAt: null }) },
      ]),
    ]);

    expect(newestEndedOnScreen(fold?.turns ?? [], ["t-0", "t-1", "t-2"])?.turn.index).toBe(1);
    expect(newestEndedOnScreen(fold?.turns ?? [], ["t-2"])).toBeNull();
  });
});

describe("a finished turn's receipt (MX-E)", () => {
  const finished = (items: ReadonlyArray<TurnItem>, fields: Parameters<typeof turn>[1] = {}) =>
    threadRows(
      foldOf([
        snapshot([
          {
            turn: turn(0, {
              startedAt: "2026-10-27T12:00:00.000Z",
              endedAt: "2026-10-27T12:01:41.000Z",
              ...fields,
            }),
            items,
          },
        ]),
      ])?.turns ?? [],
      new Set()
    );

  test("sits under the turn's last reply: each file once, its commands, how long it took", () => {
    const rows = finished([
      reply("a", "Looking at the planning page."),
      edit("b", "src/planning.tsx"),
      edit("c", "src/planning.tsx"),
      edit("d", "src/hosts.tsx"),
      command("e", "bun run build", 0),
      command("f", "bun test", 0),
      reply("g", "Split the planning page into three sections."),
    ]);

    expect(rows.flatMap((row) => (row.kind === "reply" ? [row.receipt] : []))).toEqual([
      null,
      "2 files · 2 commands · 1m 41s",
    ]);
  });

  test("leaves out what the turn didn't do, and stands alone when no reply ends the turn", () => {
    const rows = finished([read("a", "Read the README")], {
      endedAt: "2026-10-27T12:00:12.000Z",
    });

    expect(rows.at(-1)).toMatchObject({ kind: "receipt", text: "12s" });
  });

  test("a completed turn with no prompt and nothing back shows no receipt to long-press", () => {
    expect(finished([], { prompt: "" })).toEqual([]);
  });

  test("a stopped turn with nothing back still says it stopped", () => {
    expect(finished([], { prompt: "", status: "interrupted" }).at(-1)).toMatchObject({
      kind: "receipt",
      text: "Stopped · 1m 41s",
    });
  });

  test("a working turn has none, and its replies offer no menu yet", () => {
    const rows = threadRows(
      foldOf([working([reply("a", "Still going"), command("b", "bun test", 0)])])?.turns ?? [],
      new Set()
    );

    expect(rows.map((row) => row.kind)).not.toContain("receipt");
    expect(rows.find((row) => row.kind === "reply")).toMatchObject({ turn: null, receipt: null });
  });

  test("copy takes every reply of the turn as Markdown, a blank line apart", () => {
    const rows = finished([reply("a", "First, **this**."), reply("b", "Then that.\n")], {
      userTurnNumber: 23,
    });

    expect(rows.find((row) => row.kind === "reply")).toMatchObject({
      turn: { number: 23, output: "First, **this**.\n\nThen that." },
    });
  });

  test("a group of steps opens and closes one well", () => {
    const rows = finished([
      reply("a", "Reading first."),
      edit("b", "src/a.ts", "running"),
      command("c", "bun test", 1, "failed"),
      reply("d", "Done."),
    ]);

    expect(rows.flatMap((row) => (row.kind === "step" ? [[row.first, row.last]] : []))).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  test("ends the turn after the steps and error that follow its last reply, saying it failed", () => {
    const rows = finished(
      [
        reply("a", "Running the integration suite now."),
        command("b", "bun test", 137, "failed"),
        TurnItem.cases.Error.make({ id: "c", message: "Claude Code exited with code 137" }),
      ],
      { status: "failed" }
    );

    expect(rows.map(line).slice(1)).toEqual([
      "reply: Running the integration suite now.",
      "01 bun test |",
      "error: Claude Code exited with code 137",
      "receipt: Failed · 1 command · 1m 41s",
    ]);
  });

  test("a stopped turn says so, and leaves no step working: its plan done, its command stopped", () => {
    const plan = TurnItem.cases.Plan.make({
      id: "b",
      steps: [
        { text: "Read", status: "completed", detail: null },
        { text: "Backfill", status: "in-progress", detail: null },
      ],
      explanation: null,
    });

    const rows = finished(
      [reply("a", "Backfilling."), plan, command("c", "bun run backfill", 0, "running")],
      { status: "interrupted" }
    );

    expect(
      rows.flatMap((row) => (row.kind === "step" ? [[row.label, row.tone, row.detail]] : []))
    ).toEqual([
      ["Updated the plan", "done", "1 of 2"],
      ["bun run backfill", "failed", "stopped"],
    ]);
    expect(rows.at(-1)).toMatchObject({ kind: "receipt", text: "Stopped · 1 command · 1m 41s" });
  });

  test("groups thousands in its counts", () => {
    const paths = Array.from({ length: 1284 }, (_, n) => `invoice-${n}.json`);

    const bulk = TurnItem.cases.FileChange.make({
      id: "a",
      changes: paths.map((path) => ({ path, kind: "modify" as const })),
      status: "completed",
    });

    expect(finished([bulk, reply("b", "Backfilled.")]).at(-1)).toMatchObject({
      receipt: "1,284 files · 1m 41s",
    });
  });
});

describe("the thread header", () => {
  test("says the state, then the turn and where it runs", () => {
    expect(
      headerLine({ state: "working", turnCount: 24, currentUserTurn: null }, "polaris")
    ).toEqual({ state: "Working", rest: "turn 24 · polaris" });
    expect(headerLine({ state: "idle", turnCount: 0, currentUserTurn: null }, null)).toEqual({
      state: "Idle",
      rest: "",
    });
  });

  test("while the host is away, the last known state says when it was known", () => {
    expect(
      headerLine({ state: "working", turnCount: 24, currentUserTurn: null }, "polaris", "11:42")
    ).toEqual({ state: "Working", rest: "as of 11:42 · turn 24 · polaris" });
  });

  test("a turn's menu heading names it and when it started, in the phone's time", () => {
    const startedAt = new Date(2026, 9, 27, 9, 5).toISOString();

    expect(turnHeading({ number: 23, startedAt })).toBe("Turn 23 · 09:05");
  });
});

describe("idle compaction's Turn in the thread", () => {
  const prompted = {
    turn: turn(0, { prompt: "Refactor the parser" }),
    items: [reply("a", "Split")],
  };

  const compaction = (status: "working" | "completed") => ({
    turn: turn(1, {
      prompt: "/compact",
      idleCompaction: true,
      status,
      endedAt: status === "working" ? null : "2026-10-29T00:00:12.000Z",
    }),
    items: [],
  });

  test.each([
    ["completed", "Compacted while idle, before the prompt cache expired"],
    ["working", "Compacting while idle, before the prompt cache expires"],
  ] as const)(
    "%s: a quiet line after the Turn before it, never the user's /compact",
    (status, text) => {
      const fold = foldOf([snapshot([prompted, compaction(status)])]);
      const rows = threadRows(fold?.turns ?? [], new Set());

      expect(rows.slice(-1).map(line)).toEqual([`quiet: ${text}`]);
      expect(rows.filter((row) => row.kind === "prompt").map(line)).toEqual([
        "prompt: Refactor the parser",
      ]);
    }
  );
});
