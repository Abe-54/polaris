import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId, WorkspaceId } from "@polaris/protocol";
import { BrowserTabOpener } from "../../shared/browserContract.ts";
import { openKeptTabs } from "./keptFile.ts";

let userData = "";

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "kept-"));
});

afterEach(() => rmSync(userData, { recursive: true, force: true }));

const modeOf = (path: string) => statSync(path).mode & 0o777;

const SESSION = {
  hostKey: "mac",
  // SAFETY: test ids.
  sessionId: "s1" as SessionId,
  // SAFETY: test ids.
  workspaceId: "w1" as WorkspaceId,
  tabs: [
    {
      url: "http://localhost:3000/?token=secret",
      title: null,
      openedBy: BrowserTabOpener.cases.User.make({}),
    },
  ],
  active: 0,
};

describe("kept tabs on disk", () => {
  test("a folder where tabs.json should be starts the Browser with no tabs instead of failing", () => {
    mkdirSync(join(userData, "browser", "tabs.json"), { recursive: true });

    expect(openKeptTabs(userData).read()).toEqual([]);
  });

  test("only the user can read the kept URLs", () => {
    const kept = openKeptTabs(userData);

    kept.save([SESSION]);
    kept.flush();

    expect(modeOf(join(userData, "browser"))).toBe(0o700);
    expect(modeOf(join(userData, "browser", "tabs.json"))).toBe(0o600);
    expect(openKeptTabs(userData).read()).toEqual([SESSION]);
  });

  test("a folder and file an older build left open to others are tightened on start", () => {
    const dir = join(userData, "browser");

    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(join(dir, "tabs.json"), "{}");
    chmodSync(dir, 0o755);
    chmodSync(join(dir, "tabs.json"), 0o644);

    openKeptTabs(userData).read();

    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(join(dir, "tabs.json"))).toBe(0o600);
  });
});
