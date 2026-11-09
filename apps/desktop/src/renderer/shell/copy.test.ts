import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApprovalRequest, BackgroundTask, RequestId, TurnItem } from "@polaris/protocol";
import type { HostView } from "../../shared/api.ts";
import { hostModel, hostView } from "../routes/fixtures.testing.ts";
import { approval, seq, turn } from "../store/fixtures.testing.ts";
import type { SessionEntry } from "../store/hostModel.ts";
import type { SessionModel } from "../store/sessionModel.ts";
import { activityOf, sessionLine } from "./copy.ts";
import { hostSentence, isSlowLink, SLOW_LINK_MS } from "./hostCopy.ts";
import { setClientPlatform } from "../../shared/platform.ts";

const base = (() => {
  const found = [
    ...hostModel([{ id: "w", sessions: [{ id: "s", state: "working" }] }]).sessions.values(),
  ][0];

  if (found === undefined) throw new Error("fixture has no session");

  return found;
})();

const entry = (pendingApprovals: SessionEntry["pendingApprovals"] = []): SessionEntry => ({
  ...base,
  pendingApprovals,
});

const question = new ApprovalRequest({
  id: RequestId.make("q1"),
  sessionId: approval.sessionId,
  turnId: approval.turnId,
  kind: "question",
  title: "Should Compact keep the Harness tile at 20px?",
  detail: null,
  options: [],
  openedAt: approval.openedAt,
});

const working = (item: TurnItem | null, text = ""): SessionModel => ({
  sequence: seq(1),
  synchronized: true,
  session: null,
  pendingApprovals: [],
  turns: [{ turn, items: [], live: new Map([["x", { item, text, output: "" }]]), subagents: [] }],
});

// The copy names the Client's machine ("this Mac"); pin the platform it expects.
beforeEach(() => setClientPlatform("darwin"));

afterEach(() => setClientPlatform(null));

describe("session row line", () => {
  test("a question is the ask itself, not 'Wants to …' (V1 B1)", () => {
    expect(sessionLine(entry([question]))).toBe("Should Compact keep the Harness tile at 20px?");
    expect(sessionLine(entry([approval]))).toBe("Wants to run bun test");
  });

  test("Working says the current step when the feed has one, else the turn", () => {
    const cmd = TurnItem.cases.CommandExecution.make({
      id: "c",
      command: "cargo build --release",
      cwd: "/",
      output: "",
      exitCode: null,
      status: "running",
    });

    expect(sessionLine(entry(), activityOf(working(cmd)))).toBe("Running cargo build --release");
    expect(sessionLine(entry(), activityOf(working(null, "Sure")))).toBe("Writing a reply…");
    expect(sessionLine(entry(), activityOf(undefined))).toBe("Working · turn 1");
  });

  test("Working with a tool in hand reads its verb, not its raw name", () => {
    const message = TurnItem.cases.ToolCall.make({
      id: "m",
      name: "SendMessage",
      input: { to: "Fix tests", summary: "rebase on main" },
      output: null,
      status: "running",
    });

    expect(activityOf(working(message))).toBe("Messaging Fix tests · rebase on main");
  });

  test("Idle with background tasks reads as waiting on them, not idle", () => {
    const tasks = [
      new BackgroundTask({ id: "a", kind: "subagent", description: "Explore the store" }),
      new BackgroundTask({ id: "b", kind: "subagent", description: "Run the tests" }),
    ];

    const waiting = { ...base, session: { ...base.session, state: "idle" as const } };

    expect(
      sessionLine({ ...waiting, session: { ...waiting.session, backgroundTasks: tasks } })
    ).toBe("Waiting on 2 subagents");
    expect(sessionLine(waiting)).toBe("Idle · turn 1");
  });

  test("a row's own count (the open session's roster) wins over the Host's tasks", () => {
    const tasks = [new BackgroundTask({ id: "a", kind: "subagent", description: "Explore" })];

    const idle = {
      ...base,
      session: { ...base.session, state: "idle" as const, backgroundTasks: tasks },
    };

    // The roster says that Subagent has ended: the row reads idle, not waiting.
    expect(sessionLine(idle, null, { subagents: [], tasks: [] })).toBe("Idle · turn 1");
  });

  test("Idle numbers user Turns: a Harness-started Turn doesn't add one", () => {
    const idle = (turnCount: number, number: number | null) =>
      sessionLine({
        ...base,
        session: {
          ...base.session,
          state: "idle" as const,
          turnCount,
          currentUserTurn:
            number === null ? null : { turnId: turn.id, number, startedAt: turn.startedAt },
        },
      });

    expect(idle(5, 3)).toBe("Idle · turn 3");
    expect(idle(5, null)).toBe("Idle · turn 5");
  });
});

const failing = (
  state: HostView["status"]["state"],
  reason: string,
  older?: "daemon" | "client"
): HostView => {
  const view = hostView("vm", state);

  return {
    ...view,
    label: "Linux VM",
    status: {
      ...view.status,
      failure: {
        kind: "transient",
        reason,
        detail: "/var/folders/x/daemon.sock",
        older,
      },
    },
  };
};

describe("usage limit", () => {
  test("a Limited row reads the reset neutrally, or that it is unknown", () => {
    const resetsAt = new Date(2026, 9, 12, 14, 0).toISOString();

    const limited = (at: string | null) => ({
      ...base,
      session: { ...base.session, state: "limited" as const, limitResetsAt: at },
    });

    expect(sessionLine(limited(resetsAt))).toBe("Usage limit · resets 14:00");
    expect(sessionLine(limited(null))).toBe("Usage limit · reset time unknown");
  });
});

describe("host copy", () => {
  test("says what happened in words, never the raw error or a path", () => {
    const reconnecting = hostSentence(failing("reconnecting", "connection-lost"), "12s");

    expect(reconnecting).toBe(
      "The connection to Linux VM dropped. Reconnecting for 12s; its sessions are kept."
    );
    expect(reconnecting).not.toContain("/var/");
    expect(hostSentence(failing("needs-attention", "host-key-unknown"), undefined)).toBe(
      "Linux VM's host key isn't trusted yet."
    );
    expect(hostSentence(failing("offline", "unreachable"), "09:14")).toContain(
      "Offline since 09:14"
    );
  });

  test("a protocol mismatch names the older side, either way", () => {
    expect(hostSentence(failing("needs-attention", "protocol-mismatch", "daemon"), undefined)).toBe(
      "Linux VM runs an older daemon."
    );
    expect(hostSentence(failing("needs-attention", "protocol-mismatch", "client"), undefined)).toBe(
      "Polaris on this Mac is older than the daemon on Linux VM."
    );
    expect(hostSentence(failing("needs-attention", "protocol-mismatch"), undefined)).toBe(
      "The daemon on Linux VM doesn't match Polaris on this Mac."
    );
  });

  test("a connected Host with a slow round trip is a slow link", () => {
    const view = hostView("pi");

    expect(isSlowLink({ ...view, status: { ...view.status, latencyMs: SLOW_LINK_MS } })).toBe(true);
    expect(isSlowLink({ ...view, status: { ...view.status, latencyMs: 20 } })).toBe(false);
    expect(isSlowLink(view)).toBe(false);
  });
});
