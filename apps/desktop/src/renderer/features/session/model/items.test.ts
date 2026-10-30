import { describe, expect, test } from "bun:test";
import { Attachment, AttachmentId, TurnItem } from "@polaris/protocol";
import {
  type ToolInput,
  completedItemView,
  imageMime,
  liveItemView,
  toolFile,
  turnOutput,
} from "./items.ts";

const startedAt = "2026-09-30T10:00:00.000Z";

describe("item views", () => {
  test("live thinking is reasoning with its start, its text streamed", () => {
    const item = TurnItem.cases.Reasoning.make({ id: "r", text: "", startedAt, endedAt: null });

    expect(liveItemView("r", { item, text: "Hmm", output: "" })).toEqual({
      kind: "reasoning",
      id: "r",
      live: true,
      text: "Hmm",
      startedAt,
      endedAt: null,
    });
  });

  test("a landed steer keeps the attachments it carried, for its row", () => {
    const shot = new Attachment({
      id: AttachmentId.make("a1"),
      name: "shot.png",
      mimeType: "image/png",
      size: 4,
      hostPath: "/stage/shot.png",
      width: 2,
      height: 2,
    });

    const item = TurnItem.cases.UserMessage.make({ id: "steer:1", text: "", attachments: [shot] });

    expect(completedItemView(item)).toMatchObject({ kind: "user", text: "", attachments: [shot] });
  });

  test("a plan keeps each step's detail and its explanation", () => {
    const plan = TurnItem.cases.Plan.make({
      id: "p",
      steps: [{ text: "Run the tests", status: "in-progress", detail: "Running the tests" }],
      explanation: "Tests first.",
    });

    expect(completedItemView(plan)).toMatchObject({
      kind: "plan",
      steps: [{ text: "Run the tests", status: "in-progress", detail: "Running the tests" }],
      explanation: "Tests first.",
    });
  });

  test("a Constellation tool shows its Task and action, never its JSON", () => {
    const call = (name: string, input: ToolInput) =>
      completedItemView(
        TurnItem.cases.ToolCall.make({ id: "t", name, input, output: null, status: "completed" })
      );

    expect(
      // As the Harness passes it: JSON, never a constructed tagged value.
      call("mcp__polaris__review", JSON.parse('{"task":"A1","action":{"_tag":"SendBack"}}'))
    ).toMatchObject({ summary: "A1 · send back", polaris: true });
    expect(call("polaris.status", {})).toMatchObject({ summary: "", polaris: true });
    expect(call("Read", { file_path: "a.ts" })).toMatchObject({ summary: "a.ts", polaris: false });
  });
});

describe("toolFile", () => {
  test("Read, Edit and Write name a file; Read's offset is its line", () => {
    expect(toolFile({ file_path: "/a/b.ts", offset: 40, limit: 20 })).toEqual({
      path: "/a/b.ts",
      line: 40,
      image: false,
    });
    expect(toolFile({ file_path: "/a/b.ts" })).toEqual({
      path: "/a/b.ts",
      line: null,
      image: false,
    });
  });

  test("an image opens in the viewer: Claude Code's Read, Codex's view_image path", () => {
    expect(toolFile({ file_path: "/a/shot.PNG" })?.image).toBe(true);
    expect(toolFile({ path: "out/diagram.webp" })).toEqual({
      path: "out/diagram.webp",
      line: null,
      image: true,
    });
    expect(imageMime("a.jpeg")).toBe("image/jpeg");
    expect(imageMime("a.svg")).toBe("image/svg+xml");
    expect(imageMime("a.ts")).toBeNull();
  });

  test("a pattern, a command or a folder isn't a file", () => {
    expect(toolFile({ pattern: "TODO", path: "src" })).toBeNull();
    expect(toolFile("ls")).toBeNull();
    expect(toolFile(null)).toBeNull();
  });
});

describe("turnOutput", () => {
  test("the agent's messages as Markdown, nothing else", () => {
    const views = [
      TurnItem.cases.AssistantMessage.make({ id: "a", text: "First **point**.\n" }),
      TurnItem.cases.ToolCall.make({
        id: "t",
        name: "Read",
        input: { file_path: "a.ts" },
        output: null,
        status: "completed",
      }),
      TurnItem.cases.UserMessage.make({ id: "steer:1", text: "and then?" }),
      TurnItem.cases.AssistantMessage.make({ id: "b", text: "Second." }),
    ].map(completedItemView);

    expect(turnOutput(views)).toBe("First **point**.\n\nSecond.");
  });
});
