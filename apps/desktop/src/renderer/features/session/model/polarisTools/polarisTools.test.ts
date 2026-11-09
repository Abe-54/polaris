import { describe, expect, test } from "bun:test";
import { TurnItem } from "@polaris/protocol";
import { polarisToolView, withBanner } from "./index.ts";

type Status = "running" | "completed" | "failed" | "declined";

/** A tool call as the Harness passes it: JSON input, and a reply as text or as JSON. */
const call = (
  name: string,
  input: string,
  output: { readonly text?: string; readonly json?: string } = {},
  status: Status = "completed"
) => {
  const item = TurnItem.cases.ToolCall.make({
    id: "t1",
    name,
    input: JSON.parse(input),
    output: output.json === undefined ? (output.text ?? null) : JSON.parse(output.json),
    status,
  });

  const view = polarisToolView(item);

  if (view === null) throw new Error(`${name} is a Polaris tool`);

  return view;
};

const line = (view: ReturnType<typeof call>) =>
  [view.verb, view.subject?.text, ...view.detail.map((d) => d.text)]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");

const recorded = (summary: string, revision = 9) => ({
  text: `${summary}\nRevision: ${revision}\nNext: Continue.`,
});

describe("polarisToolView", () => {
  test("only Polaris's tools, whichever Harness named them", () => {
    const read = TurnItem.cases.ToolCall.make({
      id: "r",
      name: "Read",
      input: {},
      output: null,
      status: "completed",
    });

    expect(polarisToolView(read)).toBeNull();
    expect(call("mcp__polaris__status", "{}").tool).toBe("status");
    expect(call("polaris.status", "{}").tool).toBe("status");
    expect(call("polaris_1.status", "{}").tool).toBe("status");
  });

  test("dispatch reads as the Task started and where, never JSON", () => {
    const view = call(
      "mcp__polaris__dispatch",
      '{"tasks":[{"taskId":"B1","worker":{"host":"Mac Studio","selection":{"harness":"codex","model":"gpt-5.5"}}}]}',
      recorded("Dispatch recorded.")
    );

    expect(line(view)).toBe("Started B1 Codex · gpt-5.5 · Mac Studio");
    expect(view.detail[0]?.hue).toBe("codex");
    expect(view.reply).toBe("Dispatch recorded · revision 9");
    expect(view.links).toEqual([{ label: "Open B1", taskId: "B1" }]);
    expect(view.raw.input).toContain('"taskId": "B1"');
  });

  test("a plan is its Tasks: added, edited, canceled", () => {
    const view = call(
      "polaris.plan",
      `{"start":{"name":"Constellations v1","workspaceId":"w"},"operations":[
        {"_tag":"Add","task":{"id":"B6","title":"Lease bench","kind":"task","deps":["B2"]}},
        {"_tag":"Add","task":{"id":"G2","title":"Spec and tools merged","kind":"gate"}},
        {"_tag":"Edit","taskId":"A2","revision":1,"task":{"deps":null,"brief":null}},
        {"_tag":"Cancel","taskId":"A3","revision":1}]}`
    );

    expect(line(view)).toBe(
      "Planned 4 Tasks started Constellations v1 · 1 Gate · edited A2 · canceled A3"
    );

    const rows = view.well?.kind === "tasks" ? view.well.rows : [];

    expect(rows.map((r) => [r.id, r.change[0]?.text, r.struck])).toEqual([
      ["B6", "added", false],
      ["G2", "added", false],
      ["A2", "edited", false],
      ["A3", "canceled", true],
    ]);
  });

  test("a claim shows its head, checks and what isn't done", () => {
    const view = call(
      "mcp__polaris__claim",
      `{"claim":{"branch":"polaris/b1-quint","head":"3f9c2e1a0b9d8c7e","commits":["a","b","c"],
        "receipts":[{"_tag":"Verified","label":"spec","item":{}},
          {"_tag":"Reported","label":"trace","text":"failed","exitCode":1},
          {"_tag":"Reported","label":"smoke","text":"ran it"}],
        "notDone":["Trace validation of the handover log"],"followups":[],"questions":[],
        "outsideArea":[],"decisions":[],"summary":"Seven of eight properties hold."}}`
    );

    expect(line(view)).toBe("Claimed 3f9c2e1 · 3 checks · 1 not done");

    const checks = view.well?.kind === "fields" ? view.well.checks : [];

    expect(checks.map((c) => c.state)).toEqual(["passed", "failed", "reported"]);
  });

  test("a refusal is Polaris's finding, neutral, with its fix", () => {
    const view = call(
      "mcp__polaris__review",
      '{"task":"B1","revision":2,"action":{"_tag":"Accept","mergedHead":"abc","receipts":[]}}',
      {
        json: JSON.stringify({
          content: [
            {
              type: "text",
              text: "E-REVISION: Attempt changed\nFix: Read status and review the current Claim.\nRevision: 12\nNext: Apply these fixes and retry.",
            },
          ],
          isError: true,
        }),
      }
    );

    expect(view.phase).toBe("refused");
    expect(line(view)).toBe("Didn't accept B1 attempt changed");
    expect(view.caption).toBe("rejected");

    expect(view.refusal).toEqual({
      code: "E-REVISION",
      message: "Attempt changed",
      fix: "Read status and review the current Claim.",
    });
    expect(view.reply).toBe("Nothing changed · revision 12");
  });

  test("pending reads in the present", () => {
    const view = call(
      "polaris.dispatch",
      '{"tasks":[{"taskId":"B5","worker":{"host":"devbox"}}]}',
      {},
      "running"
    );

    expect(view.verb).toBe("Starting");
    expect(view.phase).toBe("pending");
  });

  test("wait_for_command: the command, its exit, and a timeout that isn't a failure", () => {
    const finished = call("polaris.wait_for_command", "{}", {
      text: "Finished: bun test (exit 1)\n 1653 pass\n 2 fail\nNext: Continue with the results.",
    });

    expect(line(finished)).toBe("Waited for bun test · exit 1");
    expect(finished.detail[0]?.tone).toBe("failed");
    expect(finished.well).toEqual({ kind: "tail", text: " 1653 pass\n 2 fail" });

    const still = call("polaris.wait_for_command", '{"timeoutSeconds":45}', {
      text: "Still running after 45s:\n- t1: bun dev\nNext: Call wait_for_command again.",
    });

    expect(line(still)).toBe("Waited 45s bun dev is still running");
    expect(still.caption).toBe("timed out, not failed");
    expect(still.phase).toBe("done");

    const idle = call("polaris.wait_for_command", "{}", {
      text: "No background commands are running.\nNext: Continue.",
    });

    expect(line(idle)).toBe("Nothing was running to wait for");
    expect(call("polaris.wait_for_command", '{"timeoutSeconds":30}', {}, "running").caption).toBe(
      "up to 30s"
    );
  });

  test("notify: the notification as sent, and whether its banner showed", () => {
    const sent = call(
      "mcp__polaris__notify",
      '{"title":"B1 is ready","body":"Seven of eight hold."}',
      {
        text: "Notification sent.\nNext: Continue.",
      }
    );

    expect(sent.well).toEqual({
      kind: "banner",
      title: "B1 is ready",
      body: "Seven of eight hold.",
    });
    expect(sent.notice).toEqual({ title: "B1 is ready", body: "Seven of eight hold." });
    expect(withBanner(sent, "shown").caption).toBe("banner shown");
    expect(withBanner(sent, "here").caption).toBe("no banner, you were here");
    expect(withBanner(sent, null).caption).toBeNull();

    const limited = call("mcp__polaris__notify", '{"title":"Tests pass"}', {
      text: "error: E-RATE: This session notified the user moments ago\nFix: Notify again in 12s.\nRevision: 0\nNext: Apply these fixes and retry.",
    });

    expect(line(limited)).toBe("Didn't notify you Tests pass too soon after the last one");
    expect(limited.caption).toBe("rate-limited");
    expect(limited.reply).toBe("Nothing changed");
    expect(withBanner(limited, "shown")).toBe(limited);
  });

  test.each([
    [
      "Saved. The secret is in /home/u/.polaris/secrets/sessions/s1/ab12, readable for 24 hours.",
      "saved securely",
    ],
    ["The user declined.\nCarry on without it.", "declined"],
    ["No answer in 10 minutes; the request was withdrawn.", "timed out"],
  ])("request_secret: the label it asked for, and how it ended (%#)", (text, caption) => {
    const view = call(
      "mcp__polaris__request_secret",
      '{"label":"Tailscale auth key","reason":"To join the tailnet"}',
      { text }
    );

    expect(line(view)).toBe("Asked you for a secret Tailscale auth key");
    expect(view.caption).toBe(caption);
  });

  test("read_worker: whose Turns, each one's state and reply", () => {
    const view = call("polaris.read_worker", '{"task":"B2","turns":2}', {
      text: [
        "Task B2 · Attempt a1",
        "# Lead and worker MCP tools",
        "",
        "## Turn 4 · completed · started 2026-10-11T13:52:00Z",
        "Prompt: go",
        "Assistant: The tools register.",
        "$ bun test (exit 0)",
        "",
        "## Turn 5 · working · started 2026-10-11T14:06:00Z",
        "Prompt: next",
        "Next: Steer with message, or review its Claim when it arrives.",
      ].join("\n"),
    });

    expect(line(view)).toBe("Read B2's last 2 Turns");
    expect(view.links).toEqual([{ label: "Open B2", taskId: "B2" }]);

    const turns = view.well?.kind === "turns" ? view.well.turns : [];

    expect(turns.map((t) => [t.reply, t.commands])).toEqual([
      ["The tools register.", ["$ bun test (exit 0)"]],
      [null, []],
    ]);
  });

  test("the worker's own tools in glossary words", () => {
    expect(line(call("polaris.block", '{"on":["F1b"],"reason":"Needs the feed URL"}'))).toBe(
      "Blocked on F1b Needs the feed URL"
    );
    expect(call("polaris.block", '{"on":[],"reason":"Specs disagree"}').verb).toBe(
      "Waiting for the lead"
    );
    expect(line(call("polaris.progress", '{"note":"Rows at 32px","completed":3,"total":5}'))).toBe(
      "Reported progress 3 of 5 Rows at 32px"
    );

    const asked = call(
      "polaris.ask",
      '{"question":{"id":"q","to":"user","text":"Wire format?","blocking":false}}'
    );

    expect(asked.caption).toBe("Answer in Needs You");
    expect(line(call("polaris.message", '{"to":"all","text":"Rebase on main."}'))).toBe(
      "Messaged all workers “Rebase on main.”"
    );
    expect(line(call("polaris.set_state", '{"action":{"_tag":"Pause"}}'))).toBe(
      "Paused the constellation"
    );
  });

  test("an unknown or malformed call still reads, never as JSON", () => {
    expect(line(call("polaris.pin", '{"anything":1}'))).toBe("Ran pin");
    expect(line(call("polaris.dispatch", '"not an object"'))).toBe("Started ready Tasks");
    expect(call("polaris.status", "{}", {}, "failed").refusal?.message).toBe(
      "The call didn't reach Polaris"
    );
  });
});
