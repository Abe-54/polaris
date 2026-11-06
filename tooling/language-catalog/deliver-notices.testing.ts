import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { catalog } from "../../apps/daemon/src/languages/catalog";
import type { Artifact } from "../../apps/daemon/src/languages/catalog/model";
import {
  AuditManifest,
  verifyIntegrity,
} from "../../apps/daemon/src/languages/catalog/verification";
import { deliverNotices } from "./deliver-notices";

const deliverable = catalog.tools.filter(
  (tool) => tool.disposition === "offered" || tool.id === "shellcheck"
);

/** jdtls stages ~2,600 notices, the slow tier's case; the two lists cover every deliverable artifact. */
const isHeavy = (tool: { readonly id: string }): boolean => tool.id === "jdtls";

export const lightArtifacts: ReadonlyArray<Artifact> = deliverable
  .filter((tool) => !isHeavy(tool))
  .flatMap((tool) => tool.artifacts);

export const heavyArtifacts: ReadonlyArray<Artifact> = deliverable
  .filter(isHeavy)
  .flatMap((tool) => tool.artifacts);

/** Stage the artifact's notices in a fresh directory and check every staged byte against its manifest. */
export const expectFullDelivery = (candidate: Artifact): void => {
  const root = mkdtempSync(join("/tmp", "k3-delivery-artifact-"));

  try {
    const destination = join(root, "staged");
    const bytes = readFileSync(join(import.meta.dir, "audits", `${candidate.id}.json`));

    const expected = Schema.decodeUnknownSync(Schema.fromJsonString(AuditManifest))(
      bytes.toString()
    );

    expect(
      deliverNotices({ artifact: candidate, sourceRoot: import.meta.dir, destination })
    ).toHaveLength(expected.notices.length);

    for (const notice of expected.notices)
      expect(verifyIntegrity(readFileSync(join(destination, notice.path)), notice.integrity)).toBe(
        true
      );
    expect(
      verifyIntegrity(readFileSync(join(destination, "audit-manifest.json")), candidate.auditRoot!)
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
