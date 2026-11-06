import { TurnItem } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import type { ToolKind } from "./protocol.ts";
import { toolCallItem } from "./translate.ts";

const call = (kind: ToolKind, title: string) =>
  toolCallItem(
    {
      fields: { toolCallId: "t1", kind, title, status: "completed", rawInput: { q: "x" } },
      declined: false,
    },
    "/repo"
  );

const expected = (kind: "search" | "other", title: string) =>
  TurnItem.cases.ToolCall.make({
    id: "t1",
    name: title,
    kind,
    title,
    input: { q: "x" },
    output: null,
    status: "completed",
  });

describe("toolCallItem", () => {
  test.each<[ToolKind, string, "search" | "other"]>([
    ["search", "Find usages of foo", "search"],
    ["think", "Ponder", "other"],
  ])(
    "ACP's %s keeps its title; a Tool Run counts only the kinds it knows",
    (kind, title, mapped) => {
      expect(call(kind, title)).toEqual(expected(mapped, title));
    }
  );
});
