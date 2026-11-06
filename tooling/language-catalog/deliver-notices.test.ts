import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { catalog } from "../../apps/daemon/src/languages/catalog";
import {
  AuditManifest,
  verifyIntegrity,
} from "../../apps/daemon/src/languages/catalog/verification";
import { deliverNotices } from "./deliver-notices";
import { expectFullDelivery, lightArtifacts } from "./deliver-notices.testing";

const artifact = catalog.tools.find((tool) => tool.id === "phpactor")!.artifacts[0]!;

const manifestBytes = readFileSync(join(import.meta.dir, "audits", `${artifact.id}.json`));

const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(AuditManifest))(
  manifestBytes.toString()
);

test("offline delivery retains every pinned Phpactor notice without granting readiness", () => {
  const root = mkdtempSync(join("/tmp", "k2-delivery-"));

  try {
    const destination = join(root, "staged");
    const paths = deliverNotices({ artifact, sourceRoot: import.meta.dir, destination });
    expect(paths).toHaveLength(manifest.notices.length);

    for (const notice of manifest.notices)
      expect(verifyIntegrity(readFileSync(join(destination, notice.path)), notice.integrity)).toBe(
        true
      );
    expect(
      verifyIntegrity(readFileSync(join(destination, "audit-manifest.json")), artifact.auditRoot!)
    ).toBe(true);
    expect(artifact.audit).toBe("verified");
    expect(readFileSync(join(destination, "delivery.json"), "utf8")).toContain(
      "no installation or activation approval"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing or corrupt required notice bytes stop delivery before staging", () => {
  const root = mkdtempSync(join("/tmp", "k2-delivery-fault-"));

  try {
    mkdirSync(join(root, "source/audits"), { recursive: true });
    writeFileSync(join(root, "source/audits", `${artifact.id}.json`), manifestBytes);
    const sourceRoot = join(root, "source");
    expect(() =>
      deliverNotices({ artifact, sourceRoot, destination: join(root, "missing") })
    ).toThrow();

    for (const notice of manifest.notices) {
      const path = join(sourceRoot, notice.path);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, readFileSync(join(import.meta.dir, notice.path)));
    }

    writeFileSync(join(sourceRoot, manifest.notices[0]!.path), "corrupted");
    expect(() =>
      deliverNotices({ artifact, sourceRoot, destination: join(root, "corrupt") })
    ).toThrow("notice-delivery-integrity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery rejects a preexisting staging directory or symbolic link", () => {
  const root = mkdtempSync(join("/tmp", "k2-delivery-link-"));

  try {
    mkdirSync(join(root, "existing"));
    symlinkSync(join(root, "existing"), join(root, "link"));
    expect(() =>
      deliverNotices({ artifact, sourceRoot: import.meta.dir, destination: join(root, "link") })
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const candidate of lightArtifacts) {
  test(`offline notice delivery covers ${candidate.id} without activation`, () =>
    expectFullDelivery(candidate));
}
