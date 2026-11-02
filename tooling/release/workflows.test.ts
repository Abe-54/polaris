import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Schema } from "effect";
import { PLATFORMS } from "../../packages/client/src/install/builds.ts";

const GITHUB = join(import.meta.dir, "../../.github");

const Step = Schema.Struct({
  if: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const Job = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  "continue-on-error": Schema.optional(Schema.Boolean),
  needs: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  if: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
  permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  steps: Schema.Array(Step),
});

const Workflow = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  jobs: Schema.Record(Schema.String, Job),
});

const files = [
  ...readdirSync(join(GITHUB, "workflows")).map((name) => join(GITHUB, "workflows", name)),
  ...readdirSync(join(GITHUB, "actions")).map((name) =>
    join(GITHUB, "actions", name, "action.yml")
  ),
];

const release = Schema.decodeUnknownSync(Workflow)(
  Bun.YAML.parse(readFileSync(join(GITHUB, "workflows/release.yml"), "utf8"))
);

/** A secret's value, as opposed to a `secrets.X != ''` presence check. */
const SECRET_VALUE = /secrets(?:\.\w+\b(?!\s*!=)|\s*\[)/;

const holdsSecrets = (job: typeof Job.Type) => SECRET_VALUE.test(JSON.stringify(job));

/** The jobs that hold Apple's signing credentials: the ones in the `release` environment. */
const appleJobs = () =>
  Object.entries(release.jobs).filter(([, job]) => job.environment === "release");

const writes = (job: typeof Job.Type) =>
  Object.entries(job.permissions ?? {}).filter(([, level]) => level === "write");

describe("workflow supply chain", () => {
  test.each(files.map((file) => [relative(GITHUB, file), file]))(
    "%s runs external actions only at a full commit SHA",
    (_, file) => {
      const unpinned = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /^\s*-?\s*uses:/.test(line))
        .filter(
          (line) => !/uses: (\.\/\S+|[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d\S*)\s*$/.test(line)
        );

      expect(unpinned).toEqual([]);
    }
  );
});

describe("release authority", () => {
  test("only publish writes the Release and npm mints its provenance token; publish holds no secrets", () => {
    expect(release.permissions).toEqual({});
    expect(release.env).toBeUndefined();
    expect(
      Object.entries(release.jobs).flatMap(([name, job]) =>
        writes(job).map(([scope]) => `${name}:${scope}`)
      )
    ).toEqual(["npm:id-token", "publish:contents"]);
    expect(holdsSecrets(release.jobs.publish!)).toBe(false);
  });

  test("only the signing jobs hold secrets, each behind the release environment", () => {
    expect(
      Object.entries(release.jobs)
        .filter(([, job]) => holdsSecrets(job))
        .map(([name, job]) => [name, job.environment])
    ).toEqual([
      ["sign", "release"],
      ["sign-dmg", "release"],
    ]);
  });

  test("jobs with Apple credentials run only the default branch's signer", () => {
    const signers = appleJobs();

    expect(signers.map(([name]) => name)).toEqual(["sign", "sign-dmg"]);

    for (const [, job] of signers) {
      for (const step of job.steps) {
        if (step.uses !== undefined)
          expect(step.uses).toMatch(/^actions\/(checkout|download-artifact|upload-artifact)@/);

        if (step.uses?.startsWith("actions/checkout@"))
          expect(step.with?.ref).toBe("${{ github.event.repository.default_branch }}");

        expect(step.run ?? "").not.toMatch(/\b(bunx?|node|npx?|uvx?|pip3?|pnpm|yarn|make)\b/);
      }
    }
  });

  test("jobs with Apple credentials touch hand-offs only through the signer", () => {
    for (const [, job] of appleJobs()) {
      for (const step of job.steps) {
        if (step.uses?.startsWith("actions/download-artifact@")) {
          expect(step.with?.name).toBeUndefined();
          expect(String(step.with?.["artifact-ids"])).toMatch(/^\$\{\{ needs\.[\w-]+\.outputs\./);
        }

        if (step.run?.startsWith("python3 -I signer/tooling/release/sign.py ")) continue;

        expect(step.run ?? "").not.toMatch(/\b(tar|cp|mv|ln|ditto|unzip|shasum|cd)\b/);
      }
    }
  });
});

describe("SDK on npm", () => {
  const npm = release.jobs.npm!;

  test("the npm job runs no repository code: it publishes the packed tarball it checked", () => {
    expect(npm.steps.map((step) => step.uses?.replace(/@.*/, "") ?? "run")).toEqual([
      "actions/setup-node",
      "actions/download-artifact",
      "run",
    ]);
    expect(npm.steps[1]?.with?.name).toBeUndefined();
    expect(String(npm.steps[1]?.with?.["artifact-ids"])).toBe(
      "${{ needs.sdk.outputs.tarball-id }}"
    );

    const run = npm.steps[2]?.run ?? "";

    expect(run).not.toMatch(/\b(bunx?|node|npx|uvx?|pnpm|yarn|make|tar)\b/);
    expect(run.indexOf("sha256sum --check")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("sha256sum --check")).toBeLessThan(run.indexOf("npm publish"));
    expect(run).toMatch(
      /npm publish \.\/handoff\/polaris-sdk\.tgz --provenance --access public --ignore-scripts /
    );
  });

  test("npm uses OIDC in its own environment with a pinned compatible toolchain", () => {
    expect(npm.environment).toBe("npm");
    expect(npm.steps[0]?.with?.["node-version"]).toBe("24.22.1");
    expect(npm.steps[2]?.run).toContain('test "$(npm --version)" = 11.19.1');
    expect(holdsSecrets(npm)).toBe(false);
    expect(JSON.stringify(npm)).not.toContain("NODE_AUTH_TOKEN");
  });
});

describe("Even G2 package", () => {
  const g2 = release.jobs["even-g2"]!;

  test("the .ehpk stays a workflow artifact: publish never downloads it", () => {
    const artifacts = g2.steps
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
      .map((step) => String(step.with?.name));

    const downloaded = release.jobs
      .publish!.steps.filter((step) => step.uses?.startsWith("actions/download-artifact@"))
      .map((step) => step.with);

    expect(artifacts).toEqual(["polaris-g2-${{ needs.metadata.outputs.version }}"]);
    expect(downloaded).toEqual([
      { name: "release-assets-macos-signed", path: "handoff/macos" },
      { name: "release-assets-dmg-signed", path: "handoff/dmg" },
      { name: "release-assets-windows", path: "handoff/windows" },
      { name: "release-assets-raycast", path: "handoff/raycast" },
    ]);
    expect(release.jobs.publish!.needs).not.toContain("even-g2");
  });

  test("the whitelist comes from the EVEN_G2_HOSTS variable through the environment, not the script", () => {
    const pack = g2.steps.find((step) => step.run?.includes("extensions/even-g2 pack"));

    expect(g2.if).toBe("vars.EVEN_G2_HOSTS != ''");
    expect(pack?.env?.EVEN_G2_HOSTS).toBe("${{ vars.EVEN_G2_HOSTS }}");
    expect(pack?.run).not.toContain("${{");
    expect(holdsSecrets(g2)).toBe(false);
  });
});

describe("release assets", () => {
  const publish = Object.values(release.jobs)
    .flatMap((job) => job.steps)
    .map((step) => step.run ?? "")
    .find((run) => run.includes("gh release create"));

  test("the Release carries one Daemon archive per platform the Client installs", () => {
    expect(publish).toContain(`test "\${#daemons[@]}" -eq ${PLATFORMS.length}`);
  });

  test("failed extension jobs leave the run red but do not block the signed Release", () => {
    expect(release.jobs.publish!.needs).toContain("raycast");
    expect(release.jobs.publish!.if?.trim()).toBe(
      "always() && needs.sign.result == 'success' && needs.sign-dmg.result == 'success'"
    );
    expect(release.jobs.raycast!["continue-on-error"]).not.toBe(true);

    const draft = release.jobs.publish!.steps.find((step) =>
      step.run?.includes("gh release create")
    );

    for (const job of ["windows", "raycast"]) {
      expect(draft?.env?.[`${job.toUpperCase()}_SHA256`]).toBe(
        `\${{ needs.${job}.result == 'success' && needs.${job}.outputs.assets || '' }}`
      );
    }

    expect(
      release.jobs.publish!.steps.find((step) => step.with?.name === "release-assets-raycast")?.if
    ).toBe("needs.raycast.result == 'success'");
    expect(publish).toContain('take raycast "$RAYCAST_SHA256"');
    expect(publish).toContain('test -s "handoff/raycast/polaris-raycast-$VERSION.zip"');
  });

  test.each(PLATFORMS.filter((platform) => platform.startsWith("windows")))(
    "the Release refuses to publish without the %s Daemon",
    (platform) => {
      expect(publish).toContain(`polaris-daemon-$VERSION-${platform}.tar.gz`);
    }
  );
});
