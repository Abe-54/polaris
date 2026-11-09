import { describe, expect, test } from "bun:test";
import { SessionId, Subagent, SubagentId, TurnId, TurnItem } from "@polaris/protocol";
import { turnWith } from "../../../store/fixtures.testing.ts";
import type { SubagentView, TurnView } from "../../../store/sessionModel.ts";
import { findSubagent, resultText, subagentCard, subagentRoster } from "./subagents.ts";

const I = TurnItem.cases;

type ToolCallInput = Parameters<typeof I.ToolCall.make>[0]["input"];

const subagent = (
  status: "working" | "completed",
  report: string | null = null,
  id = "toolu_agent"
) =>
  new Subagent({
    id: SubagentId.make(id),
    sessionId: SessionId.make("s1"),
    turnId: TurnId.make("t1"),
    parentItemId: "toolu_agent",
    title: "List files and report back",
    agent: "general-purpose",
    model: null,
    status,
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: status === "working" ? null : "2026-10-01T00:00:12.000Z",
    report,
  });

const ls = I.CommandExecution.make({
  id: "c1",
  command: "ls -la",
  cwd: "/r",
  output: "",
  exitCode: 0,
  status: "completed",
});

const report = I.AssistantMessage.make({ id: "m1", text: "Empty directory. pong." });

const call = I.ToolCall.make({
  id: "toolu_agent",
  name: "Agent",
  input: { description: "List files", prompt: "List the files, then say pong." },
  output: { status: "completed", content: [{ type: "text", text: "From the call: pong." }] },
  status: "completed",
});

const view = (
  status: "working" | "completed",
  items: ReadonlyArray<TurnItem>,
  live: SubagentView["live"] = new Map()
): SubagentView => ({
  subagent: subagent(status),
  items,
  live,
});

describe("subagent cards", () => {
  test("a finished Subagent's last message is its report, kept apart from its transcript", () => {
    const card = subagentCard(view("completed", [ls, report]), call);

    expect(card.report).toBe(report.text);
    expect(card.task).toBe("List the files, then say pong.");
    expect(card.entries.map((e) => (e.kind === "item" ? e.item.id : e.kind))).toEqual(["c1"]);
    expect(card.activity).toBeNull();
  });

  test("with no message, the report is what its Agent call returned", () => {
    expect(subagentCard(view("completed", [ls]), call).report).toBe("From the call: pong.");
  });

  test("while it works: no report, and a line on what it is doing", () => {
    const live = new Map([
      [
        "c2",
        {
          item: I.CommandExecution.make({
            ...ls,
            id: "c2",
            command: "bun test",
            status: "running",
          }),
          text: "",
          output: "",
        },
      ],
    ]);

    const card = subagentCard(view("working", [ls, report], live), call);

    expect(card.report).toBeNull();
    expect(card.activity).toBe("Running bun test");
  });

  test("a Claude Code tool it is using reads as its verb, never the raw tool name", () => {
    const using = (name: string, input: ToolCallInput) =>
      subagentCard(
        view("working", [
          I.ToolCall.make({ id: "x", name, input, output: null, status: "completed" }),
        ]),
        call
      ).activity;

    expect(using("SendMessage", { to: "Fix tests", summary: "rebase on main" })).toBe(
      "Messaging Fix tests · rebase on main"
    );
    expect(using("TaskStop", { task_id: "b7" })).toBe("Stopping a task b7");
    expect(using("Grep", { pattern: "waitingOn" })).toBe("Searching waitingOn");
  });

  test("the Harness's report wins; interim text and the handback stay in the transcript", () => {
    const handback = I.ToolCall.make({
      id: "h1",
      name: "SubagentHandback",
      input: { message: "## Report\n\n- Done." },
      output: null,
      status: "completed",
    });

    const card = subagentCard(
      {
        subagent: subagent("completed", "## Report\n\n- Done."),
        items: [ls, report, handback],
        live: new Map(),
      },
      call
    );

    expect(card.report).toBe("## Report\n\n- Done.");
    expect(card.entries.map((e) => (e.kind === "item" ? e.item.id : e.kind))).toEqual([
      "c1",
      "m1",
      "h1",
    ]);

    const row = card.entries.at(-1);

    expect(row?.kind === "item" && row.item.kind === "tool" ? row.item.summary : null).toBe("");
  });

  test("result text from a string or text parts", () => {
    expect(resultText("done")).toBe("done");
    expect(
      resultText({
        content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
      })
    ).toBe("a\n\nb");
    expect(resultText({ status: "completed" })).toBeNull();
  });
});

const turnOf = (n: number, subagents: ReadonlyArray<SubagentView>): TurnView => ({
  turn: turnWith({ id: TurnId.make(`t${n}`), index: n, status: "completed" }),
  items: [],
  live: new Map(),
  subagents,
});

const named = (id: string, status: "working" | "completed"): SubagentView => ({
  subagent: subagent(status, null, id),
  items: [ls],
  live: new Map(),
});

describe("the session's Subagent roster", () => {
  test("lists running Subagents first with what they do, finished ones with how they ended", () => {
    const roster = subagentRoster([turnOf(0, [view("completed", [ls]), view("working", [ls])])]);

    expect(roster).toMatchObject({ running: 1, done: 1 });
    expect(roster.rows.map((r) => [r.index, r.agent, r.task, r.status])).toEqual([
      [1, "general-purpose", "List files and report back", "Running ls -la"],
      [0, "general-purpose", "List files and report back", "done"],
    ]);
  });

  test("keeps earlier Turns' running Subagents, with their own moons, and drops their ended ones", () => {
    const roster = subagentRoster([
      turnOf(0, [named("old-done", "completed"), named("old-running", "working")]),
      turnOf(1, [named("new-done", "completed")]),
    ]);

    expect(roster.rows.map((r) => [r.id, r.index])).toEqual([
      ["old-running", 1],
      ["new-done", 0],
    ]);
  });
});

describe("a Subagent for Output", () => {
  test("is found in any Turn with its moon; null once it's gone", () => {
    const found = findSubagent(
      [turnOf(0, [named("a", "completed"), named("b", "working")]), turnOf(1, [])],
      "b"
    );

    expect(found?.index).toBe(1);
    expect(found?.card.subagent.id).toBe(SubagentId.make("b"));
    expect(findSubagent([turnOf(0, [named("a", "working")])], "gone")).toBeNull();
  });
});
