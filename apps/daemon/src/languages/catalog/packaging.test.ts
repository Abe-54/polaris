import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { catalog } from ".";
import { Artifact, Packaging } from "./model";
import { packagedFiles, packagedRoot, verifyPackaging, type ArchiveEntry } from "./packaging";

const hash = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const sourceBytes = Buffer.from("immutable archive fixture");

const file = (path: string, content = path): ArchiveEntry => ({
  path,
  kind: "file",
  mode: 420,
  bytes: Buffer.from(content),
});

const entries = [
  file("LICENSE"),
  file("meta/template/string.lua"),
  file("bin/main.lua"),
  file("meta/3rd/optional/library.lua"),
];

const files = packagedFiles(entries);

const root = packagedRoot(files);

const manifestBytes = Buffer.from(
  JSON.stringify({
    filter: "lua-core-v1",
    sourceIntegrity: hash(sourceBytes),
    postFilterIntegrity: root,
    files,
  })
);

const original = catalog.tools.find((tool) => tool.id === "lua-language-server")!.artifacts[0]!;

const artifact = Artifact.make({
  ...original,
  audit: "pending",
  integrity: hash(sourceBytes),
  packaging: {
    filter: "lua-core-v1",
    sourceIntegrity: hash(sourceBytes),
    manifest: "packaging/lua.json",
    manifestIntegrity: hash(manifestBytes),
    postFilterIntegrity: root,
    disableThirdPartyDiscovery: true,
  },
});

const input = {
  artifact,
  sourceBytes,
  manifestBytes,
  entries,
  installedEntries: entries.filter((entry) => !entry.path.startsWith("meta/3rd/")),
  thirdPartyDiscovery: false,
};

test("filter removes only optional annotations and retains exact template/legal/runtime bytes", () => {
  expect(files.map((entry) => entry.path)).toEqual([
    "LICENSE",
    "bin/main.lua",
    "meta/template/string.lua",
  ]);
  expect(verifyPackaging(input)).toEqual([]);
  expect(packagedRoot(packagedFiles([...entries].reverse()))).toBe(root);
});

test("missing or altered retained files and executable modes cannot pass the pinned resulting root", () => {
  for (const path of ["LICENSE", "meta/template/string.lua", "bin/main.lua"]) {
    expect(
      verifyPackaging({ ...input, entries: entries.filter((entry) => entry.path !== path) }).length
    ).toBeGreaterThan(0);
    expect(
      verifyPackaging({
        ...input,
        entries: entries.map((entry) => (entry.path === path ? file(path, "corrupt") : entry)),
      }).length
    ).toBeGreaterThan(0);
  }

  expect(
    verifyPackaging({ ...input, entries: entries.map((entry) => ({ ...entry, mode: 493 })) })
  ).toContain("packaging-output-integrity");
});

test("installer must actually remove excluded annotations and verify staged file bytes", () => {
  expect(verifyPackaging({ ...input, installedEntries: entries })).toContain(
    "packaging-excluded-entry-present"
  );
  expect(
    verifyPackaging({ ...input, installedEntries: input.installedEntries.slice(1) })
  ).toContain("packaging-output-integrity");
  expect(
    verifyPackaging({ ...input, installedEntries: [...input.installedEntries, file("unexpected")] })
  ).toContain("packaging-output-integrity");
});

test("source and manifest corruption, unsafe links even in excluded trees, and discovery fail closed", () => {
  expect(verifyPackaging({ ...input, sourceBytes: Buffer.from("changed") })).toContain(
    "packaging-source-integrity"
  );
  expect(verifyPackaging({ ...input, manifestBytes: Buffer.from("changed") })).toContain(
    "packaging-manifest-integrity"
  );
  expect(verifyPackaging({ ...input, thirdPartyDiscovery: true })).toContain(
    "packaging-third-party-discovery"
  );

  for (const path of ["../escape", "/absolute", "meta/3rd/../../escape", "meta/3rd/link"]) {
    const extra: ArchiveEntry = {
      path,
      kind: "symlink",
      mode: 493,
      bytes: Buffer.from("../../escape"),
    };

    expect(verifyPackaging({ ...input, entries: [...entries, extra] })).toContain(
      "packaging-input-invalid"
    );
  }
});

test("malformed portable manifest paths fail schema parsing", () => {
  for (const manifest of [
    "",
    "/absolute",
    "C:drive",
    "a\\b",
    "a\0b",
    ".",
    "..",
    "a/../b",
    "a/./b",
    "a//b",
    "a/",
    "x".repeat(4097),
  ]) {
    expect(() =>
      Schema.decodeUnknownSync(Packaging)({ ...artifact.packaging, manifest })
    ).toThrow();
  }

  expect(
    Schema.decodeUnknownSync(Packaging)({
      ...artifact.packaging,
      manifest: "packaging/.valid.json",
    }).manifest
  ).toBe("packaging/.valid.json");
});
