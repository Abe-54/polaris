import { expect, test } from "bun:test";
import { join } from "node:path";
import { auditBundle, readBundle } from "./audit";
import { catalog } from "../../apps/daemon/src/languages/catalog";
import { Tool } from "../../apps/daemon/src/languages/catalog/model";
import { offeredTools, referenceFailures } from "./offered";

const root = import.meta.dir;

const bundle = readBundle(join(root, "bundles/typescript-language-server.json"));

test("frozen TS bundle retains full dependency audit and notices", () => {
  expect(auditBundle({ bundle, noticeRoot: join(root, "notices") })).toEqual([]);
});

test("an omitted optional/transitive lock entry cannot masquerade as complete", () => {
  const truncated = { ...bundle, packages: [] };
  const failures = auditBundle({ bundle: truncated, noticeRoot: join(root, "notices") });
  expect(failures.some((failure) => failure.endsWith("closure-size"))).toBe(true);
  expect(failures.some((failure) => failure.includes("closure-integrity"))).toBe(true);
});

test("changing a package root cannot pass a frozen lock audit", () => {
  const packages = bundle.packages.map((pkg) => ({ ...pkg, integrity: "sha512-corrupt" }));
  expect(
    auditBundle({ bundle: { ...bundle, packages }, noticeRoot: join(root, "notices") }).some(
      (failure) => failure.includes("closure-integrity")
    )
  ).toBe(true);
});

test("third party notice disappearance and copyleft metadata are not hidden by root license", () => {
  const packages = bundle.packages.map((pkg) => ({ ...pkg, license: "GPL-3.0-only", notices: [] }));

  const failures = auditBundle({
    bundle: { ...bundle, packages },
    noticeRoot: join(root, "notices"),
  });

  expect(failures.some((failure) => failure.includes("license-review"))).toBe(true);
  expect(failures.some((failure) => failure.includes("notice-coverage"))).toBe(true);
});

test("evaluation-only SQL cannot block offered release roots", () => {
  expect(offeredTools(catalog).some((tool) => tool.id === "sql-language-server")).toBe(false);
  expect(offeredTools(catalog)).toHaveLength(23);
  expect(referenceFailures(catalog)).toEqual([]);
});

test("active providers, companions and managed formatters cannot evade offered audit coverage", () => {
  for (const id of ["sqllens-language-server", "shfmt", "prettier"]) {
    const tools = catalog.tools.map((tool) =>
      tool.id === id ? Tool.make({ ...tool, disposition: "evaluation" }) : tool
    );

    expect(referenceFailures({ ...catalog, tools }).some((failure) => failure.endsWith(id))).toBe(
      true
    );
  }

  const integrations = catalog.integrations.map((integration) => ({
    ...integration,
    formatter: { ...integration.formatter, tool: "missing-formatter" },
  }));

  expect(referenceFailures({ ...catalog, integrations })).toHaveLength(16);

  const tools = catalog.tools.map((tool) =>
    Tool.make({
      ...tool,
      artifacts: tool.artifacts.map((artifact) => ({ ...artifact, bundle: null })),
    })
  );

  expect(
    referenceFailures({ ...catalog, tools }).some((failure) =>
      failure.endsWith("missing-npm-bundle")
    )
  ).toBe(true);
});
