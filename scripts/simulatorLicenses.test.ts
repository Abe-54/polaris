import { describe, expect, test } from "bun:test";
import { simulatorAuditStale } from "./simulatorLicenses.ts";

const audit = {
  tools: "hub-1+ad-1",
  packages: [
    { name: "a", version: "1.0.0", license: "MIT", texts: [] },
    { name: "@s/b", version: "2.0.0", license: "MIT", texts: [] },
  ],
};

describe("simulatorAuditStale", () => {
  test("an audit of exactly the pinned packages is current", () => {
    expect(simulatorAuditStale(audit, "hub-1+ad-1", ["@s/b@2.0.0", "a@1.0.0"])).toEqual([]);
  });

  test("a bump, a new package or a dropped one each make it stale", () => {
    const problems = simulatorAuditStale(audit, "hub-2+ad-1", ["a@1.0.0", "@s/b@2.1.0"]);

    expect(problems.map((p) => p.split(":")[0])).toEqual([
      "the audit covers hub-1+ad-1 but hub-2+ad-1 is pinned",
      "@s/b@2.1.0 is not audited",
      "@s/b@2.0.0 is no longer pinned",
    ]);
  });
});
