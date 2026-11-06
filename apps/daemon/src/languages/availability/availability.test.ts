import { expect, test } from "bun:test";
import { availability } from "./index.ts";
import { artifactFixture, fixture, hostId, platform } from "../install/fixture.testing.ts";
import { posixTest } from "../../platform/testing.ts";

const privateStorage = posixTest(
  "language storage is checked private by POSIX owner and mode bits; Windows needs ACL checks (ENG-314)"
);

const input = () =>
  ({
    tool: artifactFixture().tool,
    hostId,
    platform,
    connected: true,
    trusted: true,
    phase: "install",
    probes: [],
    installed: null,
    checkedAt: 1,
  }) as const;

test("availability defaults deny and reports offline/unsupported/missing/incompatible facts without probes or execution", () => {
  expect(availability(input()).preflight).toMatchObject({
    reason: "audit-required",
  });
  expect(availability({ ...input(), connected: false }).preflight).toMatchObject({
    reason: "not-connected",
  });
  expect(
    availability({ ...input(), approved: true, phase: "feature", trusted: false }).preflight
  ).toMatchObject({ reason: "awaiting-trust" });
  expect(availability({ ...input(), approved: true }).preflight).toMatchObject({
    artifactId: "fake",
  });
  expect(
    availability({ ...input(), platform: { os: "linux", arch: "x64", libc: "musl" } }).preflight
  ).toMatchObject({ reason: "unsupported-platform" });

  const tool = {
    ...input().tool,
    requirements: [
      {
        id: "node",
        executable: "node",
        scope: "server",
        version: ">=22.0.0",
        required: true,
        detail: "Developer supplied Node",
      },
    ],
  };

  const missing = availability({ ...input(), tool });
  expect(missing.preflight).toMatchObject({ reason: "missing-prerequisite" });
  expect(missing.prerequisites[0]?.outcome).toBe("missing");

  const incompatible = availability({
    ...input(),
    tool,
    probes: [{ id: "node", executable: "/fake/node", version: "20.0.0" }],
  });

  expect(incompatible.prerequisites[0]?.outcome).toBe("incompatible");

  const unknown = availability({
    ...input(),
    tool,
    probes: [{ id: "node", executable: "/fake/node", version: null }],
  });

  expect(unknown.prerequisites[0]?.outcome).toBe("unknown");
});

privateStorage(
  "project prerequisites block features rather than installation; failed update keeps retained-version facts",
  async () => {
    const f = await fixture();

    try {
      const installed = await f.installer.install(f.request).result;

      const tool = {
        ...artifactFixture("2.0.0").tool,
        requirements: [
          {
            id: "go",
            executable: "go",
            scope: "project",
            version: ">=1.20.0",
            required: true,
            detail: "Developer supplied compiler",
          },
        ],
      };

      expect(availability({ ...input(), tool, installed, approved: true }).preflight).toMatchObject(
        {
          artifactId: "fake",
        }
      );
      const facts = availability({ ...input(), tool, installed, phase: "feature", approved: true });
      expect(facts.preflight).toMatchObject({ reason: "missing-prerequisite" });
      expect(facts.updateCandidate).toBe("2.0.0");
      const progress = f.installer.progress("fake-tool")!;

      const failed = availability({
        ...input(),
        tool,
        installed,
        progress: { ...progress, phase: "failed", version: "2.0.0", message: "offline" },
      });

      expect(failed.installation).toMatchObject({
        retainedVersion: "1.0.0",
        version: "2.0.0",
      });
    } finally {
      await f.close();
    }
  }
);
