import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Predicate } from "effect";
import * as P from "@polaris/protocol";
import { availability } from "../availability/index.ts";
import { catalog } from "../catalog/index.ts";
import { providerAvailability } from "../composition/managedAvailability.ts";
import { managedWithoutTrust } from "../composition/managedPolicy.ts";
import type { DiscoveryFacts } from "../discovery/index.ts";
import { hostId, platform } from "../install/fixture.testing.ts";
import { createHostPrerequisiteProbe } from "../install/hostStateProbes.ts";
import { createSelectionLedger } from "../install/selection-ledger.ts";
import type { LaunchAdmissionRequest } from "../runtime/launchAdmission.ts";
import { developerLaunchAdapters, developerProvider } from "./launch.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const posixTools = posixTest(
  "the fake gopls is a POSIX sh script; Windows looks for gopls.exe (ENG-296)"
);

const gopls = catalog.tools.find((tool) => tool.id === "gopls")!;

const sentinel = (marker: string) => `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`;

async function host() {
  const home = newTempDir("polaris-go-", { short: true });
  const bin = join(home, "go/bin");
  await mkdir(bin, { recursive: true });
  const probes = createHostPrerequisiteProbe({ home, directories: [bin] });

  const installation = {
    inspect: (_id: string, phase: "install" | "feature", trusted: boolean) =>
      Effect.promise(async () => {
        const probe = probes();
        const facts = [];

        for (const requirement of gopls.requirements) {
          const present = await probe.probe(requirement, AbortSignal.timeout(2000));
          facts.push({
            id: requirement.id,
            executable: present.path,
            version: present.path === null ? null : "present",
          });
        }

        return availability({
          hostId,
          platform,
          tool: gopls,
          connected: true,
          trusted,
          phase,
          probes: facts,
          installed: null,
          checkedAt: 1,
        });
      }),
  };

  const install = async (name: string) => {
    const path = join(bin, name);
    await writeFile(path, sentinel(join(home, `${name}-ran`)), { mode: 0o755 });

    return path;
  };

  const ran = async () =>
    (await Bun.file(join(home, "go-ran")).exists()) ||
    (await Bun.file(join(home, "gopls-ran")).exists());

  return { home, bin, probes, installation, install, ran };
}

const check = (fixture: Awaited<ReturnType<typeof host>>, trusted: boolean) =>
  Effect.runPromise(
    providerAvailability(fixture.installation, undefined, "gopls", "feature", trusted)
  );

test("gopls is a developer Prerequisite with no artifact and the go install command everywhere", () => {
  expect(developerProvider("gopls")).toBe(true);
  expect(gopls).toMatchObject({ distribution: "developer", disposition: "offered", artifacts: [] });
  expect(gopls.requirements.map((item) => item.id)).toEqual(["go", "gopls"]);

  const install = gopls.requirements[1]!.installCommands![0]!;
  expect(install.command).toBe("go install golang.org/x/tools/gopls@latest");
  expect(install.platforms).toHaveLength(6);
  expect(gopls.requirements[0]!.installCommands!.map((item) => item.command)).toEqual([
    "brew install go",
    "sudo apt install golang-go",
  ]);

  const go = catalog.integrations.find((item) => item.id === "go")!;
  expect(go).toMatchObject({ offered: true, formatter: { tool: "gopls", source: "developer" } });
  expect(catalog.integrations.find((item) => item.id === "java")!.limitations).toContain(
    "Skipped (owner: Java users use IntelliJ)."
  );
});

test("missing gopls blocks with its command; Check again finds it and Trust gates the launch", async () => {
  const fixture = await host();

  try {
    await fixture.install("go");
    const missing = await check(fixture, true);
    expect(Predicate.isTagged(missing.preflight, "Blocked") && missing.preflight.reason).toBe(
      "missing-prerequisite"
    );
    expect(missing.prerequisites.map((item) => [item.requirement.id, item.outcome])).toEqual([
      ["go", "satisfied"],
      ["gopls", "missing"],
    ]);

    await fixture.install("gopls");
    const untrusted = await check(fixture, false);
    expect(Predicate.isTagged(untrusted.preflight, "Blocked") && untrusted.preflight.reason).toBe(
      "awaiting-trust"
    );

    const trusted = await check(fixture, true);
    expect(trusted.preflight).toEqual(
      P.LanguagePreflight.cases.Eligible.make({ artifactId: null })
    );
    expect(await fixture.ran()).toBe(false);
  } finally {
    await removeTempDirSettled(fixture.home);
  }
});

test("gopls always needs Trust: it is never a managed provider", () => {
  // SAFETY: managedWithoutTrust reads only these discovery fields.
  const facts = { providerId: "gopls", effectiveSettings: { settings: {} } } as DiscoveryFacts;
  expect(managedWithoutTrust(facts)).toBe(false);
});

posixTools(
  "the launch runs the found gopls with the Go toolchain first on PATH, and refuses a changed binary",
  async () => {
    const fixture = await host();

    try {
      const go = await fixture.install("go");
      const server = await fixture.install("gopls");
      const adapters = developerLaunchAdapters(createSelectionLedger(), fixture.probes);

      // SAFETY: the adapter reads only the provider and project root from discovery.
      const facts = { providerId: "gopls", projectRoot: fixture.home } as DiscoveryFacts;

      const request: LaunchAdmissionRequest = {
        context: P.LanguageContextIdentity.make({
          hostId,
          clientId: "c",
          contextId: "x",
          checkout: P.LanguageCheckout.cases.Workspace.make({
            workspaceId: P.WorkspaceId.make("w"),
            path: fixture.home,
          }),
          projectRoot: fixture.home,
          providerId: "gopls",
          configurationFingerprint: "a".repeat(64),
          generation: 1,
        }),
        facts,
        signal: new AbortController().signal,
        isCurrent: () => true,
      };

      const lease = await adapters.reserveLaunch(request);
      const launch = await adapters.resolveLaunch(request.facts, lease, request);
      expect(launch.executable).toBe(server);
      expect(launch.args).toEqual([]);
      expect(launch.cwd).toBe(fixture.home);
      expect(launch.environment.PATH?.split(":")[0]).toBe(join(go, ".."));

      await writeFile(server, sentinel(join(fixture.home, "replaced")) + "# changed\n");

      const changed = await lease.validate(new AbortController().signal).then(
        () => null,
        (cause: unknown) => cause
      );

      expect(changed).toMatchObject({ reason: "conflict" });
      await lease.release();
      expect(await fixture.ran()).toBe(false);
    } finally {
      await removeTempDirSettled(fixture.home);
    }
  }
);
