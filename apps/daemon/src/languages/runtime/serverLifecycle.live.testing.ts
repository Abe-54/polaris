import { expect, test } from "bun:test";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Predicate } from "effect";
import * as P from "@polaris/protocol";
import { createProjectDiscovery } from "../discovery/index.ts";
import { createLanguageBroker } from "./index.ts";
import { spawnLanguageProcess } from "./process.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const required = (key: string) => {
  const path = process.env[key];

  if (!path?.startsWith("/")) throw new Error(`Set ${key} to an existing absolute path`);

  return path;
};

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }

  throw new Error("Live lifecycle deadline");
}

test("real TS6 kills exhaust budget; manual recovery, config diagnostics and idle stop retain drafts", async () => {
  const root = newTempDir("polaris-lifecycle-live-", { short: true });

  const checkout = P.LanguageCheckout.cases.Workspace.make({
    workspaceId: P.WorkspaceId.make("live"),
    path: root,
  });

  const discovery = createProjectDiscovery({
    registry: async () => ({ checkout, workspacePath: root }),
  });

  const processes: ReturnType<typeof spawnLanguageProcess>[] = [];

  const broker = createLanguageBroker({
    hostId: P.HostId.make("live"),
    discover: (input) => discovery.discover(input),
    invalidateDiscovery: discovery.invalidate,
    requireTrust: async () => ({ checkout, root, workspaceRoot: root }),
    reserveLaunch: async () => ({
      selectionIdentity: "live-ts6",
      validate: async () => {},
      assertCurrent: () => {},
      release: async () => {},
    }),
    resolveLaunch: async () => ({
      executable: required("M31_NODE_EXECUTABLE"),
      args: [required("M31_TYPESCRIPT_SERVER"), "--stdio"],
      cwd: root,
      environment: { NODE_OPTIONS: "", NODE_PATH: "" },
      initializationOptions: {
        tsserver: { path: join(root, "node_modules/typescript/lib/tsserver.js") },
      },
    }),
    spawn: (launch) => {
      const port = spawnLanguageProcess(launch);
      processes.push(port);

      return port;
    },
    graceMs: 100,
    retryMs: 30,
    changeDebounceMs: 60,
  });

  const settings = P.LanguageEffectiveSettings.make({
    settings: {},
    revision: 0,
    formatOnSave: true,
    formatter: P.LanguageFormatterSelection.cases.None.make({}),
    providers: ["typescript-language-server"],
    origins: {},
  });

  const input = {
    clientId: "live",
    contextId: "live",
    interestId: "file",
    checkout,
    path: join(root, "a.ts"),
    providerId: "typescript-language-server",
    settings,
  };

  const uri = pathToFileURL(input.path).href;
  const acquire = () => broker.acquire("live", input);
  const ready = () => until(async () => Predicate.isTagged((await acquire()).runtime, "Ready"));

  try {
    await mkdir(join(root, "node_modules"));
    await cp(required("M31_TYPESCRIPT_PACKAGE"), join(root, "node_modules/typescript"), {
      recursive: true,
      dereference: true,
    });
    await writeFile(input.path, "const saved = 1;");
    await writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":false}}');
    let current = await acquire();
    const baselineAbort = new AbortController();

    const baselineFeed = broker
      .watch("live", current.context, baselineAbort.signal)
      [Symbol.asyncIterator]();

    const baselineDiagnostics = (async () => {
      for (;;) {
        const next = await baselineFeed.next();

        if (next.done) throw new Error("Baseline diagnostic feed ended");

        if (Predicate.isTagged(next.value, "Diagnostics")) return next.value.diagnostics.items;
      }
    })();

    await broker.sync("live", {
      context: current.context,
      sequence: 1,
      notification: P.LanguageDocumentNotification.cases.Open.make({
        uri,
        languageId: "typescript",
        version: 1,
        text: "const unsaved: string = null;\nunsaved;",
      }),
    });
    await ready();

    try {
      const before = await Promise.race([
        baselineDiagnostics,
        Bun.sleep(15000).then(() => {
          throw new Error("No baseline diagnostics");
        }),
      ]);

      expect(before.some((d) => String(d.code) === "2322")).toBe(false);
    } finally {
      baselineAbort.abort();
      await baselineFeed.return?.();
    }

    for (let i = 0; i < 3; i++) {
      process.kill(processes[i]!.pid, "SIGKILL");
      await processes[i]!.exited;

      if (i < 2) {
        await until(() => processes.length === i + 2);
        await ready();
      }
    }

    await until(async () => Predicate.isTagged((await acquire()).runtime, "Stopped"));
    current = await acquire();
    const stoppedRuntime = current.runtime;
    expect(Predicate.isTagged(stoppedRuntime, "Stopped")).toBe(true);

    if (!Predicate.isTagged(stoppedRuntime, "Stopped")) throw new Error("Missing stopped fact");
    expect(stoppedRuntime.reason).toBe("crash-budget");
    expect(stoppedRuntime.failure?.attempts).toBe(3);
    expect(stoppedRuntime.failure?.stderr).toBeString();
    expect(current.ack.documents).toHaveLength(1);
    current = await broker.restart("live", current.context);
    await ready();
    current = await acquire();
    const abort = new AbortController();
    const iterator = broker.watch("live", current.context, abort.signal)[Symbol.asyncIterator]();

    const diagnostics = (async () => {
      for (;;) {
        const next = await iterator.next();

        if (next.done) throw new Error("Diagnostic feed ended");

        if (
          Predicate.isTagged(next.value, "Diagnostics") &&
          next.value.diagnostics.items.some((d) => String(d.code) === "2322")
        )
          return;
      }
    })();

    await writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');

    try {
      await Promise.race([
        diagnostics,
        Bun.sleep(15000).then(() => {
          throw new Error("No changed strict diagnostic");
        }),
      ]);
    } finally {
      abort.abort();
      await iterator.return?.();
    }

    await ready();
    current = await acquire();
    expect(current.ack.documents).toEqual([{ uri, version: 1 }]);
    expect(await Bun.file(input.path).text()).toBe("const saved = 1;");
    await broker.sync("live", {
      context: current.context,
      sequence: 2,
      notification: P.LanguageDocumentNotification.cases.Close.make({ uri, version: 1 }),
    });
    await until(() => broker.stats().processSlots === 0);
    expect((await acquire()).runtime).toEqual(
      P.LanguageRuntime.cases.Stopped.make({ reason: "no-demand" })
    );
    console.log(
      JSON.stringify({
        realServer: "typescript-language-server",
        kills: 3,
        launches: processes.length,
        stopped: stoppedRuntime,
        changedDiagnostic: 2322,
        idleMs: 100,
      })
    );
  } finally {
    await broker.close();
    await removeTempDirSettled(root);
  }
}, 90000);
