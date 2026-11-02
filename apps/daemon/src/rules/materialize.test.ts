import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitText } from "../git/git.ts";
import { makeRepo, removeTempDir, tempDir, write } from "../git/testing.ts";
import { materialize, removeMaterialized } from "./materialize.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const dir = (made: string) => {
  cleanup.push(made);

  return made;
};

describe("materialize", () => {
  test("writes the revision's blobs at their paths", async () => {
    const root = dir(await makeRepo({ "src/a.ts": "export const a = 1;\n" }));
    const files = await materialize(root, "HEAD", ["src/a.ts", "missing.ts"]);

    expect(files.paths).toEqual(["src/a.ts"]);
    expect(readFileSync(join(files.dir, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    removeMaterialized(files);
  });

  test("a partial clone's missing blob is never fetched through the repository's own ext:: remote", async () => {
    const origin = dir(await makeRepo({ "a.txt": "a\n" }));
    await gitText(origin, ["config", "uploadpack.allowFilter", "true"]);
    const parent = dir(tempDir("polaris-partial-"));
    const clone = join(parent, "clone");
    const flags = ["clone", "-q", "--no-checkout", "--filter=blob:none"];
    await gitText(parent, [...flags, `file://${origin}`, clone], { config: "host" });

    const markers = dir(tempDir("polaris-markers-"));
    write(markers, "remote.sh", `#!/bin/sh\ntouch "${markers}/ran"\nexit 1\n`);
    chmodSync(join(markers, "remote.sh"), 0o755);
    await gitText(clone, ["config", "protocol.ext.allow", "always"]);
    await gitText(clone, ["config", "remote.origin.url", `ext::${join(markers, "remote.sh")}`]);

    const files = await materialize(clone, "HEAD", ["a.txt"]);
    removeMaterialized(files);

    expect(files.paths).toEqual([]);
    expect(existsSync(join(markers, "ran"))).toBe(false);
  });
});
