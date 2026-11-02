import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  HarnessAvailability,
  HostHarnesses,
  type HarnessStatus,
  ReviewerChoice,
  ReviewerSettings,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect } from "effect";
import { tempDir } from "../engine/testing.ts";
import { removeTempDir } from "../git/testing.ts";
import {
  EMPTY_SETTINGS,
  loadSettings,
  resolveReviewer,
  RULES_ONLY_NOTE,
  saveSettings,
} from "./settings.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const host = (statuses: Partial<Record<"claude" | "codex", HarnessStatus>>) =>
  HostHarnesses.make({
    harnesses: (["claude", "codex"] as const).map((harness) =>
      HarnessAvailability.make({
        harness,
        status: statuses[harness] ?? "not-installed",
        version: null,
        minVersion: "0.0.0",
        olderThanTested: null,
        signInKind: null,
        signInArgv: [],
        detail: null,
      })
    ),
    checkedAt: new Date(0).toISOString(),
  });

const sol = ReviewerChoice.make({ harness: "codex", model: "gpt-6.1-sol", effort: "high" });

const ws = WorkspaceId.make("ws-1");

describe("which Reviewer runs", () => {
  test("auto: Claude Code Opus 5.5 high, else Codex GPT-6.1-Sol, else Rules only", () => {
    expect(
      resolveReviewer(EMPTY_SETTINGS, ws, host({ claude: "ready", codex: "ready" })).choice
    ).toMatchObject({
      harness: "claude",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(
      resolveReviewer(EMPTY_SETTINGS, ws, host({ claude: "needs-sign-in", codex: "ready" })).choice
    ).toMatchObject({
      harness: "codex",
      model: "gpt-6.1-sol",
    });
    expect(resolveReviewer(EMPTY_SETTINGS, ws, host({}))).toMatchObject({
      choice: null,
      source: "auto",
      note: RULES_ONLY_NOTE,
    });
  });

  test("a Workspace override wins over the default, which wins over auto", () => {
    const opus = ReviewerChoice.make({
      harness: "claude",
      model: "claude-opus-5-5",
      effort: "max",
    });

    const settings = ReviewerSettings.make({ default: sol, workspaces: { [ws]: opus } });
    const ready = host({ claude: "ready", codex: "ready" });

    expect(resolveReviewer(settings, ws, ready)).toMatchObject({
      choice: opus,
      source: "workspace",
    });
    expect(resolveReviewer(settings, WorkspaceId.make("ws-2"), ready)).toMatchObject({
      choice: sol,
      source: "settings",
    });
    expect(resolveReviewer(settings, null, ready).source).toBe("settings");
  });

  test("settings persist across loads; a missing or broken file is empty", async () => {
    const dir = tempDir();
    cleanup.push(dir);
    const path = join(dir, "reviewer-settings.json");
    const settings = ReviewerSettings.make({ default: sol, workspaces: {} });

    expect(await Effect.runPromise(loadSettings(path))).toEqual(EMPTY_SETTINGS);
    await Effect.runPromise(saveSettings(path, settings));
    expect(await Effect.runPromise(loadSettings(path))).toEqual(settings);
    await Bun.write(path, "{nope");
    expect(await Effect.runPromise(loadSettings(path))).toEqual(EMPTY_SETTINGS);
  });
});
