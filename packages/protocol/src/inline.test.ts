import { expect, test } from "bun:test";
import { InlinePatch, InlineRequest, inlineSessionPrompt } from "./inline.ts";
import { WorkspaceId } from "./ids.ts";

test("session conversion preserves the exact unsaved selection and proposal", () => {
  const request = InlineRequest.make({
    workspaceId: WorkspaceId.make("w"),
    path: "/repo/a.ts",
    content: "before unsaved after",
    selection: { from: 7, to: 14 },
    prompt: "Change this",
    harness: "codex",
    model: null,
    effort: null,
  });

  const patch = InlinePatch.make({
    replacements: [{ from: 7, to: 14, text: "saved" }],
    summary: "Replace",
  });

  const prompt = inlineSessionPrompt(request, patch);

  expect(prompt).toContain('"text":"unsaved"');

  expect(prompt).toContain(JSON.stringify(patch));

  expect(prompt).toContain(request.prompt);
});
