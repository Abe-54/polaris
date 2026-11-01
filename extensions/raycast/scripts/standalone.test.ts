import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { standaloneManifest, standaloneReadme } from "./standalone.ts";

const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")
);

test("the standalone manifest names no workspace package and installs the SDK from npm", () => {
  const built = standaloneManifest(manifest, "0.2.0");
  const text = JSON.stringify(built);

  expect(text).not.toContain("workspace:");
  expect(text).not.toContain("../../");
  expect(built["dependencies"]).toMatchObject({
    "@polaris/sdk": "npm:@doellsoftware/polaris-sdk@0.2.0",
  });
  expect(built["private"]).toBeUndefined();
  expect(built["commands"]).toEqual(manifest["commands"]);
});

test("the standalone README says how to install it and points nowhere inside the repository", () => {
  const readme = standaloneReadme(readFileSync(join(import.meta.dir, "..", "README.md"), "utf8"));

  expect(readme.indexOf("npm run dev")).toBeGreaterThan(-1);
  expect(readme.indexOf("npm run dev")).toBeLessThan(readme.indexOf("## Pair it"));
  expect(readme).not.toContain("../");
  expect(readme).not.toContain("## Develop");
});

test("a local SDK tarball replaces the npm alias for pre-publish validation", () => {
  const built = standaloneManifest(manifest, "0.2.0", "packages/sdk/build/sdk.tgz");

  expect(built["dependencies"]).toMatchObject({
    "@polaris/sdk": resolve("packages/sdk/build/sdk.tgz"),
  });
});
