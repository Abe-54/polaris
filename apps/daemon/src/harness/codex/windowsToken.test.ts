import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { system32 } from "../../platform/processes.ts";
import { ownerOf, thisUserSid } from "../../platform/windowsNative.ts";
import { isTokenName, isTrustedOwner, tokenFileOf, writeToken } from "./windowsToken.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const windows = process.platform === "win32";

const windowsOnly = test.skipIf(!windows);

/** Giving a directory to another account takes an elevated session (`icacls /setowner`). */
const elevated = windows && Bun.spawnSync([system32("net.exe"), "session"]).exitCode === 0;

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

const home = () => {
  const dir = newTempDir("pas-token-");
  dirs.push(dir);

  return dir;
};

/** The access entries `icacls` prints for `path`, without the path itself. */
const aclOf = (path: string) =>
  Bun.spawnSync([system32("icacls.exe"), path])
    .stdout.toString()
    .split(/\r?\n/)
    .map((line) => line.replace(path, "").trim())
    .filter((line) => line.includes(":("));

const LOCAL_SERVICE = "S-1-5-19";

/** A directory owned by LOCAL SERVICE, as another account that could write POLARIS_HOME leaves it. */
const foreignDir = (dir: string, files: ReadonlyArray<string>) => {
  mkdirSync(dir);

  for (const file of files) writeFileSync(join(dir, file), "planted");
  Bun.spawnSync([system32("icacls.exe"), dir, "/setowner", `*${LOCAL_SERVICE}`]);
  expect(ownerOf(dir)).toBe(LOCAL_SERVICE);
};

describe("the Codex token's owner", () => {
  const user = "S-1-5-21-1-2-3-1001";

  test("is the user, or an administrator who could read the token anyway", () => {
    expect([user, "S-1-5-32-544", "S-1-5-18"].map((sid) => isTrustedOwner(sid, user))).toEqual([
      true,
      true,
      true,
    ]);
    expect(
      ["S-1-5-21-1-2-3-1002", "S-1-5-32-545", null].map((sid) => isTrustedOwner(sid, user))
    ).toEqual([false, false, false]);
  });

  test("leaves a directory replaceable only when it holds nothing but tokens", () => {
    expect(["token", "token.0123456789abcdef"].every(isTokenName)).toBe(true);
    expect(["token.lnk", "token.x", "other", "token.0123456789ABCDEF"].some(isTokenName)).toBe(
      false
    );
  });
});

describe("the Codex token", () => {
  windowsOnly("sits in a directory only this user owns and may open, and is only theirs", () => {
    const file = tokenFileOf(join(home(), "codex-app-server.json"));
    const me = thisUserSid();

    writeToken(file);
    writeToken(file);

    expect(readFileSync(file, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    // A replaced token leaves no temporary file behind.
    expect(readdirSync(dirname(file))).toEqual(["token"]);
    // Owned by the user even in an elevated session, whose default owner is Administrators.
    expect([ownerOf(dirname(file)), ownerOf(file)]).toEqual([me, me]);
    const [dirAcl, fileAcl] = [aclOf(dirname(file)), aclOf(file)];

    // One entry each, the file's its own rather than inherited.
    expect([dirAcl.length, fileAcl.length]).toEqual([1, 1]);
    expect(dirAcl[0]).toEndWith(":(OI)(CI)(F)");
    expect(fileAcl[0]).toEndWith(":(F)");
  });

  test.skipIf(!elevated)("is never written into a directory another account owns", () => {
    const file = tokenFileOf(join(home(), "codex-app-server.json"));
    foreignDir(dirname(file), ["token", "planted.txt"]);

    expect(() => writeToken(file)).toThrow(`belongs to ${LOCAL_SERVICE}`);
    expect(readFileSync(file, "utf8")).toBe("planted");
  });

  test.skipIf(!elevated)("replaces a foreign directory that holds only a token", () => {
    const file = tokenFileOf(join(home(), "codex-app-server.json"));
    foreignDir(dirname(file), ["token"]);

    writeToken(file);

    expect(ownerOf(dirname(file))).toBe(thisUserSid());
    expect(readFileSync(file, "utf8")).toMatch(/^[0-9a-f]{64}$/);
  });
});
