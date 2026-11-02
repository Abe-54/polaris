import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { catalog } from "../catalog/index.ts";
import manifest from "../catalog/upstream-evidence/phpactor.phar.json";
import { managedWithoutTrust } from "../composition/managedPolicy.ts";
import type { DiscoveryFacts } from "../discovery/index.ts";
import { hostId, platform } from "../install/fixture.testing.ts";
import { createHostPrerequisiteProbe } from "../install/hostStateProbes.ts";
import type { InstalledVersion } from "../install/types.ts";
import { decodeUpstream } from "../install/upstream.ts";
import { phpactorLaunch, phpactorOptions } from "./launch.ts";
import { workspaceTools } from "./projectTools.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const phpactor = catalog.tools.find((tool) => tool.id === "phpactor")!;

const artifact = phpactor.artifacts[0]!;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const auditPath = join(import.meta.dir, "../../../../../tooling/language-catalog/audits");

test("Phpactor pins the upstream PHAR with its retained licenses and the Host's PHP", async () => {
  expect(phpactor).toMatchObject({
    version: "2026.10.07.0",
    distribution: "runtime-upstream",
    license: "MIT",
  });
  expect(artifact).toMatchObject({
    format: "phar",
    url: "https://github.com/phpactor/phpactor/releases/download/2026.10.07.0/phpactor.phar",
    integrity: "sha256:b28bf6166e016d539fc2f2aec18ef918b12590e436a6f1ccbdf30b5bbdbdb16b",
    audit: "verified",
  });
  expect(artifact.platforms).toHaveLength(6);

  const audit = await readFile(join(auditPath, "phpactor.phar.json"));
  expect(artifact.auditRoot).toBe(`sha256:${sha256(audit)}`);
  expect(JSON.parse(audit.toString())).toEqual(manifest);
  expect(manifest.notices).toHaveLength(2);

  const php = phpactor.requirements.find((item) => item.id === "php")!;
  expect(php).toMatchObject({ scope: "server", required: true, version: "present" });
  expect(php.installCommands?.map((item) => item.command)).toEqual([
    "brew install php",
    "sudo apt install php-cli",
  ]);
  expect(catalog.integrations.find((item) => item.id === "php")).toMatchObject({
    offered: true,
    formatter: { tool: "phpactor", source: "managed", mode: "lsp" },
  });
});

test("the PHAR installs as one non-executable file beside its notices", async () => {
  const bytes = new TextEncoder().encode("<?php // synthetic phar\n");

  const payload = await decodeUpstream(
    bytes,
    {
      hostId,
      platform,
      tool: phpactor,
      artifact: { ...artifact, integrity: `sha256:${sha256(bytes)}` },
      identity: "fixture",
      descriptor: {},
    },
    new AbortController().signal
  );

  expect(payload.entries.map((entry) => [entry.path, entry.kind === "file" && entry.mode])).toEqual(
    [["phpactor.phar", 0o644], ...manifest.notices.map((notice) => [notice.path, 0o644])]
  );

  for (const notice of manifest.notices) {
    const entry = payload.entries.find((item) => item.path === notice.path);
    expect(entry?.kind === "file" && `sha256:${sha256(entry.bytes)}`).toBe(notice.integrity);
  }
});

async function project() {
  const root = newTempDir("polaris-php-", { short: true });
  await mkdir(join(root, "vendor/bin"), { recursive: true });
  await mkdir(join(root, "bin"));
  await writeFile(join(root, ".phpactor.json"), '{"composer.enable": true}');
  await writeFile(join(root, "vendor/autoload.php"), "<?php touch(__DIR__.'/ran');");

  return root;
}

test("before Trust no Composer autoloader, project config or tool extension can run", async () => {
  const root = await project();

  try {
    await writeFile(join(root, "vendor/bin/php-cs-fixer"), "#!/bin/sh\n", { mode: 0o755 });
    const options = await phpactorOptions({ projectRoot: root, workspaceTrusted: false });
    expect(options).toMatchObject({
      "composer.enable": false,
      "language_server.diagnostic_outsource": false,
      "language_server.code_action_outsource": false,
      "indexer.parallel_workers": 1,
      "language_server.enable_trust_check": false,
      "language_server_configuration.auto_config": false,
      "language_server_php_cs_fixer.enabled": false,
      "language_server_phpstan.enabled": false,
      "language_server_psalm.enabled": false,
      "php_code_sniffer.enabled": false,
      "symfony.enabled": false,
    });

    const trusted = await phpactorOptions({ projectRoot: root, workspaceTrusted: true });
    expect(trusted).toEqual({
      "language_server.enable_trust_check": false,
      "language_server_configuration.auto_config": false,
      "language_server_php_cs_fixer.enabled": true,
    });
  } finally {
    await removeTempDirSettled(root);
  }
});

test("after Trust php-cs-fixer formats only when the project has it", async () => {
  const root = await project();

  try {
    const options = await phpactorOptions({ projectRoot: root, workspaceTrusted: true });
    expect(options).not.toHaveProperty("language_server_php_cs_fixer.enabled");
    expect(options).not.toHaveProperty("composer.enable");
  } finally {
    await removeTempDirSettled(root);
  }
});

test("the launch runs the PHAR on the Host's PHP with Phpactor's own trust store unusable", async () => {
  const root = await project();
  const php = join(root, "bin/php");
  await writeFile(php, `#!/bin/sh\necho ran > ${JSON.stringify(join(root, "php-ran"))}\n`, {
    mode: 0o755,
  });
  const probes = createHostPrerequisiteProbe({ home: root, directories: [join(root, "bin")] });

  // SAFETY: an installed version is only read for its directory and identity here.
  const installed = { identity: "id", directory: "/managed/phpactor" } as InstalledVersion;

  try {
    for (const workspaceTrusted of [false, true]) {
      // SAFETY: the launch reads only these discovery fields.
      const facts = { projectRoot: root, workspaceTrusted } as DiscoveryFacts;
      const plan = await phpactorLaunch(facts, installed, phpactor.requirements, probes);
      expect(plan.launch.executable).toBe(php);
      expect(plan.runtimeExecutable).toBe(php);
      expect(plan.launch.args).toEqual([
        join(installed.directory, "phpactor.phar"),
        "language-server",
      ]);
      expect(plan.launch.environment).toEqual(
        workspaceTrusted
          ? { PHPACTOR_UNCONDITIONAL_TRUST: "1" }
          : {
              PHPACTOR_UNCONDITIONAL_TRUST: "",
              XDG_DATA_HOME: "/dev/null/polaris-phpactor",
              GIT_DIR: "/dev/null/polaris-phpactor",
            }
      );
    }

    expect(await Bun.file(join(root, "php-ran")).exists()).toBe(false);
    expect(await Bun.file(join(root, "vendor/ran")).exists()).toBe(false);
  } finally {
    await removeTempDirSettled(root);
  }
});

test("managed Phpactor needs no Trust to start; the Trust ask names what Trust would run", async () => {
  const facts = {
    providerId: "phpactor",
    managedPhp: true,
    effectiveSettings: { settings: {} },
  };
  // SAFETY: managedWithoutTrust reads only these discovery fields.

  expect(managedWithoutTrust(facts as DiscoveryFacts)).toBe(true);
  // SAFETY: as above.
  expect(managedWithoutTrust({ ...facts, managedPhp: false } as DiscoveryFacts)).toBe(false);

  const root = await project();

  try {
    expect(await workspaceTools(root, root, "php")).toEqual([
      "a Phpactor config",
      "a Composer autoloader",
    ]);
    expect(await workspaceTools(root, root, "go")).toEqual([
      "Go packages that gopls loads with go list",
    ]);
    expect(await workspaceTools(root, root, "lua")).toEqual([]);
  } finally {
    await removeTempDirSettled(root);
  }
});
