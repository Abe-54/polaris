import { AppId, ComputerUseCall, TurnItem } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { completedItemView, type ItemView } from "../items.ts";
import { groupItems } from "../runs.ts";
import {
  type DesktopRun,
  liveState,
  runDetail,
  runTitle,
  stateFooter,
  stateKicker,
} from "./index.ts";

const SIMULATOR = { id: AppId.make("com.apple.iphonesimulator"), name: "Simulator" };

const NOTES = { id: AppId.make("com.apple.Notes"), name: "Notes" };

let n = 0;

const desktop = (
  tool: string,
  app: { id: AppId; name: string } | null,
  extra: { input?: unknown; output?: unknown; status?: "completed" | "failed" | "running" } = {}
): ItemView =>
  completedItemView(
    TurnItem.cases.ToolCall.make({
      id: `call-${(n += 1)}`,
      name: `mcp__polaris_desktop__${tool}`,
      kind: "mcp",
      mcp: { server: "polaris_desktop", tool },
      computerUse: app === null ? null : ComputerUseCall.make({ app, window: null, headed: false }),
      input: extra.input ?? {},
      output: extra.output ?? null,
      status: extra.status ?? "completed",
    })
  );

const thinking = (): ItemView =>
  completedItemView(
    TurnItem.cases.Reasoning.make({
      id: `think-${(n += 1)}`,
      text: "The sheet is open.",
      startedAt: null,
      endedAt: null,
    })
  );

const runs = (items: ReadonlyArray<ItemView>) =>
  groupItems(items).flatMap((entry) => (entry.kind === "desktop" ? [entry] : []));

describe("a computer use Tool Run", () => {
  test("folds consecutive calls on one app, with the thinking between them, into one line", () => {
    const [run, ...rest] = runs([
      desktop("snapshot", SIMULATOR),
      thinking(),
      desktop("click", SIMULATOR),
      desktop("press", SIMULATOR, { input: { combo: "return", app: "Simulator" } }),
    ]);

    expect(rest).toEqual([]);
    expect(run?.items.length).toBe(4);
    expect(run === undefined ? null : [runTitle(run.run), runDetail(run.run)]).toEqual([
      "Used Simulator",
      "pressed return · 3 actions",
    ]);
  });

  test("starts a new line when the agent moves to another app", () => {
    const lines = runs([
      desktop("click", SIMULATOR),
      desktop("type", NOTES),
      desktop("type", NOTES),
    ]).map((entry) => `${runTitle(entry.run)} · ${runDetail(entry.run)}`);

    expect(lines).toEqual([
      "Used Simulator · clicked · 1 action",
      "Used Notes · typed · 2 actions",
    ]);
  });

  test("a running call joins the run and names it by the app it was passed", () => {
    const [run] = runs([
      desktop("launch", null, { input: { app: "Simulator" }, status: "running" }),
    ]);

    expect(run === undefined ? null : [runTitle(run.run), runDetail(run.run)]).toEqual([
      "Using Simulator",
      "opening the app · 1 action",
    ]);
  });

  test("a locked screen is read from the Daemon's answer", () => {
    const [run] = runs([
      desktop("click", SIMULATOR, {
        status: "failed",
        output: "The screen on MacBook Pro is locked.",
      }),
    ]);

    expect(run?.run.failure).toEqual({
      kind: "locked",
      message: "The screen on MacBook Pro is locked.",
    });
  });
});

const run = (failure: DesktopRun["failure"] = null): DesktopRun => {
  const [entry] = runs([desktop("click", SIMULATOR, { status: "running" })]);

  if (entry === undefined) throw new Error("no run");

  return { ...entry.run, failure };
};

describe("the live view's state", () => {
  const base = { holder: null, sessionId: "s-1", hostLive: true, idle: null } as const;

  test.each([
    ["frames on a Mac", base, "live", "LIVE"],
    [
      "a Host without live capture",
      { ...base, hostLive: false },
      "last-frame",
      "LAST FRAME · 3S AGO",
    ],
    [
      "a refusal while another session holds the app",
      { ...base, failure: { kind: "failed", message: null }, holder: "s-2" },
      "in-use",
      "IN USE",
    ],
    [
      "a failure while this session holds the app is not in use",
      { ...base, failure: { kind: "failed", message: null }, holder: "s-1" },
      "live",
      "LIVE",
    ],
    [
      "the capture saying the screen locked",
      { ...base, idle: "screen-locked" },
      "locked",
      "LAST FRAME · 3S AGO",
    ],
  ] as const)("%s", (_, inputs, kind, kicker) => {
    const state = liveState({ failure: null, ...inputs });

    expect([state.kind, stateKicker(state, "3S AGO")]).toEqual([kind, kicker]);
  });

  test("its footer says what the agent does, or why the picture is still", () => {
    const facts = { harness: "Codex", host: "MacBook Pro", platform: "linux" as const, run: run() };

    expect([
      stateFooter({ kind: "live" }, facts),
      stateFooter({ kind: "last-frame" }, facts),
      stateFooter({ kind: "in-use", holder: "s-2" }, facts),
      stateFooter({ kind: "locked", message: null }, facts),
    ]).toEqual([
      "Codex is clicking",
      "Updates after each action on Linux",
      "Refused · Codex may retry",
      "The screen on MacBook Pro is locked.",
    ]);
  });
});
