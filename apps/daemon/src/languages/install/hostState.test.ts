import { test, expect } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Predicate, Schema } from "effect";
import { LanguageHostState } from "@polaris/protocol";
import { catalog, Tool } from "../catalog/index.ts";
import { createHostToolStates } from "./hostState.ts";
import { createHostPrerequisiteProbe } from "./hostStateProbes.ts";
import { createHostInstallations } from "./host.ts";
import { fixture, artifactFixture, hostId, platform } from "./fixture.testing.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const privateStorage = posixTest(
  "language storage is checked private by POSIX owner and mode bits; Windows needs ACL checks (ENG-314)"
);

const input = { toolIds: ["fake-tool"], refresh: false };

const signal = () => new AbortController().signal;

privateStorage(
  "Host state observes the sole installer, coalesces progress and survives service restart",
  async () => {
    let release = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const f = await fixture({
      download: async function* () {
        await gate;
        yield artifactFixture().bytes;
      },
    });

    const lifetime = new AbortController();

    const states = createHostToolStates({
      hostId,
      platform,
      tools: [Schema.decodeUnknownSync(Tool)(f.source.tool)],
      installer: f.installer,
      lifetime: lifetime.signal,
    });

    try {
      expect(
        Predicate.isTagged((await states.read(input, signal())).tools[0]!.state, "NotDownloaded")
      ).toBe(true);
      expect(f.counts().downloads).toBe(0);
      const watched = await states.watch(input, signal());
      expect(
        Predicate.isTagged(
          Schema.decodeUnknownSync(LanguageHostState)((await watched.next()).value).tools[0]!.state,
          "NotDownloaded"
        )
      ).toBe(true);

      const install = f.installer.install({
        tool: f.source.tool,
        connected: true,
        probes: [],
        intent: "encounter",
      });

      await Bun.sleep(10);

      const downloading = Schema.decodeUnknownSync(LanguageHostState)((await watched.next()).value)
        .tools[0]!.state;

      expect(Predicate.isTagged(downloading, "Downloading")).toBe(true);
      release();
      await install.result;
      const installed = Schema.decodeUnknownSync(LanguageHostState)((await watched.next()).value);

      expect(Predicate.isTagged(installed.tools[0]!.state, "Installed")).toBe(true);
      expect(Schema.is(LanguageHostState)(installed)).toBe(true);
      expect(f.counts().decodes).toBe(1);
      await watched.return?.();
      expect(states.stats().subscribers).toBe(0);
      expect(f.installer.stats().listeners).toBe(0);

      const registry = createHostInstallations();

      const recovered = await registry.get({
        hostId,
        platform,
        root: join(f.parent, "private"),
        tools: [f.source.tool],
        adapters: {
          download: () => {
            throw new Error("Read must never download");
          },
          decode: async () => f.source.payload,
        },
        observe: async () => {
          throw new Error("Read must never use execution observation");
        },
      });

      try {
        const row = (await recovered.hostState.read(input, signal())).tools[0]!;

        expect(row.state).toMatchObject({ version: "1.0.0" });
        expect(Predicate.isTagged(row.state, "Installed")).toBe(true);
      } finally {
        await registry.dispose();
      }
    } finally {
      release();
      lifetime.abort();
      await f.close();
    }
  }
);

privateStorage("failed and cancelled jobs remain visible without downloading again", async () => {
  for (const cancelled of [false, true]) {
    const f = await fixture({
      download: (_exact, incoming) =>
        (async function* () {
          if (cancelled)
            await new Promise<void>((resolve) =>
              incoming.addEventListener("abort", () => resolve(), { once: true })
            );
          yield Promise.reject(new Error("Synthetic failed download"));
        })(),
    });

    const lifetime = new AbortController();

    const states = createHostToolStates({
      hostId,
      platform,
      tools: [Schema.decodeUnknownSync(Tool)(f.source.tool)],
      installer: f.installer,
      lifetime: lifetime.signal,
    });

    try {
      const job = f.installer.install({
        tool: f.source.tool,
        connected: true,
        probes: [],
        intent: "encounter",
      });

      const result = job.result.catch(() => undefined);

      if (cancelled) {
        await Bun.sleep(10);
        job.cancel();
      }

      await result;
      await Bun.sleep(10);
      const row = (await states.read(input, signal())).tools[0]!;

      expect(Predicate.isTagged(row.state, "Failed")).toBe(true);
      expect(f.counts().downloads).toBe(0);
    } finally {
      lifetime.abort();
      await f.close();
    }
  }
});

privateStorage(
  "watchers and reads are bounded; abort releases a pending next and demand probes",
  async () => {
    const f = await fixture();
    const lifetime = new AbortController();

    const states = createHostToolStates({
      hostId,
      platform,
      tools: [Schema.decodeUnknownSync(Tool)(f.source.tool)],
      installer: f.installer,
      lifetime: lifetime.signal,
    });

    try {
      const watches = [];

      for (let i = 0; i < 16; i++) watches.push(await states.watch(input, signal()));

      await rejects(states.watch(input, signal()), { reason: "queue-full" });
      const pending = watches[0]!;
      await pending.next();
      const waiting = pending.next();
      lifetime.abort();
      expect((await waiting).done).toBe(true);
      expect(states.stats().subscribers).toBe(0);
      expect(f.installer.stats().listeners).toBe(0);
      await rejects(states.read(input, signal()), { reason: "cancelled" });
    } finally {
      lifetime.abort();
      await f.close();
    }
  }
);

test("Host probes inspect standard Python and Rust locations, never execute their files", async () => {
  const home = newTempDir("host-presence-");
  const directory = join(home, "bin");
  const probe = createHostPrerequisiteProbe({ home, directories: [directory] });

  const requirement = catalog.tools
    .find((tool) => tool.id === "pyright")!
    .requirements.find((item) => item.id === "python-interpreter")!;

  const rust = catalog.tools
    .find((tool) => tool.id === "rust-analyzer")!
    .requirements.find((item) => item.id === "rust-src")!;

  try {
    await mkdir(directory);
    await writeFile(
      join(directory, "python3.13"),
      "#!/bin/sh\necho WORKSPACE_CODE_SHOULD_NEVER_RUN > marker\n",
      { mode: 0o755 }
    );
    const batch = probe();
    const fact = await batch.probe(requirement, signal());

    expect(fact.presence).toBe("present");
    expect(fact.version).toBeNull();
    expect(await Bun.file(join(home, "marker")).exists()).toBe(false);
    await batch.probe(requirement, signal());
    expect(batch.stats().checks).toBe(1);
    const library = join(home, ".rustup/toolchains/stable/lib/rustlib/src/rust/library");
    await mkdir(library, { recursive: true });
    expect((await batch.probe(rust, signal())).presence).toBe("present");

    const missingBatch = createHostPrerequisiteProbe({
      home,
      directories: Array.from({ length: 100 }, (_, n) => join(home, `missing-${n}`)),
    })();

    expect((await missingBatch.probe(requirement, signal())).presence).toBe("unknown");
    expect(missingBatch.stats().checks).toBeLessThanOrEqual(128);
    const stopped = new AbortController();
    stopped.abort();
    await rejects(probe().probe(requirement, stopped.signal), { reason: "cancelled" });
  } finally {
    await removeTempDirSettled(home);
  }
});

test("known catalog requirements publish platform-specific commands and every managed language is offered", () => {
  expect(
    catalog.integrations.filter((item) => item.offered).flatMap((item) => item.languageIds)
  ).toEqual([
    "typescript",
    "typescriptreact",
    "javascript",
    "javascriptreact",
    "json",
    "jsonc",
    "html",
    "css",
    "scss",
    "less",
    "python",
    "shellscript",
    "bash",
    "sh",
    "php",
    "go",
    "rust",
    "lua",
    "sql",
    "prisma",
    "yaml",
    "yaml",
    "svelte",
  ]);

  const python = catalog.tools
    .find((tool) => tool.id === "pyright")!
    .requirements.find((item) => item.id === "python-interpreter")!;

  const commands = python.installCommands ?? [];

  expect(commands.map((item) => item.command)).toContain("uv python install 3.13");
  expect(
    commands
      .find((item) => item.command === "brew install python@3.13")
      ?.platforms.every((item) => item.os === "darwin")
  ).toBe(true);
  expect(
    commands
      .find((item) => item.command.startsWith("sudo apt"))
      ?.platforms.every((item) => item.os === "linux" && item.libc === "glibc")
  ).toBe(true);
  expect(
    catalog.tools
      .find((tool) => tool.id === "rust-analyzer")!
      .requirements.find((item) => item.id === "cargo")!.installCommands?.[0]?.command
  ).toContain("--component rust-src");
});

test("read deadlines and concurrent limits release all bounded demand work", async () => {
  const lifetime = new AbortController();

  const states = createHostToolStates({
    timeoutMs: 20,
    hostId,
    platform,
    tools: [Schema.decodeUnknownSync(Tool)(artifactFixture().tool)],
    lifetime: lifetime.signal,
    installer: {
      current: () => new Promise(() => {}),
      recoveryFacts: async () => [],
      progress: () => null,
      subscribe: () => () => {},
    },
  });

  const reads = Array.from({ length: 4 }, () => states.read(input, signal()));
  const results = Promise.all(reads.map((read) => rejects(read, { reason: "timeout" })));

  await rejects(states.read(input, signal()), { reason: "queue-full" });
  expect(states.stats().readers).toBe(4);
  await results;
  expect(states.stats().readers).toBe(0);
  lifetime.abort();
});

test("prerequisites refresh on demand and a refresh publishes to an existing Host feed", async () => {
  const lifetime = new AbortController();
  let probes = 0;
  let present = false;
  const python = catalog.tools.find((tool) => tool.id === "ruff")!;

  const states = createHostToolStates({
    hostId,
    platform,
    tools: [python],
    lifetime: lifetime.signal,
    probes: () => ({
      probe: async () => {
        probes++;

        return { presence: present ? "present" : "missing", path: null, version: null };
      },
      stats: () => ({ checks: probes }),
    }),
    installer: {
      current: async () => null,
      recoveryFacts: async () => [],
      progress: () => null,
      subscribe: () => () => {},
    },
  });

  const selection = { toolIds: ["ruff"], refresh: false };
  const watch = await states.watch(selection, signal());
  await watch.next();

  expect(probes).toBe(1);
  present = true;
  await states.read(selection, signal());
  expect(probes).toBe(1);
  await watch.next();
  await states.read({ ...selection, refresh: true }, signal());

  const update = Schema.decodeUnknownSync(LanguageHostState)((await watch.next()).value);

  expect(update.tools[0]?.prerequisites[0]?.presence).toBe("present");
  expect(probes).toBe(2);
  await watch.return?.();
  lifetime.abort();
});

test("Host snapshots share private Node verification only within one read and bound parallel rows", async () => {
  const source = artifactFixture().tool;
  const calls = new Map<string, number>();
  let active = 0;
  let peak = 0;

  const tools = ["node", "one", "two", "three", "four", "five"].map((id) =>
    Schema.decodeUnknownSync(Tool)({
      ...source,
      id,
      requirements:
        id === "node"
          ? []
          : [
              {
                id: "node",
                scope: "server",
                executable: "node",
                version: ">=24.18.0",
                detail: "Private Node",
                required: true,
              },
            ],
    })
  );

  const states = createHostToolStates({
    hostId,
    platform,
    tools,
    lifetime: signal(),
    installer: {
      current: async (id) => {
        calls.set(id, (calls.get(id) ?? 0) + 1);
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(5);
        active--;

        return null;
      },
      progress: () => null,
      recoveryFacts: async () => [],
      subscribe: () => () => {},
    },
  });

  const first = await states.read({ toolIds: [], refresh: true }, signal());

  expect(first.tools.map((row) => row.toolId)).toEqual(tools.map((tool) => tool.id));
  expect(calls.get("node")).toBe(1);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  await states.read({ toolIds: [], refresh: false }, signal());
  expect(calls.get("node")).toBe(2);
  expect(states.stats().readers).toBe(0);
});

test("a Host row verifies its package while prerequisite observation is pending", async () => {
  let release = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const tool = Schema.decodeUnknownSync(Tool)({
    ...artifactFixture().tool,
    requirements: [
      {
        id: "python-interpreter",
        scope: "project",
        executable: "python",
        version: "present",
        detail: "Python",
        required: true,
      },
    ],
  });

  const states = createHostToolStates({
    hostId,
    platform,
    tools: [tool],
    lifetime: signal(),
    probes: () => ({
      probe: async () => {
        await gate;

        return { presence: "present", path: "/usr/bin/python3", version: null };
      },
      stats: () => ({ checks: 1 }),
    }),
    installer: {
      current: async () => {
        release();

        return null;
      },
      progress: () => null,
      recoveryFacts: async () => [],
      subscribe: () => () => {},
    },
  });

  const result = await states.read({ toolIds: [tool.id], refresh: true }, signal());
  expect(result.tools[0]?.prerequisites[0]?.presence).toBe("present");
  expect(Predicate.isTagged(result.tools[0]?.state, "NotDownloaded")).toBe(true);
});
