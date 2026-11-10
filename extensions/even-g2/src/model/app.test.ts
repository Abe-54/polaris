import { describe, expect, test } from "bun:test";
import type { HostView } from "@polaris/sdk";
import { type AppState, initialState, type Input, onHosts, onInput, onTranscript } from "./app.ts";
import { approval, entry, host, session } from "./fixtures.testing.ts";
import { layout } from "./layout.ts";
import { menuFor } from "./menu.ts";
import { rowLabel, sessionRows } from "./sessions.ts";

const press = (state: AppState, ...inputs: ReadonlyArray<Input>) =>
  inputs.reduce<{ state: AppState; acts: Array<unknown> }>(
    (acc, input) => {
      const [next, act] = onInput(acc.state, input);

      return { state: next, acts: act === null ? acc.acts : [...acc.acts, act] };
    },
    { state, acts: [] }
  );

const click = (index = 0): Input => ({ kind: "click", index });

describe("the Sessions screen", () => {
  test("lists Needs You first, then Working, then Idle, newest first within each", () => {
    const hosts = [
      host("h1", [
        entry(session("idle-new", "idle", { updated: 9 })),
        entry(session("working", "working", { updated: 5 })),
        entry(session("archived", "archived", { updated: 10 })),
      ]),
      host("h2", [
        entry(session("idle-old", "idle", { updated: 1 })),
        entry(session("needs-you", "needs-you", { updated: 0 })),
        entry(session("starting", "starting", { updated: 7 })),
      ]),
    ];

    expect(sessionRows(hosts).map((row) => row.key.sessionId)).toEqual([
      "needs-you",
      "starting",
      "working",
      "idle-new",
      "idle-old",
    ]);
  });

  test("names the Host only when several are paired, and fits a 63-byte row", () => {
    const [row] = sessionRows([
      host("h1", [entry(session("s1", "needs-you", { title: "x".repeat(80) }))], "Mac Studio"),
    ]);

    if (row === undefined) throw new Error("no row");
    expect(rowLabel(row, false)).toStartWith("Needs you · xxx");
    expect(new TextEncoder().encode(rowLabel(row, false)).byteLength).toBe(63);
    expect(
      rowLabel({ ...row, entry: entry(session("s1", "idle", { title: "Fix it" })) }, true)
    ).toBe("Idle · Fix it · Mac Studio");
  });

  test("a tap opens the selected session; double-tap asks to exit", () => {
    const state = onHosts(initialState(true), [
      host("h1", [
        entry(session("a", "idle", { updated: 2 })),
        entry(session("b", "idle", { updated: 1 })),
      ]),
    ]);

    expect(press(state, click(1)).state.screen).toEqual({
      kind: "session",
      key: { hostId: "h1", sessionId: "b" },
    });
    expect(press(state, { kind: "double-click" }).acts).toEqual([{ kind: "exit" }]);
  });
});

describe("the menu", () => {
  test("offers Approve and Deny for a command, and the options of a question with their full text", () => {
    const command = menuFor(entry(session("s", "needs-you"), [approval("r1", "s")]), null);
    const longOption = `Use ${"the long way ".repeat(8)}`;

    const question = menuFor(
      entry(session("s", "needs-you"), [
        approval("r2", "s", { kind: "question", options: ["Yes", longOption] }),
      ]),
      null
    );

    expect(command.map((item) => item.label)).toEqual(["Approve", "Deny", "Interrupt"]);
    expect(question.map((item) => item.label).slice(0, 3)).toEqual([
      "Yes",
      "Use the long way the long way the long way the long way the…",
      "Speak an answer",
    ]);
    expect(question[1]?.action).toEqual({ kind: "answer", requestId: "r2", text: longOption });
  });

  const REPLIES = [
    "Reply: Go ahead",
    "Reply: Run the tests",
    "Reply: Summarize where you are",
    "Speak a reply",
  ];

  // Interrupt only while a Turn runs; Needs You with nothing pending is a Turn a restart interrupted.
  test.each([
    { case: "working", state: "working", pending: false, last: null, expected: ["Interrupt"] },
    {
      case: "waiting on an approval",
      state: "needs-you",
      pending: true,
      last: null,
      expected: ["Approve", "Deny", "Interrupt"],
    },
    {
      case: "interrupted by a restart",
      state: "needs-you",
      pending: false,
      last: "interrupted",
      expected: ["Continue", ...REPLIES],
    },
    {
      case: "interrupted, before its Turn is loaded",
      state: "needs-you",
      pending: false,
      last: null,
      expected: ["Continue", ...REPLIES],
    },
    {
      case: "at a usage limit",
      state: "limited",
      pending: false,
      last: null,
      expected: ["Continue", ...REPLIES],
    },
    {
      case: "idle after an interrupt",
      state: "idle",
      pending: false,
      last: "interrupted",
      expected: ["Continue", ...REPLIES],
    },
    { case: "idle", state: "idle", pending: false, last: "completed", expected: REPLIES },
  ] as const)("the actions for a session $case", ({ state, pending, last, expected }) => {
    const value = entry(session("s", state), pending ? [approval("r1", "s")] : []);

    expect(menuFor(value, last).map((item) => item.label)).toEqual([...expected]);
  });

  test("a chosen action runs against the session and returns to it", () => {
    const hosts = [host("h1", [entry(session("s", "needs-you"), [approval("r1", "s")])])];
    const key = { hostId: "h1", sessionId: "s" };

    const state = {
      ...onHosts(initialState(true), hosts),
      screen: { kind: "session", key } as const,
    };

    const { state: after, acts } = press(state, click(), click(1));

    expect(acts).toEqual([{ kind: "run", key, action: { kind: "deny", requestId: "r1" } }]);
    expect(after.screen).toEqual({ kind: "session", key });
  });
});

describe("computer use approvals (CU4)", () => {
  test.each([
    { kind: "app", line: "Use Simulator?" },
    { kind: "headed-input", line: "Take mouse and keyboard? · Simulator" },
  ] as const)("$kind asks '$line' and offers Allow once and Deny, never an always", (c) => {
    const waiting = entry(session("s", "needs-you"), [
      approval("r1", "s", { kind: c.kind, app: "Simulator" }),
    ]);

    const state = {
      ...onHosts(initialState(true), [host("h1", [waiting])]),
      screen: { kind: "session", key: { hostId: "h1", sessionId: "s" } },
    } as const;

    expect(layout(state).texts[0]?.content).toContain(c.line);
    expect(menuFor(waiting, null).map((item) => [item.label, item.action])).toEqual([
      ["Allow once", { kind: "allow", requestId: "r1" }],
      ["Deny", { kind: "deny", requestId: "r1" }],
      ["Interrupt", { kind: "interrupt" }],
    ]);
  });
});

describe("an approval arriving while the app is open", () => {
  const idle = entry(session("s", "idle"));

  const waiting = entry(session("s", "needs-you", { updated: 3 }), [
    approval("r1", "s", { opened: 3 }),
  ]);

  const other = entry(session("o", "idle"));
  const before: ReadonlyArray<HostView> = [host("h1", [idle, other])];
  const after: ReadonlyArray<HostView> = [host("h1", [waiting, other])];

  test("jumps to its session; approvals already there at launch don't", () => {
    const launched = onHosts(initialState(true), after);

    const browsing = {
      ...onHosts(initialState(true), before),
      screen: { kind: "session", key: { hostId: "h1", sessionId: "o" } } as const,
    };

    expect(launched.screen).toEqual({ kind: "sessions" });
    expect(onHosts(browsing, after).screen).toEqual({
      kind: "session",
      key: { hostId: "h1", sessionId: "s" },
    });
  });

  test("waits while voice is in use, then jumps once the voice screen closes", () => {
    const opened = press(
      {
        ...onHosts(initialState(true), before),
        screen: { kind: "session", key: { hostId: "h1", sessionId: "o" } },
      },
      {
        kind: "long-press",
      }
    ).state;

    const arrived = onHosts(opened, after);

    expect(arrived.screen.kind).toBe("voice");
    expect(press(arrived, { kind: "double-click" }).state.screen).toEqual({
      kind: "session",
      key: { hostId: "h1", sessionId: "s" },
    });
  });
});

describe("voice", () => {
  const key = { hostId: "h1", sessionId: "s" };

  const at = (entries = [entry(session("s", "idle"))]) => ({
    ...onHosts(initialState(true), [host("h1", entries)]),
    screen: { kind: "session", key } as const,
  });

  test("holding listens, releasing stops, and nothing is sent until Send", () => {
    const listening = press(at(), { kind: "long-press" }, { kind: "long-press-release" });

    const heard = onTranscript(listening.state, {
      finalText: "run the tests",
      interimText: "",
      finished: true,
    });

    expect(listening.acts).toEqual([{ kind: "listen", key }, { kind: "stop-listening" }]);
    expect(heard.screen).toMatchObject({ kind: "voice", voice: { phase: "review" } });
    expect(press(heard, click(2)).acts).toEqual([]);
    expect(press(heard, click(0)).acts).toEqual([
      { kind: "send-voice", key, text: "run the tests", requestId: null },
    ]);
  });

  test("answers an open question instead of sending a Turn", () => {
    const asking = at([
      entry(session("s", "needs-you"), [approval("q1", "s", { kind: "question" })]),
    ]);

    const listening = press(asking, { kind: "long-press" }).state;

    const heard = onTranscript(listening, {
      finalText: "the second one",
      interimText: "",
      finished: true,
    });

    expect(press(heard, click(0)).acts).toEqual([
      { kind: "send-voice", key, text: "the second one", requestId: "q1" },
    ]);
  });

  test("an empty transcript offers Retry instead of Send", () => {
    const listening = press(at(), { kind: "long-press" }).state;
    const empty = onTranscript(listening, { finalText: " ", interimText: "", finished: true });

    expect(empty.screen).toMatchObject({
      voice: { phase: "failed", error: "Didn't catch anything" },
    });
    expect(press(empty, click(0)).acts).toEqual([{ kind: "listen", key }]);
  });

  test("shows interim text live", () => {
    const listening = press(at(), { kind: "long-press" }).state;

    const page = layout(
      onTranscript(listening, { finalText: "run the ", interimText: "tes", finished: false })
    );

    expect(page.texts[0]?.content).toContain("run the tes");
  });
});

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

describe("the glasses' limits, which count UTF-8 bytes", () => {
  // The firmware refuses a whole page over one long row, and the glasses then stay blank.
  test.each([
    { title: "Fix the flaky test in the gateway's reconnect path after a Daemon restart" },
    { title: "Résumé · naïve café ".repeat(5) },
    { title: "修复网关重连路径中的不稳定测试，并在守护进程重启后验证" },
    { title: "🚀".repeat(40) },
  ])("every row fits in 63 bytes: $title", ({ title }) => {
    const options = ["Yes · run it", `${title} ${title}`];

    const hosts = [
      host("h1", [
        entry(session("s", "needs-you", { title }), [
          approval("r1", "s", { kind: "question", options }),
        ]),
      ]),
      host("h2", [entry(session("t", "idle", { title }))], `Lucas-Mac-Studio · ${title}`),
    ];

    const base = onHosts(initialState(true), hosts);
    const key = { hostId: "h1", sessionId: "s" };

    const pages = [base, press({ ...base, screen: { kind: "session", key } }, click()).state].map(
      layout
    );

    const rows = pages.flatMap((page) => page.lists.flatMap((list) => list.items));

    expect(rows.length).toBeGreaterThan(2);
    expect(rows.filter((row) => bytes(row) > 63)).toEqual([]);
  });

  test("a long approval stays under the 1,000 bytes a page may hold", () => {
    const long = approval("r1", "s", { title: "ÿ·".repeat(3000) });

    const state = {
      ...onHosts(initialState(true), [host("h1", [entry(session("s", "needs-you"), [long])])]),
      screen: { kind: "session", key: { hostId: "h1", sessionId: "s" } } as const,
    };

    const content = layout(state).texts[0]?.content ?? "";

    expect(bytes(content)).toBeLessThanOrEqual(1000);
    expect(content).toEndWith("Tap: actions · hold: speak · double-tap: back");
  });

  test("a planning session's page says Plan beside its state; a supervised one doesn't", () => {
    const status = (permissionMode: "plan" | "supervised") =>
      layout({
        ...onHosts(initialState(true), [
          host("h1", [entry(session("s", "idle", { permissionMode }))], "Mac"),
        ]),
        screen: { kind: "session", key: { hostId: "h1", sessionId: "s" } },
      }).texts[0]?.content.split("\n")[1];

    expect(status("plan")).toBe("Idle · Plan · Mac");
    expect(status("supervised")).toBe("Idle · Mac");
  });

  test("every screen has exactly one container taking input", () => {
    const hosts = [host("h1", [entry(session("s", "needs-you"), [approval("r1", "s")])])];
    const key = { hostId: "h1", sessionId: "s" };
    const base = onHosts(initialState(true), hosts);

    const listening = press(
      { ...base, screen: { kind: "session", key } },
      { kind: "long-press" }
    ).state;

    const states: ReadonlyArray<AppState> = [
      initialState(false),
      initialState(true),
      base,
      { ...base, screen: { kind: "session", key } },
      press({ ...base, screen: { kind: "session", key } }, click()).state,
      listening,
      onTranscript(listening, { finalText: "hi", interimText: "", finished: true }),
    ];

    for (const state of states) {
      const page = layout(state);

      expect([...page.texts, ...page.lists].filter((box) => box.capture)).toHaveLength(1);
    }
  });
});

test.each([null, "original"])(
  "voice keeps its original target (%s) if a question changes before Send",
  (requestId) => {
    const key = { hostId: "h", sessionId: "s" };
    const original = requestId === null ? [] : [approval(requestId, "s", { kind: "question" })];
    const base = onHosts(initialState(true), [host("h", [entry(session("s", "idle"), original)])]);

    const listening = press(
      { ...base, screen: { kind: "session", key } },
      { kind: "long-press" }
    ).state;

    const heard = onTranscript(listening, { finalText: "yes", interimText: "", finished: true });

    const changed = onHosts(heard, [
      host("h", [entry(session("s", "needs-you"), [approval("new", "s", { kind: "question" })])]),
    ]);

    const sent = press(changed, click(0));
    expect(sent.acts).toEqual([]);
    expect(sent.state.screen).toMatchObject({
      voice: { phase: "failed", error: "The question changed. Cancel and open the session again." },
    });
  }
);
