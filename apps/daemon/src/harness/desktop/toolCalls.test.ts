import { describe, expect, test } from "bun:test";
import { AppId, AppRef, AppWindow, ComputerUseCall, type TurnItem } from "@polaris/protocol";
import { Predicate, Schema } from "effect";
import { toolItem } from "../claude/translate.ts";
import { toTurnItem } from "../codex/mapping.ts";
import { ThreadItem } from "../codex/protocol.ts";
import { resultOf } from "./envelope.ts";

const call = new ComputerUseCall({
  app: new AppRef({ id: AppId.make("com.apple.TextEdit"), name: "TextEdit" }),
  window: new AppWindow({ id: "w-42", title: "note.txt" }),
  headed: false,
});

/** What the tool answered, as the Harness hands it back. */
const result = resultOf({
  envelope: { ok: true, command: "type", data: {} },
  computerUse: Schema.encodeSync(ComputerUseCall)(call),
});

const computerUseOf = (item: TurnItem | null) =>
  Predicate.isTagged(item, "ToolCall") ? (item.computerUse ?? null) : null;

const text = result.content.flatMap((c) => (c.type === "text" ? [c.text] : []))[0] ?? "";

describe("a polaris_desktop Tool Call records its app and window", () => {
  test.each([
    ["result text", { resultText: text, structured: undefined }],
    ["content blocks", { resultText: null, structured: result.content }],
  ])("from Claude Code's %s", (_, carried) => {
    const item = toolItem({
      id: "t1",
      name: "mcp__polaris_desktop__type",
      input: { ref: "@s1:e2", text: "hi" },
      cwd: "/w",
      status: "completed",
      ...carried,
    });

    expect(computerUseOf(item)).toEqual(call);
  });

  test("not from another server's tool, whatever its result says", () => {
    const item = toolItem({
      id: "t1",
      name: "mcp__other__type",
      input: {},
      cwd: "/w",
      status: "completed",
      resultText: null,
      structured: result.content,
    });

    expect(computerUseOf(item)).toBeNull();
  });

  test("from Codex's mcpToolCall result", () => {
    const item = toTurnItem(
      Schema.decodeUnknownSync(ThreadItem)({
        type: "mcpToolCall",
        id: "t",
        server: "polaris_desktop",
        tool: "type",
        status: "completed",
        arguments: { ref: "@s1:e2", text: "hi" },
        result: { content: result.content, structuredContent: null },
        error: null,
      })
    );

    expect(computerUseOf(item)).toEqual(call);
  });
});
