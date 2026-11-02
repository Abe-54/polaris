import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ManagedServerPhase, type ManagedServerStatus } from "@polaris/protocol";
import { Match } from "effect";
import type { ManagedModel, PinnedFile } from "./catalog.ts";
import { ManagedServer, IDLE_UNLOAD_MS, type Timers } from "./server.ts";
import type { ManagedProcess, Spawn } from "./process.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const MODEL_BYTES = Buffer.from("tiny next-edit model".repeat(40));

const ASSET_BYTES = Buffer.from("tar.gz of a server build".repeat(10));

const pinned = (name: string, bytes: Buffer): PinnedFile => ({
  name,
  url: `https://publisher.example/${name}`,
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

const model: ManagedModel = {
  id: "sweep-next-edit-1.5b",
  name: "Sweep Next-Edit 1.5B",
  alias: "sweep-next-edit-1.5b-q8_0",
  sizeBytes: MODEL_BYTES.length,
  serverBytes: ASSET_BYTES.length,
  memoryBytes: 2_600_000_000,
  licence: "Apache-2.0",
  publisher: "fixture",
  file: pinned("sweep.gguf", MODEL_BYTES),
};

const ZETA_BYTES = Buffer.from("a bigger next-edit model".repeat(60));

const zeta: ManagedModel = {
  ...model,
  id: "zeta-2.1",
  name: "Zeta 2.1",
  alias: "zeta-2.1-q4_k_m",
  sizeBytes: ZETA_BYTES.length,
  memoryBytes: 8_700_000_000,
  file: pinned("zeta.gguf", ZETA_BYTES),
};

const asset = pinned("llama-fixture.tar.gz", ASSET_BYTES);

const catalog = { models: { "sweep-next-edit-1.5b": model, "zeta-2.1": zeta }, asset };

/** A clock the test advances by hand; timers fire in order of their due time. */
const fakeClock = () => {
  let now = 0;
  const pending = new Map<number, { readonly at: number; readonly run: () => void }>();
  let next = 0;

  const timers: Timers = {
    after: (run, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, run });

      return () => {
        pending.delete(id);
      };
    },
    now: () => now,
  };

  const advance = async (ms: number) => {
    const until = now + ms;

    while (true) {
      const due = [...pending.entries()]
        .filter(([, entry]) => entry.at <= until)
        .sort(([, a], [, b]) => a.at - b.at)[0];

      if (due === undefined) break;

      pending.delete(due[0]);
      now = due[1].at;
      due[1].run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    now = until;
  };

  return { timers, advance, pending: () => pending.size };
};

/** Fake llama-server processes: the test decides when each listens or dies. */
const fakeProcesses = () => {
  const spawned: Array<{
    readonly args: ReadonlyArray<string>;
    readonly exit: (code: number | null) => void;
    killed: boolean;
    healthy: boolean;
  }> = [];

  const spawn: Spawn = (_command, args) => {
    const exited = Promise.withResolvers<number | null>();

    const entry = {
      args,
      exit: (code: number | null) => exited.resolve(code),
      killed: false,
      healthy: false,
    };

    spawned.push(entry);

    const child: ManagedProcess = {
      pid: spawned.length,
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("load: ggml_metal_init\nerror: out of memory\n")
          );
          controller.close();
        },
      }),
      exited: exited.promise,
      kill: () => {
        entry.killed = true;
        exited.resolve(null);
      },
    };

    return child;
  };

  const health = async (_url: string, alias: string) =>
    (alias === model.alias || alias === zeta.alias) &&
    spawned.at(-1)?.healthy === true &&
    !spawned.at(-1)?.killed;

  return { spawn, health, spawned };
};

const scratch = () => newTempDir("pl-managed-");

/** The build and the model already in the folder, as after a finished setup. */
const installed = (dir: string) => {
  mkdirSync(join(dir, "llama-b11429"), { recursive: true });
  writeFileSync(join(dir, "llama-b11429", "llama-server"), "#!/bin/sh\n");
  writeFileSync(join(dir, "sweep.gguf"), MODEL_BYTES);
};

const make = (dir: string) => {
  const clock = fakeClock();
  const processes = fakeProcesses();
  const statuses: ManagedServerStatus[] = [];

  const server = new ManagedServer({
    defaultDir: dir,
    platform: "darwin",
    arch: "arm64",
    catalog,
    fetch: async (url) => {
      const bytes = url.endsWith(model.file.name)
        ? MODEL_BYTES
        : url.endsWith(zeta.file.name)
          ? ZETA_BYTES
          : ASSET_BYTES;

      return new Response(new Uint8Array(bytes), { status: 200 });
    },
    extract: async (_archive, target) => {
      mkdirSync(join(target, "llama-b11429"), { recursive: true });
      writeFileSync(join(target, "llama-b11429", "llama-server"), "#!/bin/sh\n");
    },
    spawn: processes.spawn,
    health: processes.health,
    timers: clock.timers,
    free: async () => 100 * 1024 ** 3,
    port: async () => 43210,
    rss: async () => 123_456_789,
  });

  server.watch((status) => statuses.push(status));

  return { server, clock, processes, statuses };
};

const phase = (status: ManagedServerStatus) => status.phase._tag;

const cases = ManagedServerPhase.cases;

const failureReason = (status: ManagedServerStatus) =>
  Match.value(status.phase).pipe(
    Match.tag("Failed", (failed) => failed.reason),
    Match.orElse(() => null)
  );

const failureLog = (status: ManagedServerStatus) =>
  Match.value(status.phase).pipe(
    Match.tag("Failed", (failed) => failed.log),
    Match.orElse(() => null)
  );

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Waits until the server has spawned `count` processes; a loaded CI runner can take longer than one settle. */
const untilSpawned = async (processes: { readonly spawned: readonly unknown[] }, count = 1) => {
  for (let i = 0; i < 1000 && processes.spawned.length < count; i++) await settle();
  expect(processes.spawned.length).toBeGreaterThanOrEqual(count);
};

/** The status once a model found in the folder has been hashed. */
const verified = async (server: ManagedServer, dir?: string) => {
  let status = await server.status(dir);

  while (phase(status) === "Verifying") {
    await settle();
    status = await server.status(dir);
  }

  return status;
};

test("setup downloads the build and the model, then the server is stopped until a request", async () => {
  const dir = scratch();

  try {
    const { server, statuses } = make(dir);
    expect(phase(await server.status())).toBe("Absent");
    await server.setup();
    expect(phase(await server.status())).toBe("Stopped");
    expect(existsSync(join(dir, "sweep.gguf"))).toBe(true);
    expect(existsSync(join(dir, "llama-b11429", "llama-server"))).toBe(true);
    expect(existsSync(join(dir, asset.name))).toBe(false);
    const seen = statuses.map(phase);
    expect(seen).toContain("Downloading");
    expect(seen.lastIndexOf("Verifying")).toBeGreaterThan(seen.indexOf("Downloading"));
    expect(server.endpoint()).toEqual({
      kind: "openai",
      url: "http://127.0.0.1:43210",
      models: [model.alias],
      managed: true,
    });
  } finally {
    removeTempDir(dir);
  }
});

test("a model already in the chosen folder is verified in the background, then counts as downloaded", async () => {
  const dir = scratch();

  try {
    installed(dir);
    const { server, statuses } = make(dir);
    expect(phase(await server.status(dir))).toBe("Verifying");
    const status = await verified(server, dir);
    expect(phase(status)).toBe("Stopped");
    expect(status.endpoint?.url).toBe("http://127.0.0.1:43210");
    expect(statuses.map(phase)).toEqual(["Verifying", "Stopped"]);
  } finally {
    removeTempDir(dir);
  }
});

test("a model file with the wrong bytes isn't downloaded, and one changed after the check refuses to start", async () => {
  const dir = scratch();

  try {
    installed(dir);
    writeFileSync(join(dir, "sweep.gguf"), Buffer.from("x".repeat(MODEL_BYTES.length)));
    const { server, processes } = make(dir);
    expect(failureReason(await verified(server))).toBe("checksum-mismatch");
    await server.remove();
    installed(dir);
    expect(phase(await verified(server))).toBe("Stopped");
    writeFileSync(join(dir, "sweep.gguf"), MODEL_BYTES.subarray(1));

    const refused = await server.start().then(
      () => null,
      (error: Error) => error.message
    );

    expect(refused).toBe(`sweep.gguf in ${dir} doesn't match its checksum`);
    expect(processes.spawned).toHaveLength(0);
    expect(failureReason(await server.status())).toBe("checksum-mismatch");
  } finally {
    removeTempDir(dir);
  }
});

test("the first request starts the server lazily and idling 15 minutes unloads it", async () => {
  const dir = scratch();

  try {
    installed(dir);
    const { server, clock, processes } = make(dir);
    await verified(server);
    const started = server.start();
    await untilSpawned(processes);
    expect(phase(await server.status())).toBe("Starting");
    expect(processes.spawned[0]?.args).toContain("--alias");
    expect(processes.spawned[0]?.args).toContain("--cache-reuse");
    processes.spawned[0]!.healthy = true;
    await clock.advance(500);
    await started;
    expect(phase(await server.status())).toBe("Serving");
    expect((await server.status()).memoryBytes).toBe(123_456_789);
    expect(server.ownsUrl("http://127.0.0.1:43210")).toBe(true);
    expect(server.ownsUrl("http://127.0.0.1:8080")).toBe(false);

    await clock.advance(IDLE_UNLOAD_MS - 1000);
    server.touch();
    await clock.advance(IDLE_UNLOAD_MS - 1000);
    expect(phase(await server.status())).toBe("Serving");
    await clock.advance(2000);
    await settle();
    expect(phase(await server.status())).toBe("Stopped");
    expect(processes.spawned[0]?.killed).toBe(true);

    const again = server.start();
    await settle();
    expect(processes.spawned).toHaveLength(2);
    processes.spawned[1]!.healthy = true;
    await clock.advance(500);
    await again;
    expect(phase(await server.status())).toBe("Serving");
  } finally {
    removeTempDir(dir);
  }
});

test("the load time is reported while it serves and forgotten once it unloads", async () => {
  const dir = scratch();

  try {
    installed(dir);
    const { server, clock, processes } = make(dir);
    await verified(server);
    expect(server.isServing()).toBe(false);
    const started = server.start();
    await untilSpawned(processes);
    expect((await server.status()).loadMs).toBeNull();
    await clock.advance(1000);
    processes.spawned[0]!.healthy = true;
    await clock.advance(500);
    await started;
    expect(server.isServing()).toBe(true);
    expect((await server.status()).loadMs).toBe(1500);

    await clock.advance(IDLE_UNLOAD_MS + 1);
    await settle();
    expect(phase(await server.status())).toBe("Stopped");
    expect((await server.status()).loadMs).toBeNull();
  } finally {
    removeTempDir(dir);
  }
});

test("a crash restarts with doubling backoff, then gives up with the server's last lines", async () => {
  const dir = scratch();

  try {
    installed(dir);
    const { server, clock, processes } = make(dir);
    await verified(server);
    const started = server.start();
    started.catch(() => {});
    await untilSpawned(processes);
    processes.spawned[0]!.healthy = true;
    await clock.advance(500);
    await started;

    processes.spawned[0]!.exit(1);
    await settle();
    expect((await server.status()).phase).toEqual(
      cases.Backoff.make({ attempt: 1, retryInMs: 1000 })
    );
    await clock.advance(999);
    expect(processes.spawned).toHaveLength(1);
    await clock.advance(1);
    await settle();
    expect(processes.spawned).toHaveLength(2);
    expect(phase(await server.status())).toBe("Starting");

    processes.spawned[1]!.exit(1);
    await settle();
    expect((await server.status()).phase).toEqual(
      cases.Backoff.make({ attempt: 2, retryInMs: 2000 })
    );

    for (const wait of [2000, 4000, 8000]) {
      await clock.advance(wait);
      await settle();
      processes.spawned.at(-1)!.exit(1);
      await settle();
    }

    const status = await server.status();
    expect(phase(status)).toBe("Failed");
    expect(failureLog(status)).toEqual(["load: ggml_metal_init", "error: out of memory"]);
    expect(processes.spawned).toHaveLength(5);
  } finally {
    removeTempDir(dir);
  }
});

test("turning it off stops the process and cancels a pending restart", async () => {
  const dir = scratch();

  try {
    installed(dir);
    const { server, clock, processes } = make(dir);
    await verified(server);
    const started = server.start();
    started.catch(() => {});
    await untilSpawned(processes);
    processes.spawned[0]!.healthy = true;
    await clock.advance(500);
    await started;
    processes.spawned[0]!.exit(1);
    await settle();
    expect(phase(await server.status())).toBe("Backoff");
    server.stop();
    expect(phase(await server.status())).toBe("Stopped");
    await clock.advance(60_000);
    await settle();
    expect(processes.spawned).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  } finally {
    removeTempDir(dir);
  }
});

test("remove deletes the model and the build and the status is absent again", async () => {
  const dir = scratch();

  try {
    installed(dir);
    const { server } = make(dir);
    expect(phase(await verified(server))).toBe("Stopped");
    await server.remove();
    expect(phase(await server.status())).toBe("Absent");
    expect(existsSync(join(dir, "sweep.gguf"))).toBe(false);
    expect(existsSync(join(dir, "llama-b11429"))).toBe(false);
  } finally {
    removeTempDir(dir);
  }
});

test("Sweep is the default everywhere; Zeta is downloaded only when asked for", async () => {
  const dir = scratch();

  try {
    const { server } = make(dir);
    expect((await server.status()).model.id).toBe("sweep-next-edit-1.5b");
    expect((await server.status(null, "zeta-2.1")).model).toMatchObject({
      id: "zeta-2.1",
      memoryBytes: zeta.memoryBytes,
    });
    await server.setup(null, "zeta-2.1");
    expect(existsSync(join(dir, "zeta.gguf"))).toBe(true);
    expect(existsSync(join(dir, "sweep.gguf"))).toBe(false);
    expect(phase(await server.status(null, "zeta-2.1"))).toBe("Stopped");
    expect(server.endpoint()?.models).toEqual([zeta.alias]);
    // Switching the preference back to Sweep reads that model's own state: not downloaded.
    expect(phase(await server.status(null, null))).toBe("Absent");
  } finally {
    removeTempDir(dir);
  }
});

test("a platform without a build, or a machine too small, is unsupported", async () => {
  const dir = scratch();

  try {
    const windows = new ManagedServer({ defaultDir: dir, platform: "win32", arch: "x64" });
    expect((await windows.status()).phase).toEqual(cases.Unsupported.make({ reason: "platform" }));

    const pi = new ManagedServer({
      defaultDir: dir,
      platform: "linux",
      arch: "arm64",
      tooSmall: true,
    });

    expect((await pi.status()).phase).toEqual(cases.Unsupported.make({ reason: "too-small" }));
    await pi.setup();
    expect((await pi.status()).phase._tag).toBe("Unsupported");
  } finally {
    removeTempDir(dir);
  }
});
