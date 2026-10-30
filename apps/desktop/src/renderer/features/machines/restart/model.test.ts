import { describe, expect, test } from "bun:test";
import type { RestartPreviewView } from "../../../../shared/restart.ts";
import {
  channelWords,
  commandLine,
  confirmBody,
  failedBody,
  type Failed,
  failedWell,
  moreSessions,
  needsConfirm,
  restartingFooter,
} from "./model.ts";

const working = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`,
    title: `Session ${i}`,
    harness: "claude",
    turn: i + 1,
  }));

const interrupts = (sessions: number, terminals: number, pendingApprovals: number) => ({
  workingSessions: working(sessions),
  terminals,
  pendingApprovals,
});

const preview = (it: RestartPreviewView["interrupts"]): RestartPreviewView => ({
  available: true,
  unavailableReason: null,
  interrupts: it,
});

describe("whether Restart daemon asks first", () => {
  test("restarts at once when nothing would be interrupted", () => {
    expect(needsConfirm(preview(interrupts(0, 0, 0)))).toBe(false);
  });

  test.each([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ])("asks when %i working, %i terminals, %i approvals", (s, t, a) => {
    expect(needsConfirm(preview(interrupts(s, t, a)))).toBe(true);
  });

  test("asks when the daemon can't say what is running", () => {
    expect(needsConfirm(preview(null))).toBe(true);
  });
});

describe("the confirm's body", () => {
  test("names every interruption, as the mockup does", () => {
    expect(confirmBody(interrupts(3, 2, 1))).toBe(
      "3 agent sessions are working. Their turns stop and wait for you to continue; a constellation worker continues once on its own. 2 terminals close and 1 pending approval is withdrawn."
    );
  });

  test("omits each clause whose count is zero, in the singular where it is one", () => {
    expect(confirmBody(interrupts(1, 0, 0))).toBe(
      "1 agent session is working. Its turn stops and waits for you to continue; a constellation worker continues once on its own."
    );
    expect(confirmBody(interrupts(0, 1, 0))).toBe("1 terminal closes.");
    expect(confirmBody(interrupts(0, 0, 2))).toBe("2 pending approvals are withdrawn.");
  });

  test("lists three working sessions, then how many more", () => {
    expect(moreSessions(interrupts(3, 0, 0))).toBeNull();
    expect(moreSessions(interrupts(5, 0, 0))).toBe("+2 more");
  });
});

describe("the restart's lines", () => {
  test("names the command and how it reaches the host", () => {
    expect(commandLine("launchd", channelWords("ssh", "this Mac"))).toBe(
      "LAUNCHCTL KICKSTART -K · OVER SSH"
    );
    expect(commandLine("systemd", channelWords("wsl", "this PC"))).toBe(
      "SYSTEMCTL --USER RESTART · THROUGH WSL.EXE"
    );
    expect(commandLine("launchd", channelWords("local", "this Mac"))).toBe(
      "LAUNCHCTL KICKSTART -K · ON THIS MAC"
    );
  });

  test("Restarting's footer leaves out turns it can't count", () => {
    const at = new Date(2026, 9, 30, 14, 2, 31).getTime();

    expect(restartingFooter(at, 3)).toBe("STOPPED 14:02:31 · 3 TURNS INTERRUPTED");
    expect(restartingFooter(at, 1)).toBe("STOPPED 14:02:31 · 1 TURN INTERRUPTED");
    expect(restartingFooter(at, null)).toBe("STOPPED 14:02:31");
  });
});

describe("Failed", () => {
  const failed: Failed = {
    outcome: "failed",
    stage: "start",
    message: "the daemon on Mac Studio didn't come back",
    manager: "launchd",
    command: "launchctl kickstart -k gui/501/dev.lux.polaris",
    output: 'Could not find service "dev.lux.polaris" in domain for user gui: 501\n',
    exitCode: 113,
    reinstall: true,
  };

  test("says the service manager stopped it but couldn't start it, and that sessions are kept", () => {
    expect(failedBody(failed, "Mac Studio")).toBe(
      "launchd stopped it but couldn't start it again. Nothing runs on Mac Studio until it does; its agent sessions are kept and wait for you."
    );
  });

  test("shows the command as typed above its output", () => {
    expect(failedWell(failed)).toBe(
      '$ launchctl kickstart -k gui/501/dev.lux.polaris\nCould not find service "dev.lux.polaris" in domain for user gui: 501'
    );
  });

  test("falls back to the message when the manager printed nothing", () => {
    expect(failedWell({ ...failed, command: null, output: "" })).toBe(failed.message);
  });
});
