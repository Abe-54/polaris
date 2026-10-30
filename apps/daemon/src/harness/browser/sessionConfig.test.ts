import { afterEach, describe, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { type ConfigFiles, realConfigFiles, sessionConfigs } from "./sessionConfig.ts";

const SESSION = SessionId.make("s1");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-sessions-"));
  dirs.push(dir);

  return dir;
};

const open = async (configs: ReturnType<typeof sessionConfigs>, url: string) => {
  const scope = Effect.runSync(Scope.make());
  const path = await Effect.runPromise(configs(SESSION, url).pipe(Scope.provide(scope)));

  return { path, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

describe("session configs", () => {
  test("an open during the last release keeps its fresh config", async () => {
    const dir = tempDir();
    let unblock = () => {};

    let blocked = false;

    const files: ConfigFiles = {
      ...realConfigFiles,
      remove: async (path) => {
        if (!blocked) {
          blocked = true;
          await new Promise<void>((resolve) => (unblock = resolve));
        }

        await realConfigFiles.remove(path);
      },
    };

    const configs = sessionConfigs(dir, files);
    const old = await open(configs, "ws://old");
    const closing = old.close();

    while (!blocked) await Bun.sleep(1);
    const replacement = open(configs, "ws://new");

    await Bun.sleep(5);
    unblock();
    await closing;
    const fresh = await replacement;

    expect(await Bun.file(fresh.path).json()).toEqual({ cdp: "ws://new" });
    await fresh.close();
    expect(existsSync(fresh.path)).toBe(false);
  });

  test("the first open sweeps configs a crashed Daemon left behind", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "dead-session.json"), '{"cdp":"ws://stale"}');
    writeFileSync(join(dir, "s1.json.0123456789abcdef.tmp"), "");

    const { path, close } = await open(sessionConfigs(dir), "ws://live");

    expect(readdirSync(dir)).toEqual(["s1.json"]);
    expect(path).toBe(join(dir, "s1.json"));
    await close();
  });

  test("a staging file is removed when its rename fails", async () => {
    const dir = tempDir();
    const target = join(dir, "s1.json");
    mkdirSync(join(target, "occupied"), { recursive: true });

    await Promise.resolve(expect(realConfigFiles.write(target, "{}")).rejects.toThrow());
    expect(readdirSync(dir)).toEqual(["s1.json"]);
  });
});
