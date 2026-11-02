/**
 * Connecting to the Daemon's pipe only when this user owns it (ADR 0059). The decision runs
 * everywhere over fake Win32 calls; on Windows, the real calls against a real Daemon pipe, and
 * (from an elevated process, whose `Bun.listen` pipe Administrators own) a squatter's pipe
 * that `polaris bridge` must refuse without sending it a byte.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BRIDGE_EXIT_UNTRUSTED_DAEMON } from "@polaris/protocol";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { BunSocketStream } from "../bunSocket.ts";
import { connectOwnPipe, type PipeCalls } from "./client.ts";
import { WIN32_ERROR } from "./security.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const USER = "S-1-5-21-1-2-3-1001";

/** Win32 calls for one pipe: who owns it, or the error opening it gives. */
const calls = (pipe: { owner: string } | { refused: number }) => {
  const closed: bigint[] = [];
  const adopted: bigint[] = [];
  // SAFETY: never used as a stream; the tests only compare its identity.
  const stream = Object.create(BunSocketStream.prototype) as BunSocketStream;

  const api: PipeCalls = {
    openClient: () => ("refused" in pipe ? { refused: pipe.refused } : { handle: 7n }),
    ownerSidOf: () => ("owner" in pipe ? pipe.owner : null),
    currentUserSid: () => USER,
    closeHandle: (handle) => void closed.push(handle),
    adopt: async (handle) => {
      adopted.push(handle);

      return stream;
    },
  };

  return { api, closed, adopted, stream };
};

describe("connectOwnPipe", () => {
  test("uses the very handle it checked when this user owns the pipe", async () => {
    const pipe = calls({ owner: USER });
    const result = await connectOwnPipe("\\\\.\\pipe\\x", pipe.api);

    expect(result).toEqual({ kind: "connected", stream: pipe.stream });
    expect(pipe.adopted).toEqual([7n]);
  });

  test("closes another account's pipe without ever using it", async () => {
    const pipe = calls({ owner: "S-1-5-32-544" });
    const result = await connectOwnPipe("\\\\.\\pipe\\x", pipe.api);

    expect(result).toEqual({ kind: "untrusted", owner: "S-1-5-32-544", user: USER });
    expect({ closed: pipe.closed, adopted: pipe.adopted }).toEqual({ closed: [7n], adopted: [] });
  });

  test("a pipe that refuses this user is another account's; a missing one is no Daemon", async () => {
    expect(await connectOwnPipe("p", calls({ refused: WIN32_ERROR.ACCESS_DENIED }).api)).toEqual({
      kind: "untrusted",
      owner: null,
      user: USER,
    });
    expect(await connectOwnPipe("p", calls({ refused: WIN32_ERROR.FILE_NOT_FOUND }).api)).toEqual({
      kind: "absent",
      code: WIN32_ERROR.FILE_NOT_FOUND,
    });
  });
});

const onWindows = process.platform === "win32";

const BRIDGE = join(import.meta.dir, "..", "fixtures", "bridge.ts");

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await removeTempDirSettled(home);
});

/** Whether a `Bun.listen` pipe from this process is owned by Administrators: an elevated token. */
const elevated = async (): Promise<boolean> => {
  if (!onWindows) return false;
  const name = `\\\\.\\pipe\\polaris-test-${randomUUID()}`;
  const server = Bun.listen({ unix: name, socket: { data: () => {} } });

  try {
    const { closeHandle, openClient, ownerSidOf } = await import("./win32.ts");
    const opened = openClient(name);

    if ("refused" in opened) return false;

    try {
      return ownerSidOf(opened.handle) === "S-1-5-32-544";
    } finally {
      closeHandle(opened.handle);
    }
  } finally {
    server.stop(true);
  }
};

const isElevated = await elevated();

describe.skipIf(!onWindows)("on Windows", () => {
  test("connects to a pipe the Daemon's listener made, and talks over it", async () => {
    const { listenPipe } = await import("./index.ts");
    const name = `\\\\.\\pipe\\polaris-test-${randomUUID()}`;
    const server = listenPipe(name, { data: (socket, data) => void socket.write(data) });

    try {
      const result = await connectOwnPipe(name);

      if (result.kind !== "connected") throw new Error(`not connected: ${result.kind}`);

      const echoed = new Promise<string>((resolve) =>
        result.stream.once("data", (chunk: Uint8Array) => resolve(Buffer.from(chunk).toString()))
      );

      result.stream.write(new TextEncoder().encode("ping"), () => {});

      expect(await echoed).toBe("ping");
      result.stream.end();
    } finally {
      server.stop();
    }
  });

  // Unelevated, no pipe another SID owns can be made without an administrator.
  test.skipIf(!isElevated)(
    "polaris bridge refuses a squatter's pipe and sends it nothing (needs an elevated process)",
    async () => {
      const home = newTempDir("polaris-squat-");
      homes.push(home);
      let received = 0;
      let connections = 0;

      const squatter = Bun.listen({
        unix: localEndpoint(home, "win32"),
        socket: {
          open: () => void connections++,
          data: (_socket, data) => void (received += data.byteLength),
        },
      });

      try {
        const child = Bun.spawn([process.execPath, BRIDGE, "0"], {
          env: { ...process.env, POLARIS_HOME: home },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });

        await child.stdin.write("hello, Daemon?");
        await child.stdin.flush();
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        await Bun.sleep(200);

        expect(code).toBe(BRIDGE_EXIT_UNTRUSTED_DAEMON);
        expect(stderr).toContain("is owned by S-1-5-32-544, not this user");
        expect({ received }).toEqual({ received: 0 });
        expect(connections).toBeLessThanOrEqual(1);
      } finally {
        squatter.stop(true);
      }
    }
  );
});
