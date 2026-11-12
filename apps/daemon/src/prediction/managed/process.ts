/**
 * The Host-side pieces the managed server needs (ADR 0049): spawning llama-server,
 * a free loopback port, its health check, resident memory and the build's extraction.
 */
import { createServer } from "node:net";
import { join } from "node:path";
import { Option, Predicate, Schema } from "effect";
import { LLAMA_BUILD } from "./catalog.ts";
import { executableOf } from "../../platform/executable.ts";
import { system32 } from "../../platform/processes.ts";

export interface ManagedProcess {
  readonly pid: number;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number | null>;
  readonly kill: () => void;
}

export type Spawn = (command: string, args: ReadonlyArray<string>, cwd: string) => ManagedProcess;

/** The discovery ports stay free for a user's own server. */
const RESERVED = new Set([8080, 1234, 11434]);

export const pickPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      // A TCP listener's address is always the object form; the string form is for pipes.
      const port = address === null || Predicate.isString(address) ? 0 : address.port;
      server.close(() =>
        RESERVED.has(port) || port === 0 ? pickPort().then(resolve, reject) : resolve(port)
      );
    });
  });

export const spawnServer: Spawn = (command, args, cwd) => {
  const child = Bun.spawn([executableOf(command), ...args], {
    cwd,
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH: cwd,
      LD_LIBRARY_PATH: cwd,
      POLARIS_HANDOFF: undefined,
      POLARIS_HOST_SOCKET: undefined,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  return {
    pid: child.pid,
    stderr: child.stderr,
    exited: child.exited.then((code) => code),
    kill: () => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      } catch {
        /* already gone */
      }
    },
  };
};

const ModelList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
});

/** Up only when `/health` is 200 and `/v1/models` lists our alias: another process on the port never counts. */
export const healthy = async (
  url: string,
  alias: string,
  signal: AbortSignal
): Promise<boolean> => {
  const init = {
    signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
    redirect: "error",
  } as const;

  try {
    const health = await fetch(`${url}/health`, init);

    if (health.status !== 200) return false;
    const models = await fetch(`${url}/v1/models`, init);

    if (models.status !== 200) return false;
    const listed = Schema.decodeUnknownOption(ModelList)(await models.json());

    return Option.isSome(listed) && listed.value.data.some((model) => model.id === alias);
  } catch {
    return false;
  }
};

export const residentBytes = async (pid: number): Promise<number | null> => {
  try {
    const ps = executableOf("ps");
    const child = Bun.spawn([ps, "-o", "rss=", "-p", String(pid)], { stdout: "pipe" });
    const text = (await new Response(child.stdout).text()).trim();
    await child.exited;
    const kib = Number(text);

    return Number.isFinite(kib) && kib > 0 ? kib * 1024 : null;
  } catch {
    return null;
  }
};

export const buildDir = (dir: string) => join(dir, `llama-${LLAMA_BUILD}`);

export const serverBinary = (dir: string) => join(buildDir(dir), "llama-server");

/** The Host's own tar; the archive was hashed against its pin before this runs. */
export const extractBuild = async (archive: string, dir: string): Promise<void> => {
  // Windows' own bsdtar: Git's GNU tar, often first on PATH, reads `C:\…` as a remote host.
  const tar = process.platform === "win32" ? system32("tar.exe") : executableOf("tar");

  const child = Bun.spawn([tar, "-xzf", archive, "-C", dir], {
    stderr: "pipe",
    stdout: "ignore",
  });

  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;

  if (code !== 0) throw new Error(stderr.trim() || `tar exited with ${code}`);
};
