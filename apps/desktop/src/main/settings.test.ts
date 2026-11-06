import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { RequestInputs } from "../shared/contract.ts";
import { DEFAULT_SESSION_PREFS, isBranchPrefix } from "../shared/sessionPrefs.ts";
import { appearanceOf, readSettings, sessionPrefsOf, type Settings } from "./settings.ts";
import { updatePolicy } from "./machines/updateFacts.ts";

test("Daemon update settings and the last result survive an app restart", () => {
  const saved: Settings = {
    keepDaemonsUpToDate: false,
    local: { enabled: false, keepDaemonUpToDate: true },
    hosts: [{ alias: "pi", keepDaemonUpToDate: false }],
    daemonUpdates: {
      pi: {
        at: 123,
        result: "failed",
        from: "0.1.0",
        version: "0.2.0",
        problem: { kind: "ssh", message: "Permission denied", command: null, sshFailure: "auth" },
      },
    },
  };

  const settings = readSettings(file(saved));

  expect(settings).toEqual(saved);
  expect(updatePolicy({}, "local").keepUpToDate).toBe(true);
  expect(updatePolicy(settings, "local").keepUpToDate).toBe(true);
  expect(updatePolicy(settings, "pi").keepUpToDate).toBe(false);
});

const file = (json: Settings) => {
  const path = join(mkdtempSync(join(tmpdir(), "polaris-settings-")), "settings.json");

  writeFileSync(path, JSON.stringify(json));

  return path;
};

test("the dark is Moonlit until Midnight is chosen, and the choice survives a restart", () => {
  expect(appearanceOf(readSettings(file({}))).darkTheme).toBe("moonlit");
  expect(appearanceOf(readSettings(file({ darkTheme: "midnight" }))).darkTheme).toBe("midnight");
});

describe("Settings → Sessions", () => {
  test("a file without them takes the defaults: in place, polaris/, Output and notifications on", () => {
    expect(sessionPrefsOf(readSettings(file({})))).toEqual(DEFAULT_SESSION_PREFS);
    expect(DEFAULT_SESSION_PREFS).toMatchObject({ newWorktree: false, branchPrefix: "polaris/" });
  });

  test("the old top-level newWorktree still reads; sessions wins over it", () => {
    expect(sessionPrefsOf(readSettings(file({ newWorktree: true }))).newWorktree).toBe(true);

    const both = readSettings(file({ newWorktree: true, sessions: { newWorktree: false } }));

    expect(sessionPrefsOf(both).newWorktree).toBe(false);
  });

  test("saved fields override the defaults one by one", () => {
    const settings = readSettings(file({ sessions: { branchPrefix: "", notifyNeedsYou: false } }));

    expect(sessionPrefsOf(settings)).toEqual({
      ...DEFAULT_SESSION_PREFS,
      branchPrefix: "",
      notifyNeedsYou: false,
    });
  });

  test("turn notifications from before long turns read every turn, at 5 minutes once chosen", () => {
    const old = sessionPrefsOf(readSettings(file({ sessions: { notifyTurnEnded: true } })));

    expect(old).toMatchObject({
      notifyTurnEnded: true,
      notifyLongTurnsOnly: false,
      longTurnMinutes: 5,
    });

    const saved = { notifyTurnEnded: true, notifyLongTurnsOnly: true, longTurnMinutes: 12 };

    expect(sessionPrefsOf(readSettings(file({ sessions: saved })))).toMatchObject(saved);
  });

  test("branch prefixes git accepts", () => {
    expect(["", "polaris/", "lucas/", "pl-", "team/agents/"].every(isBranchPrefix)).toBe(true);
    expect(["-x", "/x", "a b", "a..b", "a~", "a:", "x@{", "a\\b"].some(isBranchPrefix)).toBe(false);
  });

  test("the IPC contract refuses a prefix git wouldn't take", () => {
    const decode = Schema.decodeUnknownOption(RequestInputs["settings.setSessions"]);

    expect(decode({ patch: { branchPrefix: "lucas/" } })._tag).toBe("Some");
    expect(decode({ patch: { branchPrefix: "a b" } })._tag).toBe("None");
  });
});
