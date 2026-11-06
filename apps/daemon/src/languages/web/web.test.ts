import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalog } from "../catalog/index.ts";
import { fixture } from "../discovery/fixture.ts";
import { createProjectDiscovery } from "../discovery/index.ts";
import { managedWithoutTrust } from "../composition/managedPolicy.ts";
import { webLaunch, webProviders, webServerSettings, workflowPath } from "./index.ts";
import { verifyIntegrity } from "../catalog/verification.ts";

test("every web language is offered with verified runtime pins on all private Node platforms", () => {
  for (const id of ["json", "css", "html", "yaml", "actions", "prisma", "svelte"]) {
    const integration = catalog.integrations.find((item) => item.id === id)!;
    expect(integration.offered).toBe(true);
    expect(integration.formatter.mode).toBe("lsp");

    for (const provider of integration.providers) {
      const tool = catalog.tools.find((item) => item.id === provider.tool)!;
      expect(tool.distribution).toBe("runtime-upstream");

      for (const artifact of tool.artifacts) {
        expect(artifact.integrity).toMatch(/^sha256:/);
        expect(artifact.platforms).toHaveLength(4);

        const manifest = readFileSync(
          join(import.meta.dir, "../catalog/upstream-evidence", artifact.id + ".json")
        );

        expect(verifyIntegrity(manifest, artifact.auditRoot!)).toBe(true);
      }
    }
  }
});

test("workflow routing excludes ordinary YAML", () => {
  expect(workflowPath("/project/.github/workflows/ci.yml")).toBe(true);
  expect(workflowPath(".github/workflows/ci.yaml")).toBe(true);
  expect(workflowPath("/project/deploy.yml")).toBe(false);
  expect(workflowPath("/project/.github/workflows/nested/ci.yml")).toBe(false);
});

test("private launches use the correct provider entry and Svelte Trust changes the launch identity", async () => {
  const f = await fixture();

  try {
    await f.put("package.json", "{}");
    await f.put("svelte.config.js", "throw new Error('never execute discovery');");
    await f.put("prisma.config.js", "throw new Error('never execute Prisma discovery');");
    const path = await f.put("Component.svelte", "<p>Hello</p>");
    const discovery = createProjectDiscovery({ registry: f.registry, bundledTypeScript: true });

    for (const providerId of Object.keys(webProviders)) {
      const facts = await discovery.discover({
        checkout: f.checkout,
        path,
        providerId,
        settings: f.settings,
      });

      expect(managedWithoutTrust(facts)).toBe(true);
      const tool = catalog.tools.find((item) => item.id === webProviders[providerId])!;

      const installed = {
        identity: "pin",
        directory: "/private/tool",
        version: tool.version,
        artifactId: tool.artifacts[0]!.id,
        integrity: tool.artifacts[0]!.integrity,
        descriptor: {},
      };

      const plan = webLaunch(facts, installed, { executable: "/private/node/bin/node" });
      expect(plan.launch.executable).toBe("/private/node/bin/node");
      expect(plan.launch.args).toEqual([plan.entry, "--stdio"]);
      expect(plan.launch.environment.NODE_PATH).toBe("");
      expect(plan.launch.environment.JITI_FS_CACHE).toBe("false");

      if (providerId === "svelte-language-server") {
        expect(facts.svelteConfiguration).toMatch(/svelte\.config\.js$/);
        expect(plan.launch.initializationOptions?.isTrusted).toBe(false);

        const trusted = await discovery.discover({
          checkout: f.checkout,
          path,
          providerId,
          settings: f.settings,
          workspaceTrusted: true,
        });

        expect(trusted.configurationFingerprint).not.toBe(facts.configurationFingerprint);
        expect(managedWithoutTrust(trusted)).toBe(false);
        expect(
          webLaunch(trusted, installed, { executable: "/private/node/bin/node" }).launch
            .initializationOptions?.isTrusted
        ).toBe(true);
      }

      if (providerId === "yaml-language-server")
        expect(webServerSettings(facts)).toMatchObject({
          yaml: { validate: true, schemaStore: { enable: false }, schemas: {} },
        });

      if (providerId === "prisma-language-server") {
        expect(facts.prisma?.configurationDeferred).toBe(true);
        expect(plan.launch.environment.NODE_OPTIONS).toContain("prisma-guard.cjs");
        expect(webServerSettings(facts)).toEqual({ prisma: { enableDiagnostics: true } });

        const trusted = await discovery.discover({
          checkout: f.checkout,
          path,
          providerId,
          settings: f.settings,
          workspaceTrusted: true,
        });

        expect(managedWithoutTrust(trusted)).toBe(false);
        expect(
          webLaunch(trusted, installed, { executable: "/private/node/bin/node" }).launch.environment
            .NODE_OPTIONS
        ).toBe("");
      }

      if (providerId === "vscode-css-language-server")
        expect(webServerSettings(facts)).toMatchObject({
          css: { validate: true },
          scss: { validate: true },
          less: { validate: true },
        });

      if (providerId === "vscode-json-language-server")
        expect(JSON.stringify(webServerSettings(facts))).toContain("json.schemastore.org/package");
    }
  } finally {
    await f.cleanup();
  }
});
