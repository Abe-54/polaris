import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { SIMULATOR_TOOLS_LOCKFILE, SIMULATOR_TOOLS_MANIFEST } from "./pin.ts";

const Lockfile = Schema.Struct({
  workspaces: Schema.Struct({
    "": Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
  }),
  packages: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)),
});

/** bun.lock is JSON with trailing commas. */
const lock = Schema.decodeUnknownSync(Schema.fromJsonString(Lockfile))(
  SIMULATOR_TOOLS_LOCKFILE.replaceAll(/,(\s*[}\]])/g, "$1")
);

describe("the pinned Simulator tools", () => {
  test("the lockfile was made from the manifest the installer writes, or a frozen install fails", () => {
    expect(lock.workspaces[""].dependencies).toEqual(SIMULATOR_TOOLS_MANIFEST.dependencies);
  });

  test("every package carries an npm sha512 integrity, so bun checks each tarball", () => {
    const unpinned = Object.entries(lock.packages)
      .filter(([, entry]) => !/^sha512-[A-Za-z0-9+/]{86}==$/.test(String(entry.at(-1))))
      .map(([name]) => name);

    expect(unpinned).toEqual([]);
  });
});
