import { expect } from "bun:test";
import { rejects } from "node:assert/strict";
import { join } from "node:path";
import * as P from "@polaris/protocol";
import { createProjectDiscovery } from "../discovery/index.ts";
import { fixture as projectFixture } from "../discovery/fixture.ts";
import { createHostInstallations } from "../install/host.ts";
import { createSelectionLedger } from "../install/selection-ledger.ts";
import { artifactFixture, hostId, platform } from "../install/fixture.testing.ts";
import { httpsArtifactDownload } from "../install/download.ts";
import { digest } from "../install/validation.ts";
import { createManagedDelivery } from "./managedDelivery.ts";
import { typescriptTool } from "./managedPolicy.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const privateInstallTest = posixTest(
  "language installations require a POSIX-mode private, owned directory (ENG-314)"
);

const settings = (automatic = true) =>
  P.LanguageEffectiveSettings.make({
    revision: 0,
    formatOnSave: true,
    formatter: P.LanguageFormatterSelection.cases.None.make({}),
    providers: [],
    origins: {},
    settings: { downloadLanguageToolsAutomatically: automatic },
  });

async function fixture(corrupt = false, legacy = false) {
  const root = newTempDir("slice-1-delivery-", { short: true });
  const source = artifactFixture();
  const downloads = new Map<string, number>();

  const oldManifest = Buffer.from(
    JSON.stringify(JSON.parse(Buffer.from(source.payload.manifestBytes).toString()), null, 2)
  );

  const oldPayload = { ...source.payload, manifestBytes: oldManifest };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      downloads.set(path, (downloads.get(path) ?? 0) + 1);

      return new Response(corrupt ? Buffer.from("corrupt") : source.bytes);
    },
  });

  const registry = createHostInstallations();
  const ledger = createSelectionLedger();
  const managed = createManagedDelivery();

  const tools = [
    "node",
    "typescript",
    "typescript-language-server",
    "typescript-go",
    "basedpyright",
    "ruff",
  ].map((id) => ({
    ...source.tool,
    id,
    artifacts: source.tool.artifacts.map((artifact) => ({
      ...artifact,
      url: `https://fixture.invalid/${id}`,
    })),
  }));

  const options = {
    root: join(root, "private"),
    hostId,
    platform,
    tools,
    adapters: {
      approve: async (exact) => ({ approved: true, identity: exact.identity }),
      download: httpsArtifactDownload(async (url, init) => {
        const response = await fetch(new URL(new URL(url).pathname, server.url), init);

        return new Response(response.body, { status: response.status, headers: response.headers });
      }),
      decode: async (_bytes, exact) =>
        exact.artifact.auditRoot === digest(oldManifest) ? oldPayload : source.payload,
    },
    observe: async () => ({ connected: true, probes: [] }),
    reserveSelection: (exact, signal) => ledger.reserveSelection(exact.tool.id, signal),
  } satisfies import("../install/host.ts").HostInstallationOptions;

  if (legacy) {
    const oldRegistry = createHostInstallations();

    const oldHost = await oldRegistry.get({
      ...options,
      tools: tools.map((tool) => ({
        ...tool,
        artifacts: tool.artifacts.map((artifact) => ({
          ...artifact,
          auditRoot: digest(oldManifest),
        })),
      })),
    });

    for (const tool of tools.filter((tool) => !["basedpyright", "ruff"].includes(tool.id))) {
      const handle = await oldHost.install(tool.id, "encounter", async () => {});
      await handle.result;
    }

    await oldRegistry.dispose();
  }

  const host = await registry.get(options);
  managed.delivery.bind(host);
  const admission = { cwd: root, requireCurrent: async () => {} };

  return {
    root,
    host,
    managed,
    downloads,
    admission,
    ledger,
    async close() {
      await registry.dispose();
      ledger.dispose();
      await managed.dispose();
      await server.stop(true);
      await removeTempDirSettled(root);
    },
  };
}

privateInstallTest(
  "local artifact server installs once per Host/tool/version across concurrent opens and reuse",
  async () => {
    const f = await fixture();

    try {
      await Promise.all(
        Array.from({ length: 3 }, () =>
          f.managed.delivery.ensure(settings(), f.admission, new AbortController().signal)
        )
      );
      await f.managed.delivery.ensure(settings(false), f.admission, new AbortController().signal);

      for (const id of ["node", "typescript", "typescript-language-server"]) {
        expect(f.downloads.get(`/${id}`)).toBe(1);
        expect((await f.host.current(id))?.version).toBe("1.0.0");
      }
    } finally {
      await f.close();
    }
  }
);

privateInstallTest(
  "auto-download off reports not-installed without contacting the fixture server",
  async () => {
    const f = await fixture();

    try {
      await rejects(
        f.managed.delivery.ensure(settings(false), f.admission, new AbortController().signal),
        { reason: "not-installed" }
      );
      expect(f.downloads.size).toBe(0);
      expect(await f.host.current("node")).toBeNull();
    } finally {
      await f.close();
    }
  }
);

privateInstallTest(
  "Python delivery verifies only basedpyright, Ruff and private Node and reuses their receipts",
  async () => {
    const f = await fixture();

    try {
      for (const provider of ["basedpyright", "ruff"])
        await f.managed.delivery.ensure(
          settings(),
          f.admission,
          new AbortController().signal,
          provider
        );
      expect([...f.downloads.keys()].sort()).toEqual(["/basedpyright", "/node", "/ruff"]);
      expect(f.host.stats().verification.fullVerifications).toBe(3);

      for (const provider of ["basedpyright", "ruff"])
        await f.managed.delivery.ensure(
          settings(false),
          f.admission,
          new AbortController().signal,
          provider
        );
      expect(f.host.stats().verification.fullVerifications).toBe(3);
      expect(f.host.stats().verification.memoryReuses).toBeGreaterThan(0);
      expect(await f.host.current("typescript")).toBeNull();
      expect(await f.host.current("typescript-language-server")).toBeNull();
    } finally {
      await f.close();
    }
  }
);

privateInstallTest(
  "fixture checksum mismatch never activates a private runtime or server",
  async () => {
    const f = await fixture(true);

    try {
      await rejects(
        f.managed.delivery.ensure(settings(), f.admission, new AbortController().signal),
        { reason: "audit-required" }
      );
      expect(await f.host.current("node")).toBeNull();
      expect(await f.host.current("typescript-language-server")).toBeNull();
    } finally {
      await f.close();
    }
  }
);

privateInstallTest(
  "launch plans select managed TS 7, project TS 7, and project tsserver/plugins",
  async () => {
    const f = await fixture();
    const project = await projectFixture();

    try {
      await f.managed.delivery.ensure(settings(), f.admission, new AbortController().signal);
      await f.managed.delivery.ensure(
        settings(),
        f.admission,
        new AbortController().signal,
        "typescript-go"
      );
      const installed = await f.host.current("typescript-language-server");
      const go = await f.host.current("typescript-go");

      if (installed === null || go === null) throw new Error("Fixture installation missing");
      const path = await project.put("file.ts");
      await project.put(
        "tsconfig.json",
        '{"compilerOptions":{"plugins":[{"name":"sample-plugin"}]}}'
      );
      await project.put(
        "node_modules/typescript/package.json",
        '{"name":"typescript","version":"6.0.3"}'
      );
      const tsserver = await project.put("node_modules/typescript/lib/tsserver.js", "fixture");

      const discovery = createProjectDiscovery({
        registry: project.registry,
        bundledTypeScript: true,
      });

      const input = {
        checkout: project.checkout,
        path,
        providerId: "typescript-language-server",
        settings: project.settings,
      };

      const old = await discovery.discover({ ...input, useProjectTypeScript: true });
      const oldPlan = await f.managed.delivery.plan(old, installed);
      expect(oldPlan.launch.initializationOptions).toMatchObject({ tsserver: { path: tsserver } });
      expect(oldPlan.launch.environment.NODE_OPTIONS).toBe("");
      expect(old.plugins.map(({ name }) => name)).toEqual(["sample-plugin"]);
      const untrusted = await discovery.discover(input);
      const bundled = await f.managed.delivery.plan(untrusted, go);
      expect(bundled.launch).toMatchObject({
        executable: join(go.directory, "lib/tsc"),
        args: ["--lsp", "--stdio"],
      });
      expect(bundled.runtimeExecutable).toBeUndefined();
      const binary = "/fixture/native-tsc";
      const native = { ...old, tsserver: null, sdkVersion: "7.0.2", nativeServer: binary };
      expect((await f.managed.delivery.plan(native, go)).launch).toMatchObject({
        executable: binary,
        args: ["--lsp", "--stdio"],
        cwd: old.projectRoot,
      });
      expect([old, untrusted, native].map(typescriptTool)).toEqual([
        "typescript-language-server",
        "typescript-go",
        "typescript-go",
      ]);
      await rejects(f.managed.delivery.plan({ ...native, nativeServer: null }, go), {
        reason: "missing-prerequisite",
      });
    } finally {
      await f.close();
      await project.cleanup();
    }
  }
);

for (const automatic of [true, false])
  privateInstallTest(
    `an older same-version catalog binding ${automatic ? "is replaced when automatic downloads are on" : "stays selected when automatic downloads are off"}`,
    async () => {
      const f = await fixture(false, true);
      const previous = await f.host.current("node");

      try {
        const upgrade = f.managed.delivery.ensure(
          settings(automatic),
          f.admission,
          new AbortController().signal
        );

        if (!automatic) {
          await rejects(upgrade, { reason: "not-installed" });
          expect((await f.host.current("node"))?.identity).toBe(previous?.identity);
        } else {
          await upgrade;
          expect((await f.host.current("node"))?.identity).not.toBe(previous?.identity);
          await f.managed.delivery.ensure(settings(), f.admission, new AbortController().signal);
        }

        for (const id of ["node", "typescript", "typescript-language-server"])
          expect(f.downloads.get(`/${id}`)).toBe(automatic ? 2 : 1);
      } finally {
        await f.close();
      }
    }
  );

privateInstallTest(
  "automatic catalog replacement still respects an active launch lease",
  async () => {
    const f = await fixture(false, true);
    const previous = await f.host.current("node");

    if (previous === null) throw new Error("Missing legacy Node");

    const lease = await f.ledger.reserveLaunch(
      "node",
      previous.identity,
      new AbortController().signal
    );

    try {
      await rejects(
        f.managed.delivery.ensure(settings(), f.admission, new AbortController().signal),
        { reason: "conflict" }
      );
      expect((await f.host.current("node"))?.identity).toBe(previous.identity);
    } finally {
      await lease.release();
      await f.close();
    }
  }
);
