import { describe, expect, test } from "bun:test";
import { RequestId, SessionId, Subagent, SubagentId, TurnId } from "@polaris/protocol";
import { request } from "../thread/daemon.testing.ts";
import { stripOf } from "./strip.ts";

const helper = (id: string) =>
  new Subagent({
    id: SubagentId.make(id),
    sessionId: SessionId.make("s-1"),
    turnId: TurnId.make("t-1"),
    parentItemId: null,
    title: id,
    agent: null,
    model: null,
    status: "working",
    startedAt: "2026-10-29T12:00:00.000Z",
    endedAt: null,
  });

const at = (minute: number) => `2026-10-29T12:0${minute}:00.000Z`;

describe("the composer's notice strip", () => {
  test("nothing asked and nothing working: no strip", () => {
    expect(stripOf({ requests: [], working: false, harness: "Claude Code" })).toBeNull();
  });

  test("working with nothing asked shows Working", () => {
    expect(stripOf({ requests: [], working: true, harness: "Claude Code" })?.notice?.kind).toBe(
      "working"
    );
  });

  test("a request asked while the lead works on takes the strip, not Working", () => {
    const strip = stripOf({
      requests: [request({ kind: "command", detail: "bun run build" })],
      working: true,
      harness: "Claude Code",
    });

    expect(strip?.notice).toMatchObject({
      kind: "approval",
      headline: "Claude Code wants to run",
      detail: "$ bun run build",
      compact: true,
    });
  });

  test("a Subagent's request says a subagent asks, with its moon", () => {
    const strip = stripOf({
      requests: [request({ kind: "command", detail: "ls", subagentId: SubagentId.make("b") })],
      working: true,
      harness: "Claude Code",
      subagents: [helper("a"), helper("b")],
    });

    expect(strip?.notice).toMatchObject({ headline: "A subagent wants to run", moon: 1 });
  });

  test("the lead's own request names the Harness, with no moon", () => {
    const strip = stripOf({
      requests: [request({ kind: "file-change" })],
      working: true,
      harness: "Codex",
      subagents: [helper("a")],
    });

    expect(strip?.notice).toMatchObject({ headline: "Codex wants to change files", moon: null });
  });

  test("the oldest request leads and the rest count behind it", () => {
    const strip = stripOf({
      requests: [
        request({ id: RequestId.make("late"), openedAt: at(5) }),
        request({ id: RequestId.make("early"), openedAt: at(1) }),
        request({ id: RequestId.make("middle"), openedAt: at(3) }),
      ],
      working: false,
      harness: "Codex",
    });

    expect(strip?.notice?.kind === "approval" ? strip.notice.request.id : null).toBe(
      RequestId.make("early")
    );
    expect(strip?.more).toBe(2);
  });

  test.each([
    ["a long command", "x".repeat(80)],
    ["a multi-line command", "cd apps\nbun test"],
    ["a line separator", "ls\u2028rm -rf ~"],
    ["a bidi override", "ls \u202e~ fr- mr"],
    ["a zero-width space", "ls\u200b"],
    ["past what fits beside Approve", "bun run build:all" + "x".repeat(10)],
  ])("%s opens to every line instead of sitting beside Approve", (_, detail) => {
    const strip = stripOf({
      requests: [request({ kind: "command", detail })],
      working: false,
      harness: "Claude Code",
    });

    expect(strip?.notice).toMatchObject({ kind: "approval", compact: false });
  });

  test("a right-to-left override can't disguise a command: each hidden mark is named", () => {
    const strip = stripOf({
      requests: [request({ kind: "command", detail: "cat \u202Egnp.exe" })],
      working: true,
      harness: "Claude Code",
    });

    expect(strip?.notice).toMatchObject({
      detail: "$ cat ⟨U+202E⟩gnp.exe",
      compact: false,
    });
  });
});

describe("a Secret Request in the strip", () => {
  const secret = request({ kind: "secret", title: "Tailscale auth key", detail: "To join" });

  test("is its own card, never an approval with Approve", () => {
    const strip = stripOf({ requests: [secret], working: true, harness: "Codex" });

    expect(strip?.notice).toMatchObject({ kind: "secret", headline: "Codex asks for a secret" });
  });

  test("once it ends, says how above Working, and alone once the Turn rests", () => {
    const settled = { request: secret, outcome: "saved" as const };

    expect(stripOf({ requests: [], working: true, harness: "Codex", settled })).toMatchObject({
      notice: { kind: "working" },
      settled,
    });
    expect(stripOf({ requests: [], working: false, harness: "Codex", settled })).toEqual({
      notice: null,
      more: 0,
      settled,
    });
  });

  test("an outcome gives way to a new request", () => {
    const settled = { request: secret, outcome: "declined" as const };
    const next = request({ id: RequestId.make("r-2"), detail: "ls" });

    expect(stripOf({ requests: [next], working: false, harness: "Codex", settled })?.settled).toBe(
      null
    );
  });
});
