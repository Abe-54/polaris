import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { checksPipeOwner } from "../transport.ts";
import {
  connectOwnedPipe,
  isPipePath,
  ownerVerdict,
  PIPE_ERROR,
  type PipeApi,
  type PipeHandle,
  type PipeOpened,
} from "./index.ts";
import { CLIENT_OPEN_FLAGS, grantsImpersonation } from "./trust.ts";

const USER = "S-1-5-21-1-2-3-1001";

const PIPE = "\\\\.\\pipe\\polaris-test";

// SAFETY: the fake API never reads a handle; any object stands in for one.
const fakeHandle = {} as PipeHandle;

/** A Windows that answers `opens` in turn and says the pipe is owned by `owner`. */
const fakeWindows = (opens: ReadonlyArray<PipeOpened>, owner: string | null) => {
  const seen = { opens: 0, closed: 0, adopted: 0 };

  const api: PipeApi = {
    open: () => opens[Math.min(seen.opens++, opens.length - 1)]!,
    ownerSid: () => owner,
    userSid: () => USER,
    adopt: () => {
      seen.adopted++;

      return -1;
    },
    close: () => {
      seen.closed++;
    },
  };

  return { api, seen };
};

const refusal = (windows: ReturnType<typeof fakeWindows>, home?: string) =>
  Effect.runPromise(Effect.flip(connectOwnedPipe(PIPE, home, windows.api)));

describe("the owner check, as data", () => {
  test("the Client opens the pipe for identification only, never impersonation", () => {
    expect(grantsImpersonation(CLIENT_OPEN_FLAGS)).toBe(false);
    // Without SQOS Windows grants impersonation; delegation (0x30000) grants it too.
    expect(grantsImpersonation(0x4000_0000)).toBe(true);
    expect(grantsImpersonation(0x4000_0000 | 0x0010_0000 | 0x0003_0000)).toBe(true);
  });

  test("names only Windows pipes, in either prefix", () => {
    expect(
      [PIPE, "\\\\?\\pipe\\x", "/h/.polaris/daemon.sock", "C:\\pipe\\x"].map(isPipePath)
    ).toEqual([true, true, false, false]);
  });

  test("trusts the user's own pipe and refuses any other owner, or none", () => {
    expect(ownerVerdict(PIPE, USER, USER)).toBeNull();
    expect(ownerVerdict(PIPE, "S-1-5-32-544", USER)?.reason).toBe("daemon-untrusted");
    expect(ownerVerdict(PIPE, null, USER)?.reason).toBe("daemon-untrusted");
  });

  test("refuses to compare against something that isn't a SID", () => {
    expect(() => ownerVerdict(PIPE, "", "")).toThrow("not a SID");
  });

  test("is on only for a pipe on Windows under Node", () => {
    expect(checksPipeOwner(PIPE, "win32", false)).toBe(true);
    expect(checksPipeOwner(PIPE, "win32", true)).toBe(false);
    expect(checksPipeOwner(PIPE, "darwin", false)).toBe(false);
    expect(checksPipeOwner("/h/.polaris/daemon.sock", "win32", false)).toBe(false);
  });
});

describe("connectOwnedPipe against a scripted Windows", () => {
  test("another owner's pipe is closed unread and never becomes a socket", async () => {
    const windows = fakeWindows([{ handle: fakeHandle }], "S-1-5-7");
    const error = await refusal(windows);

    expect(error.reason).toBe("daemon-untrusted");
    expect(error.detail).toContain("S-1-5-7");
    expect(windows.seen).toMatchObject({ closed: 1, adopted: 0 });
  });

  test("a pipe that refuses this account is someone else's daemon", async () => {
    const error = await refusal(fakeWindows([{ refused: PIPE_ERROR.ACCESS_DENIED }], USER));

    expect(error.reason).toBe("daemon-untrusted");
  });

  test("no pipe with nothing installed asks for the install", async () => {
    const home = mkdtempSync(join(tmpdir(), "polaris-pipe-"));
    mkdirSync(join(home, ".polaris"));

    const error = await refusal(fakeWindows([{ refused: PIPE_ERROR.FILE_NOT_FOUND }], USER), home);

    expect(error.reason).toBe("polaris-not-installed");
  });

  test("a busy pipe is retried until an instance frees up", async () => {
    const busy = { refused: PIPE_ERROR.PIPE_BUSY };
    const windows = fakeWindows([busy, busy, { handle: fakeHandle }], USER);
    // The scripted adopt refuses, so the run ends right after the handle passed the check.
    const error = await refusal(windows);

    expect(windows.seen).toMatchObject({ opens: 3, adopted: 1, closed: 1 });
    expect(error.detail).toContain("libuv refused");
  });

  test("a pipe that stays busy fails as transient, to be retried later", async () => {
    const error = await refusal(fakeWindows([{ refused: PIPE_ERROR.PIPE_BUSY }], USER));

    expect(error).toMatchObject({ kind: "transient", reason: "connection-failed" });
  });
});

const node = Bun.which("node");

interface Line {
  readonly scenario: string;
  readonly echoed?: string;
  readonly refused?: string;
  readonly detail?: string;
  readonly owner?: string | null;
  readonly user?: string;
  /** Set when the scenario can't run in this session (no elevation). */
  readonly skipped?: string;
}

/** Bundles the harness next to this package's node_modules (for koffi) and runs it under Node. */
const runHarness = async (): Promise<ReadonlyArray<Line>> => {
  const outdir = join(import.meta.dir, "../../node_modules/.cache/owned-pipe-harness");

  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "ownedPipe.harness.ts")],
    outdir,
    target: "node",
    format: "esm",
    external: ["koffi"],
    naming: "[name].mjs",
  });

  if (!built.success) throw new Error(built.logs.map((entry) => entry.message).join("\n"));

  const run = Bun.spawnSync([node!, join(outdir, "ownedPipe.harness.mjs")], { stderr: "pipe" });

  if (run.exitCode !== 0) throw new Error(run.stderr.toString());

  // SAFETY: the harness prints one JSON `Line` per scenario.
  return run.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Line);
};

describe.skipIf(process.platform !== "win32" || node === null)(
  "connectOwnedPipe on Windows, under Node as in the Desktop App",
  () => {
    test("speaks through this user's pipe and refuses another owner's, never writing to it", async () => {
      const lines = await runHarness();
      const byName = new Map(lines.map((line) => [line.scenario, line]));

      expect(byName.get("this user's pipe")?.echoed).toBe("echo:hi");
      expect(byName.get("no pipe")?.refused).toBe("daemon-not-running");

      const administrators = byName.get("a pipe Administrators own");

      if (administrators?.skipped === undefined) {
        expect(administrators).toMatchObject({ refused: "daemon-untrusted" });
        expect(administrators?.detail).toContain("S-1-5-32-544");
      }

      // Node's own pipe is the user's, except that an elevated token's default owner is BA.
      const nodePipe = byName.get("a Node pipe");
      const ours = nodePipe?.owner === nodePipe?.user;

      expect(nodePipe).toMatchObject(
        ours ? { echoed: "no server end" } : { refused: "daemon-untrusted" }
      );
    }, 60_000);
  }
);
