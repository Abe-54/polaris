import { describe, expect, test } from "bun:test";
import {
  ApprovalRequest,
  BackgroundTask,
  RequestId,
  SessionId,
  SessionNotification,
  TurnId,
} from "@polaris/protocol";
import { C1, HOSTS, MODELS } from "../../sessions/preview/fixtures.ts";
import { host, hostModel, sessionWith } from "./inbox.testing.ts";
import type { WaitingSession } from "./inbox.ts";
import { notificationsOf, toSummary, turnsOf } from "./summary.ts";

describe("turnsOf", () => {
  const all = turnsOf({ hosts: HOSTS, models: MODELS, views: {} });

  const workers = new Set<string>(
    C1.constellation.attempts
      .map((a) => a.sessionId)
      .filter((id) => id !== C1.constellation.leadSessionId)
  );

  test("lists Working and Idle sessions only, with their Host and Harness names", () => {
    const local = hostModel([
      { session: sessionWith("w", { state: "working" }) },
      { session: sessionWith("n", { state: "needs-you" }) },
      { session: sessionWith("f", { state: "failed" }) },
    ]);

    const vm = hostModel([
      { session: sessionWith("i", { state: "idle", harness: "codex" }) },
      { session: sessionWith("x", { state: "archived" }) },
    ]);

    const turns = turnsOf({
      hosts: [host("local", "Mac Studio"), host("vm", "Linux VM")],
      models: { local, vm },
      views: {},
    });

    expect(turns.map((t) => [t.hostLabel, t.sessionId, t.state, t.harness])).toEqual([
      ["Mac Studio", "w", "working", "Claude Code"],
      ["Linux VM", "i", "idle", "Codex"],
    ]);
  });

  test("carries the user's Turn and the background tasks an Idle session waits on", () => {
    const tasks = [
      new BackgroundTask({ id: "b1", kind: "command", description: "bun test --watch" }),
      new BackgroundTask({ id: "b2", kind: "subagent", description: "Explore" }),
    ];

    const userTurn = { id: "t1", startedAt: "2026-10-19T09:00:00Z", prompt: "fix the login form" };

    const model = hostModel([
      { session: sessionWith("i", { state: "idle", backgroundTasks: tasks }) },
      { session: sessionWith("w", { state: "working", backgroundTasks: tasks }) },
    ]);

    const entry = model.sessions.get("i");

    if (entry === undefined) throw new Error("seeded");
    const sessions = new Map([...model.sessions, ["i", { ...entry, userTurn }]]);

    const turns = turnsOf({
      hosts: [host("local", "Mac Studio")],
      models: { local: { ...model, sessions } },
      views: {},
    });

    expect(turns.map((t) => [t.sessionId, t.backgroundTasks, t.userTurn])).toEqual([
      ["i", 2, { id: "t1", startedAt: "2026-10-19T09:00:00Z" }],
      ["w", 0, null],
    ]);
  });

  test("after a snapshot: the Daemon's user Turn, from the user's message, and its reply", () => {
    const currentUserTurn = {
      turnId: TurnId.make("t7"),
      number: 7,
      startedAt: "2026-10-19T09:00:00.000Z",
    };

    const model = hostModel([
      {
        session: sessionWith("i", {
          state: "working",
          currentUserTurn,
          lastReplyPreview: "Moved the retry into the client.",
          updatedAt: "2026-10-19T09:12:00.000Z",
        }),
      },
    ]);

    const [turn] = turnsOf({
      hosts: [host("local", "Mac Studio")],
      models: { local: model },
      views: {},
    });

    expect([turn?.userTurn, turn?.reply]).toEqual([
      { id: "t7", startedAt: "2026-10-19T09:00:00.000Z" },
      "Moved the retry into the client.",
    ]);
  });

  test("leaves out Constellation workers but keeps their Lead", () => {
    const shown = turnsOf({ hosts: HOSTS, models: MODELS, views: { local: [C1] } });

    expect(all.some((t) => workers.has(t.sessionId))).toBe(true);
    expect(shown.some((t) => workers.has(t.sessionId))).toBe(false);
    expect(shown.length).toBe(all.filter((t) => !workers.has(t.sessionId)).length);
  });

  test("marks a Lead's digest-started Turn, but not a Turn a digest was steered into", () => {
    const lead = C1.constellation.leadSessionId;
    const base = { leadSessionId: lead, revision: 1, at: "2026-10-11T12:00:00Z", items: [] };
    const host = MODELS.local;
    const entry = host.sessions.get(lead);

    if (entry === undefined) throw new Error("fixture has the Lead");

    const withTurn = (turnId: string) => ({
      ...MODELS,
      local: { ...host, sessions: new Map([[lead, { ...entry, lastTurnId: turnId }]]) },
    });

    const view = {
      ...C1,
      digests: [
        { ...base, turnId: TurnId.make("t-digest") },
        { ...base, turnId: TurnId.make("t-user"), steered: true },
      ],
    };

    const flag = (turnId: string) =>
      turnsOf({ hosts: HOSTS, models: withTurn(turnId), views: { local: [view] } }).find(
        (t) => t.sessionId === lead
      )?.digestStarted;

    expect(flag("t-digest")).toBe(true);
    expect(flag("t-user")).toBe(false);
    expect(flag("t-other")).toBe(false);
  });
});

describe("notificationsOf", () => {
  test("lists each session's latest agent notification with its session and Host", () => {
    const [id, entry] = [...MODELS.local.sessions][0] ?? [];

    if (id === undefined || entry === undefined) throw new Error("fixture has a session");

    const lastNotification = new SessionNotification({
      id: "n1",
      title: "Tests pass",
      body: "Ready",
      at: "2026-10-12T00:00:00Z",
      automatic: true,
      constellationId: "graph",
    });

    const models = {
      ...MODELS,
      local: { ...MODELS.local, sessions: new Map([[id, { ...entry, lastNotification }]]) },
    };

    expect(notificationsOf({ hosts: HOSTS, models: MODELS })).toEqual([]);
    expect(notificationsOf({ hosts: HOSTS, models })).toEqual([
      {
        hostKey: "local",
        hostLabel: HOSTS.find((h) => h.key === "local")?.label ?? "",
        sessionId: id,
        sessionTitle: entry.session.title,
        id: "n1",
        title: "Tests pass",
        body: "Ready",
        automatic: true,
        constellationId: "graph",
      },
    ]);
  });

  test("a worker named by its graph or marked by the Daemon shows none; the user's session does", () => {
    const lastNotification = new SessionNotification({
      id: "n1",
      title: "Claimed",
      body: "Ready for review",
      at: "2026-10-12T00:00:00Z",
      automatic: false,
    });

    const named = C1.constellation.attempts.find(
      (a) => a.sessionId !== C1.constellation.leadSessionId
    )?.sessionId;

    if (named === undefined) throw new Error("C1 has a worker");
    const marked = { worker: { constellationId: C1.constellation.id } };

    const model = hostModel([
      { session: sessionWith(named) },
      { session: sessionWith("marked", marked) },
      { session: sessionWith("mine") },
    ]);

    const local = {
      ...model,
      sessions: new Map(
        [...model.sessions].map(([id, entry]) => [id, { ...entry, lastNotification }])
      ),
    };

    const shown = notificationsOf({
      hosts: [host("local", "Mac Studio")],
      models: { local },
      views: { local: [C1] },
    });

    expect(shown.map((n) => `${n.sessionId}`)).toEqual(["mine"]);
  });
});

describe("toSummary", () => {
  test("a Secret Request reaches main by its label only, never its reason", () => {
    const request = new ApprovalRequest({
      id: RequestId.make("r1"),
      sessionId: SessionId.make("s1"),
      turnId: TurnId.make("s1-t1"),
      kind: "secret",
      title: "Tailscale auth key",
      detail: "Make one under Settings → Keys in the admin console",
      options: [],
      openedAt: "2026-10-30T09:00:00.000Z",
    });

    const waiting: WaitingSession = {
      key: "local:s1",
      hostKey: "local",
      hostLabel: "Mac Studio",
      workspace: "polaris",
      branch: null,
      entry: {
        session: sessionWith("s1", { state: "needs-you" }),
        pendingApprovals: [request],
        lastTurnPreview: null,
        subagents: [],
      },
      requests: [request],
      since: request.openedAt,
    };

    const summary = toSummary({
      inbox: { waiting: [waiting], also: [], answered: [], count: 1 },
      focused: null,
    });

    expect(summary.sessions[0]?.requests).toEqual([
      { requestId: "r1", kind: "secret", title: "Tailscale auth key", detail: null, options: [] },
    ]);
  });
});
