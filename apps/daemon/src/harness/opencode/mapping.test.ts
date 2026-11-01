import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import { ApprovalDecision, Attachment, AttachmentId, TurnItem } from "@polaris/protocol";
import {
  isPlaceholderTitle,
  parseModelId,
  permissionPrompt,
  permissionReply,
  planItem,
  promptParts,
  questionReply,
  rulesetFor,
  toolItem,
} from "./mapping.ts";
import type {
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  ToolPart,
  ToolState,
} from "./protocol.ts";

/** OpenCode's own rule evaluation: the last rule whose permission matches wins (`*` matches all). */
const evaluate = (rules: PermissionRuleset, permission: string) =>
  rules.findLast((rule) => rule.permission === "*" || rule.permission === permission)?.action;

const part = (tool: string, state: ToolState): ToolPart => ({
  id: "prt_1",
  sessionID: "ses_1",
  messageID: "msg_1",
  type: "tool",
  callID: "call_1",
  tool,
  state,
});

const request = (
  permission: string,
  patterns: ReadonlyArray<string>,
  metadata = {}
): PermissionRequest => ({
  id: "per_1",
  sessionID: "ses_1",
  permission,
  patterns,
  metadata,
  always: [],
});

describe("permission modes", () => {
  test.each([
    [
      "supervised",
      { read: "allow", edit: "ask", bash: "ask", external_directory: "ask", question: "allow" },
    ],
    ["auto-edits", { read: "allow", edit: "allow", bash: "ask", external_directory: "ask" }],
    [
      "auto",
      { read: "allow", edit: "allow", bash: "allow", external_directory: "ask", doom_loop: "ask" },
    ],
    ["full-access", { read: "allow", edit: "allow", bash: "allow", external_directory: "allow" }],
  ] as const)("%s", (mode, expected) => {
    for (const [permission, action] of Object.entries(expected))
      expect(evaluate(rulesetFor(mode), permission)).toBe(action);
  });

  test("appending a mode's rules overrides the previous mode entirely", () => {
    const rules = [...rulesetFor("full-access"), ...rulesetFor("supervised")];

    expect(evaluate(rules, "bash")).toBe("ask");
    expect(evaluate([...rules, ...rulesetFor("full-access")], "bash")).toBe("allow");
  });
});

describe("Models", () => {
  test("provider/model ids, with slashes in the model part", () => {
    expect(parseModelId("openai/gpt-5.5")).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
    expect(parseModelId("openrouter/anthropic/claude-sonnet-5-5")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-5-5",
    });
    expect(parseModelId("gpt-5.5")).toBeNull();
    expect(parseModelId("/gpt")).toBeNull();
    expect(parseModelId("openai/")).toBeNull();
  });
});

describe("tool parts", () => {
  test("bash: running with its streamed output, then completed with its exit code", () => {
    expect(toolItem(part("bash", { status: "pending", input: {} }), "/repo")).toBeNull();
    expect(
      toolItem(
        part("bash", { status: "running", input: { command: "ls" }, metadata: { output: "a\n" } }),
        "/repo"
      )
    ).toEqual(
      TurnItem.cases.CommandExecution.make({
        id: "prt_1",
        command: "ls",
        cwd: "/repo",
        output: "a\n",
        exitCode: null,
        status: "running",
      })
    );
    expect(
      toolItem(
        part("bash", {
          status: "completed",
          input: { command: "ls", workdir: "/repo/sub" },
          output: "a\nb\n",
          metadata: { exit: 2 },
        }),
        "/repo"
      )
    ).toMatchObject({ cwd: "/repo/sub", output: "a\nb\n", exitCode: 2, status: "completed" });
  });

  test("a rejected permission is declined, other errors failed", () => {
    const rejected = part("bash", {
      status: "error",
      input: { command: "rm -rf /" },
      error: "The user rejected permission to use this specific tool call.",
    });

    expect(toolItem(rejected, "/repo")).toMatchObject({ status: "declined" });
    expect(
      toolItem(part("bash", { status: "error", input: {}, error: "boom" }), "/repo")
    ).toMatchObject({
      status: "failed",
      output: "boom",
    });
  });

  test("file tools become file changes", () => {
    const edit = part("edit", {
      status: "completed",
      input: { filePath: "/repo/a.ts" },
      output: "",
      metadata: {},
    });

    expect(toolItem(edit, "/repo")).toEqual(
      TurnItem.cases.FileChange.make({
        id: "prt_1",
        changes: [{ path: "/repo/a.ts", kind: "modify" }],
        status: "completed",
      })
    );

    const created = part("write", {
      status: "completed",
      input: { filePath: "/repo/b.ts" },
      output: "",
      metadata: {},
    });

    expect(toolItem(created, "/repo")).toMatchObject({
      changes: [{ path: "/repo/b.ts", kind: "add" }],
    });

    const overwritten = part("write", {
      status: "completed",
      input: { filePath: "/repo/b.ts" },
      output: "",
      metadata: { exists: true },
    });

    expect(toolItem(overwritten, "/repo")).toMatchObject({
      changes: [{ path: "/repo/b.ts", kind: "modify" }],
    });

    const patchText = [
      "*** Begin Patch",
      "*** Add File: new.ts",
      "+x",
      "*** Update File: old.ts",
      "*** Delete File: gone.ts",
      "*** End Patch",
    ].join("\n");

    expect(
      toolItem(part("apply_patch", { status: "running", input: { patchText } }), "/repo")
    ).toMatchObject({
      changes: [
        { path: "new.ts", kind: "add" },
        { path: "old.ts", kind: "modify" },
        { path: "gone.ts", kind: "delete" },
      ],
      status: "running",
    });
  });

  test("other tools are tool calls with their input, output and kind", () => {
    const grep = part("grep", {
      status: "completed",
      input: { pattern: "x" },
      output: "found",
      metadata: {},
    });

    expect(toolItem(grep, "/repo")).toEqual(
      TurnItem.cases.ToolCall.make({
        id: "prt_1",
        name: "grep",
        kind: "search",
        input: { pattern: "x" },
        output: "found",
        status: "completed",
      })
    );
  });

  test("a tool OpenCode doesn't build in, such as an MCP server's, is other", () => {
    const item = toolItem(
      part("paper_write_html", { status: "completed", input: {}, output: "ok", metadata: {} }),
      "/repo"
    );

    expect(item).toEqual(
      TurnItem.cases.ToolCall.make({
        id: "prt_1",
        name: "paper_write_html",
        kind: "other",
        input: {},
        output: "ok",
        status: "completed",
      })
    );
  });

  test("todowrite's list is a Plan", () => {
    expect(
      planItem("t:plan", {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
          { content: "c", status: "cancelled" },
        ],
      })
    ).toEqual(
      TurnItem.cases.Plan.make({
        id: "t:plan",
        steps: [
          { text: "a", status: "completed", detail: null },
          { text: "b", status: "in-progress", detail: null },
          { text: "c", status: "pending", detail: null },
        ],
        explanation: null,
      })
    );
    expect(planItem("t:plan", { nope: true })).toBeNull();
  });
});

describe("approvals", () => {
  test("how permission requests are shown", () => {
    expect(
      permissionPrompt(request("bash", ["git push"], { command: "git push", description: "Push" }))
    ).toEqual({
      kind: "command",
      title: "git push",
      detail: "Push",
    });
    expect(
      permissionPrompt(request("edit", ["src/a.ts"], { filepath: "src/a.ts", diff: "-a\n+b" }))
    ).toEqual({
      kind: "file-change",
      title: "Edit src/a.ts",
      detail: "-a\n+b",
    });
    expect(permissionPrompt(request("external_directory", ["/etc/*"]))).toMatchObject({
      kind: "tool",
      title: "Access /etc/* outside the Workspace",
    });
    expect(permissionPrompt(request("webfetch", ["https://x.dev"]))).toMatchObject({
      kind: "tool",
      title: "webfetch: https://x.dev",
    });
  });

  test("replies", () => {
    expect(permissionReply(ApprovalDecision.cases.Allow.make({ remember: false }))).toEqual({
      reply: "once",
    });
    expect(permissionReply(ApprovalDecision.cases.Allow.make({ remember: true }))).toEqual({
      reply: "always",
    });
    expect(permissionReply(ApprovalDecision.cases.Deny.make({ reason: null }))).toEqual({
      reply: "reject",
    });
    expect(permissionReply(ApprovalDecision.cases.Answer.make({ text: "use rg" }))).toEqual({
      reply: "reject",
      message: "use rg",
    });

    const question: QuestionRequest = {
      id: "que_1",
      sessionID: "ses_1",
      questions: [
        { question: "A?", header: "A", options: [{ label: "yes", description: "" }] },
        { question: "B?", header: "B", options: [] },
      ],
    };

    expect(questionReply(question, ApprovalDecision.cases.Allow.make({ remember: false }))).toEqual(
      {
        answers: [["yes"], []],
      }
    );
    expect(questionReply(question, ApprovalDecision.cases.Answer.make({ text: "x" }))).toEqual({
      answers: [["x"], ["x"]],
    });
    expect(
      questionReply(
        question,
        ApprovalDecision.cases.Answer.make({ text: "yes\nmaybe", answers: [["yes"], ["maybe"]] })
      )
    ).toEqual({ answers: [["yes"], ["maybe"]] });
    expect(questionReply(question, ApprovalDecision.cases.Deny.make({ reason: null }))).toBeNull();
  });
});

describe("prompts and titles", () => {
  test("images become file parts; other attachments are listed by path", () => {
    const attachment = (name: string, mimeType: string) =>
      new Attachment({
        id: AttachmentId.make(name),
        name,
        mimeType,
        size: 1,
        hostPath: `/home/u/.polaris/staging/s1/${name}`,
        width: null,
        height: null,
      });

    expect(
      promptParts("look", [
        attachment("shot.png", "image/png"),
        attachment("log.txt", "text/plain"),
      ])
    ).toEqual([
      { type: "text", text: "look\n\nAttached files:\n- /home/u/.polaris/staging/s1/log.txt" },
      {
        type: "file",
        mime: "image/png",
        filename: "shot.png",
        url: "file:///home/u/.polaris/staging/s1/shot.png",
      },
    ]);
  });

  test("an @path mention of something in the session's directory goes as a file part (ENG-544)", () => {
    const cwd = resolve("/w");

    const tree = new Map<string, "file" | "folder">([
      [join(cwd, "src/app.ts"), "file"],
      [join(cwd, "docs"), "folder"],
      [join(cwd, "my notes.md"), "file"],
    ]);

    const prompt = 'fix @src/app.ts per @docs/ and @"my notes.md", not me@x.com or @../etc/passwd';

    const parts = promptParts(prompt, [], {
      cwd,
      kindOf: (path) => tree.get(path) ?? null,
    });

    expect(parts[0]).toEqual({ type: "text", text: prompt });
    expect(parts[1]).toEqual({
      type: "file",
      mime: "text/plain",
      filename: "app.ts",
      url: pathToFileURL(join(cwd, "src/app.ts")).href,
      source: {
        type: "file",
        path: "src/app.ts",
        text: { value: "@src/app.ts", start: 4, end: 15 },
      },
    });
    expect(parts.slice(2)).toMatchObject([
      { mime: "application/x-directory", url: pathToFileURL(join(cwd, "docs")).href },
      { filename: "my notes.md", url: pathToFileURL(join(cwd, "my notes.md")).href },
    ]);
  });

  test("OpenCode's placeholder titles are not suggestions", () => {
    expect(isPlaceholderTitle("New session - 2026-09-29T05:10:06.618Z")).toBe(true);
    expect(isPlaceholderTitle("Child session - 2026-09-29T05:10:06.618Z")).toBe(true);
    expect(isPlaceholderTitle("Fix the flaky test")).toBe(false);
  });
});
