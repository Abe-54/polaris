import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Schema, Scope } from "effect";
import { acquireServer, type OpenCodeServer } from "./Server.ts";
import { bunFake } from "../testing/shellFake.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const decodeState = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, url: Schema.String }))
);

/** A fake `opencode`: `serve` answers `/global/health` behind basic auth, like the real one. */
const FAKE_OPENCODE = `if (process.env.FAKE_OPENCODE_FAIL) {
  console.error("boom");
  process.exit(1);
}
const expected = "Basic " + btoa("opencode:" + process.env.OPENCODE_SERVER_PASSWORD);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) =>
    req.headers.get("authorization") === expected
      ? Response.json({ healthy: true })
      : new Response(null, { status: 401 }),
});
console.log("opencode server listening on http://127.0.0.1:" + server.port);
`;

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const setup = () => {
  const dir = newTempDir("polaris-opencode-server-");
  const bin = bunFake(dir, "opencode", FAKE_OPENCODE);
  cleanup.push(() => removeTempDir(dir));

  return { dir, bin, stateFile: join(dir, "state", "opencode-server.json") };
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** Builds a server in its own scope, closed after the test. */
const serverIn = async (
  dir: string,
  opencodePath: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env
) => {
  const scope = await Effect.runPromise(Scope.make());
  cleanup.push(() => void Effect.runPromise(Scope.close(scope, Exit.void)));

  const server = await Effect.runPromise(
    acquireServer({
      opencodePath: () => opencodePath,
      env,
      stateDir: join(dir, "state"),
      logFile: join(dir, "logs", "opencode.log"),
      startTimeout: "10 seconds",
    }).pipe(Scope.provide(scope))
  );

  return { server, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

const lease = async (server: OpenCodeServer) => {
  const scope = await Effect.runPromise(Scope.make());
  const handle = await Effect.runPromise(server.lease.pipe(Scope.provide(scope)));

  return { handle, release: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

describe("the OpenCode server", () => {
  test("starts on the first lease, is shared, and stops with the last one", async () => {
    const { dir, bin, stateFile } = setup();
    const { server } = await serverIn(dir, bin);

    expect(await Effect.runPromise(server.running)).toBe(false);
    const first = await lease(server);
    const second = await lease(server);
    expect(second.handle.url).toBe(first.handle.url);

    const { pid } = decodeState(readFileSync(stateFile, "utf8"));
    expect(alive(pid)).toBe(true);
    expect((await fetch(`${first.handle.url}/global/health`)).status).toBe(401);
    const auth = { authorization: `Basic ${btoa(`opencode:${first.handle.password}`)}` };
    expect((await fetch(`${first.handle.url}/global/health`, { headers: auth })).status).toBe(200);
    expect(readFileSync(server.passwordFile, "utf8")).toBe(first.handle.password);

    // Windows has no mode bits; the file's ACL is ENG-314's.
    if (process.platform !== "win32")
      expect(statSync(server.passwordFile).mode & 0o777).toBe(0o600);

    await first.release();
    expect(await Effect.runPromise(server.running)).toBe(true);
    await second.release();
    expect(await Effect.runPromise(server.running)).toBe(false);
    expect(alive(pid)).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(server.passwordFile)).toBe(false);

    // A new lease starts a new server, with a new password.
    const third = await lease(server);
    expect(third.handle.password).not.toBe(first.handle.password);
    await third.release();
  });

  test("closing the layer's scope stops a server still leased", async () => {
    const { dir, bin, stateFile } = setup();
    const { server, close } = await serverIn(dir, bin);
    await lease(server);
    const { pid } = decodeState(readFileSync(stateFile, "utf8"));

    await close();

    expect(alive(pid)).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });

  // The stale server's exit handler lives on in this process (a crashed Daemon's doesn't), and on
  // Windows taskkill ends it after the new server has written the state file it then removes.
  posixTest(
    "the stale server's exit handler, alive in-process, forgets the new server's files (ENG-318)"
  )("a server left by a crashed Daemon is stopped on the next start", async () => {
    const { dir, bin, stateFile } = setup();
    const stale = await serverIn(dir, bin);
    await lease(stale.server);
    const { pid } = decodeState(readFileSync(stateFile, "utf8"));

    // A new Daemon with the same state directory; the old one never cleaned up.
    const { server } = await serverIn(dir, bin);
    const fresh = await lease(server);

    for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(20);
    expect(alive(pid)).toBe(false);
    expect(decodeState(readFileSync(stateFile, "utf8")).pid).not.toBe(pid);
    await fresh.release();
  });

  test("a server that dies is restarted by the next lease", async () => {
    const { dir, bin, stateFile } = setup();
    const { server } = await serverIn(dir, bin);
    const first = await lease(server);
    const { pid } = decodeState(readFileSync(stateFile, "utf8"));
    process.kill(pid, "SIGKILL");

    for (let i = 0; i < 100 && (await Effect.runPromise(server.running)); i++) await Bun.sleep(20);
    expect(await Effect.runPromise(server.running)).toBe(false);
    const second = await lease(server);
    expect(second.handle.url).not.toBe(first.handle.url);
    await first.release();
    expect(await Effect.runPromise(server.running)).toBe(true);
    await second.release();
  });

  test("fails without a binary, or when serve exits before listening", async () => {
    const { dir, bin, stateFile } = setup();
    const missing = await serverIn(dir, null);
    const noBinary = await Effect.runPromise(Effect.flip(Effect.scoped(missing.server.lease)));
    expect(noBinary.message).toContain("opencode was not found");

    const failing = await serverIn(dir, bin, { ...process.env, FAKE_OPENCODE_FAIL: "1" });
    const failed = await Effect.runPromise(Effect.flip(Effect.scoped(failing.server.lease)));
    expect(failed.message).toContain("exited before listening");
    expect(existsSync(stateFile)).toBe(false);
    expect(readFileSync(join(dir, "logs", "opencode.log"), "utf8")).toContain("boom");
  });
});
