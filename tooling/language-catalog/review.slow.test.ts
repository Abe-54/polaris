import { Schema } from "effect";
import historical from "./fixtures/bash-installer-review.json";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalog } from "../../apps/daemon/src/languages/catalog";
import { Tool } from "../../apps/daemon/src/languages/catalog/model";
import { ReviewRecord, readReviewRecords, reviewFailures, reviewRootFailures } from "./review";

const activeRead = (path: string): Uint8Array => readFileSync(join(import.meta.dir, path));

const read = (path: string): Uint8Array =>
  path === "audits/bash-language-server-npm.json"
    ? Buffer.from(historical.manifestText)
    : activeRead(path);

const records = readReviewRecords(import.meta.dir);

const tool = Schema.decodeUnknownSync(Tool)(historical.tool);

const record = Schema.decodeUnknownSync(ReviewRecord)(historical.record);

const failures = (changed: typeof record, reader = read): ReadonlyArray<string> =>
  reviewFailures({ tools: [tool], records: [changed], read: reader });

test("complete BlueOak record can await A1 without authorizing activation", () => {
  expect(record.status).toBe("awaiting-review");
  expect(failures(record)).toEqual([]);
  expect(tool.artifacts.every((artifact) => artifact.audit === "pending")).toBe(true);
});

test("missing evidence cannot be relabeled awaiting-review", () => {
  expect(failures({ ...record, missingEvidence: ["unverified source closure"] })).toContain(
    `${tool.id}:false-awaiting-review`
  );
  expect(failures({ ...record, status: "policy-clear" })).toContain(
    `${tool.id}:unapproved-policy-clear`
  );
});

test("policy scope must retain the exact disallowed dependency and its legal bytes", () => {
  expect(
    failures({ ...record, policyRequests: [] }).some((failure) =>
      failure.endsWith("scoped-policy-request-missing")
    )
  ).toBe(true);
  const requests = record.policyRequests.map((request) => ({ ...request, notices: [] }));
  expect(
    failures({ ...record, policyRequests: requests }).some((failure) =>
      failure.endsWith("scoped-policy-notice-missing")
    )
  ).toBe(true);
});

test("omitting a pinned dependency notice or evidence file fails pre-review", () => {
  for (const field of ["notices", "evidence"] as const) {
    const changed = { ...record, [field]: record[field].slice(1) };
    expect(failures(changed).some((failure) => failure.includes("review-omission"))).toBe(true);
  }
});

test("changed legal bytes, missing source inventory and changed frozen bundle fail", () => {
  for (const path of [
    record.notices[0]!.path,
    record.evidence[0]!.path,
    "bundles/bash-language-server.json",
  ]) {
    const corrupted = (candidate: string): Uint8Array =>
      candidate === path ? Buffer.from("corrupted") : read(candidate);

    expect(failures(record, corrupted).length).toBeGreaterThan(0);

    const absent = (candidate: string): Uint8Array => {
      if (candidate === path) throw new Error("removed");

      return read(candidate);
    };

    expect(failures(record, absent).length).toBeGreaterThan(0);
  }
});

test("record cannot migrate to another version, artifact or evaluation root", () => {
  expect(failures({ ...record, version: "unreviewed" })).toContain(`${tool.id}:review-version`);
  expect(failures({ ...record, artifacts: [] }).length).toBeGreaterThan(0);
  const evaluation = Tool.make({ ...tool, disposition: "evaluation" });
  expect(reviewFailures({ tools: [evaluation], records: [record], read })).toContain(
    `${tool.id}:non-offered-review-record`
  );
});

test("the exact catalog remains blocked on real evidence gaps, without circular A1 requirements", () => {
  const actual = reviewFailures({ tools: catalog.tools, records, read: activeRead });
  expect(
    actual
      .filter((failure) => failure.includes(":missing-evidence:"))
      .map((failure) => failure.split(":")[0])
      .sort((a, b) => (a ?? "").localeCompare(b ?? ""))
  ).toEqual(["jdtls", "shellcheck"]);
  expect(actual.some((failure) => failure.includes("false-awaiting-review"))).toBe(false);
  expect(reviewRootFailures(catalog.tools, activeRead)).toEqual([]);
});

const retainedNativeEvidence = [
  ["jdtls", "jdt-nested-metadata.json"],
  ["jdtls", "jdt-nested-maven-sources.json"],
  ["jdtls", "jdt-nested-parent-sources.json"],
  ["jdtls", "jdt-agent-source-build.json"],
] as const;

for (const [id, path] of retainedNativeEvidence) {
  test(`${id}: retained ${path} rejects corruption, omission and false readiness`, () => {
    const candidate = catalog.tools.find((row) => row.id === id)!;
    const retained = records.find((row) => row.tool === id)!;

    const check = (changed: typeof retained, reader = read) =>
      reviewFailures({ tools: [candidate], records: [changed], read: reader });

    expect(retained.status).toBe("missing-evidence");
    expect(retained.evidence.some((row) => row.path === path)).toBe(true);

    const baseline = check(retained);

    const corrupted = (requested: string): Uint8Array =>
      requested === path ? Buffer.from("synthetic corruption") : read(requested);

    expect(check(retained, corrupted).length).toBeGreaterThan(baseline.length);
    expect(
      check({ ...retained, evidence: retained.evidence.filter((row) => row.path !== path) }).length
    ).toBeGreaterThan(baseline.length);
    expect(check({ ...retained, status: "awaiting-review" })).toContain(
      `${id}:false-awaiting-review`
    );
    expect(candidate.artifacts.every((artifact) => artifact.audit === "pending")).toBe(true);
  }, 25000);
}
