import { type ToolKind, TurnItem } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { completedItemView, type ItemView, liveItemView, type ToolInput } from "./items.ts";
import {
  type Entry,
  groupItems,
  polarisTool,
  runKind,
  runSummary,
  toolLabel,
  toolVerb,
} from "./runs.ts";

interface ToolOptions {
  readonly kind?: ToolKind;
  readonly mcp?: { readonly server: string; readonly tool: string };
  readonly input?: ToolInput;
}

const tool = (
  id: string,
  name: string,
  status: "completed" | "failed" | "running" = "completed",
  options: ToolOptions = {}
): ItemView => {
  const item = TurnItem.cases.ToolCall.make({
    id,
    name,
    kind: options.kind ?? null,
    mcp: options.mcp ?? null,
    input: options.input ?? { file_path: `${id}.ts` },
    output: null,
    status,
  });

  return status === "running"
    ? liveItemView(id, { item, text: "", output: "" })
    : completedItemView(item);
};

const mcp = (id: string, server: string, name = "write_html", input: ToolInput = {}) =>
  tool(id, `mcp__${server}__${name}`, "completed", {
    kind: "mcp",
    mcp: { server, tool: name },
    input,
  });

const skill = (id: string, name: string) =>
  tool(id, "Skill", "completed", { kind: "skill", input: { skill: name } });

const thought = (id: string): ItemView => ({
  kind: "reasoning",
  id,
  live: false,
  text: "",
  startedAt: null,
  endedAt: null,
});

const command = (id: string, exitCode: number | null = 0): ItemView => ({
  kind: "command",
  id,
  live: false,
  command: "bun test",
  output: "",
  exitCode,
  status: exitCode === 0 ? "completed" : "failed",
});

const edit = (id: string, paths: ReadonlyArray<string>): ItemView => ({
  kind: "files",
  id,
  live: false,
  changes: paths.map((path) => ({ path, kind: "modify" as const })),
  status: "completed",
});

const message = (id: string): ItemView => ({ kind: "message", id, live: false, text: "ok" });

const label = (entry: Entry) => {
  switch (entry.kind) {
    case "run":
      return `run:${entry.items.length}`;
    case "item":
      return entry.item.id;
    case "subagent":
      return entry.card.id;
  }
};

describe("tool runs", () => {
  test("consecutive successful calls fold into one summary in a fixed phrase order", () => {
    const items = [
      command("c1"),
      tool("r1", "Read"),
      tool("g1", "Grep"),
      tool("r2", "Read"),
      edit("e1", ["a.ts", "b.ts"]),
      edit("e2", ["a.ts"]),
    ];

    expect(groupItems(items)).toEqual([
      {
        kind: "run",
        id: "c1",
        items,
        summary: "Read 2 files, searched for 1 pattern, edited 2 files, ran 1 command",
      },
    ]);
  });

  test("prose, failures and running calls break a run; a lone call keeps its row", () => {
    const entries = groupItems([
      tool("r1", "Read"),
      tool("r2", "Read"),
      message("m1"),
      tool("r3", "Read"),
      command("c1", 1),
      tool("r4", "Read"),
      tool("r5", "Read", "running"),
    ]);

    expect(entries.map(label)).toEqual(["run:2", "m1", "r3", "c1", "r4", "r5"]);
  });

  // ENG-759: Codex's view_image folded into "read 3 files", so its screenshots never showed.
  test("a call that viewed an image keeps its row between reads", () => {
    const viewed = tool("v1", "view_image", "completed", {
      kind: "read",
      input: { path: "/home/ubuntu/shots/after.png" },
    });

    const entries = groupItems([
      tool("r1", "Read"),
      tool("r2", "Read"),
      viewed,
      tool("r3", "Read"),
    ]);

    expect(entries.map(label)).toEqual(["run:2", "v1", "r3"]);
    expect(
      runKind(tool("r4", "Read", "completed", { input: { file_path: "shot.png" } }))
    ).toBeNull();
  });

  test("only known read, search and fetch tools join older items; others keep their rows", () => {
    expect(runKind(tool("x", "WebFetch"))).toBe("fetch");
    expect(runKind(tool("x", "Agent"))).toBeNull();
    expect(runKind(tool("x", "Read", "failed"))).toBeNull();
    expect(runSummary([tool("a", "Glob"), tool("b", "WebSearch")])).toBe(
      "Searched for 1 pattern, searched the web 1 time"
    );
  });

  test("tool rows read as verbs", () => {
    expect(toolVerb("Read", false)).toBe("Read");
    expect(toolVerb("Grep", true)).toBe("Searching");
    expect(toolVerb("view_image", false)).toBe("Viewed an image");
  });

  test("Constellation tools read as verbs, from Claude Code and Codex alike", () => {
    expect(toolVerb("mcp__polaris__claim", false)).toBe("Claimed");
    expect(toolVerb("mcp__polaris_1__dispatch", true)).toBe("Dispatching");
    expect(toolVerb("polaris.review", false)).toBe("Reviewed a claim");
    expect(toolVerb("polaris_2.status", false)).toBe("Checked the constellation");
    expect(toolVerb("polaris.new_tool", false)).toBe("New tool");
    expect([polarisTool("mcp__polarisx__claim"), polarisTool("polaris")]).toEqual([null, null]);
  });

  test("Skills, then built-ins, then each MCP server in first-use order", () => {
    const items = [
      mcp("p1", "paper"),
      skill("s1", "grilling"),
      mcp("l1", "claude_ai_Linear", "list_releases"),
      command("c1"),
      mcp("p2", "paper"),
      skill("s2", "domain-modeling"),
    ];

    expect(runSummary(items)).toBe(
      "Loaded grilling and domain-modeling, ran 1 command, called Paper 2 times, called Linear once"
    );
  });

  test("three Skills or more are counted", () => {
    expect(runSummary([skill("a", "a"), skill("b", "b"), skill("c", "c")])).toBe("Loaded 3 skills");
  });

  test("ToolSearch folds into a run: tools loaded by name are counted, a keyword search isn't", () => {
    const select = tool("t1", "ToolSearch", "completed", { input: { query: "select:a,b" } });
    const keyword = tool("t2", "ToolSearch", "completed", { input: { query: "slack send" } });

    expect(groupItems([select, keyword, mcp("p1", "paper")])).toEqual([
      expect.objectContaining({ kind: "run", summary: "Loaded 2 tools, called Paper once" }),
    ]);
    expect(runSummary([keyword, mcp("p1", "paper")])).toBe("Called Paper once");
  });

  test("thinking between calls folds into the run; thinking around it keeps its row", () => {
    const entries = groupItems([
      thought("t0"),
      mcp("p1", "paper"),
      thought("t1"),
      mcp("p2", "paper"),
      thought("t2"),
      message("m1"),
    ]);

    expect(entries.map(label)).toEqual(["t0", "run:3", "t2", "m1"]);
  });

  test("one call with thinking after it is still a lone call", () => {
    expect(groupItems([mcp("p1", "paper"), thought("t1")]).map(label)).toEqual(["p1", "t1"]);
  });

  test("an MCP call from before drivers named its server still joins by its Claude name", () => {
    expect(runKind(tool("x", "mcp__claude_ai_Linear__get_issue"))).toBe("mcp");
  });

  test("Polaris's own tools keep their rows", () => {
    const claim = tool("x", "mcp__polaris__claim", "completed", {
      kind: "mcp",
      mcp: { server: "polaris", tool: "claim" },
    });

    expect(runKind(claim)).toBeNull();
  });

  test("MCP and Skill rows read as what they did", () => {
    const labelOf = (item: ItemView) => (item.kind === "tool" ? toolLabel(item) : "");

    const running = tool("r", "mcp__paper__get_screenshot", "running", {
      kind: "mcp",
      mcp: { server: "paper", tool: "get_screenshot" },
    });

    expect([
      labelOf(mcp("a", "claude_ai_Linear")),
      labelOf(running),
      labelOf(skill("s", "x")),
    ]).toEqual(["Called Linear", "Calling Paper", "Loaded"]);
  });
});
