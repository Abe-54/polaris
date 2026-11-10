/**
 * `holdsNoGitlinks` on index files written here to gitformat-index's layout, for shapes git
 * rarely writes; `indexFile.slow.test.ts` reads the indexes git itself writes.
 */
import { describe, expect, test } from "bun:test";
import { holdsNoGitlinks } from "./indexFile.ts";

const FILE = 0o100644;

const SYMLINK = 0o120000;

const GITLINK = 0o160000;

interface Entry {
  readonly mode: number;
  readonly path: string;
  /** Sets the extended flag and writes the second flags word (version 3 and later). */
  readonly extended?: boolean;
}

interface Extension {
  readonly signature: string;
  readonly data: Uint8Array;
}

interface IndexLayout {
  readonly version: number;
  readonly hashBytes?: number;
  readonly entries: ReadonlyArray<Entry>;
  readonly extensions?: ReadonlyArray<Extension>;
}

const u16 = (value: number) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);

  return bytes;
};

const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);

  return bytes;
};

/** git's offset varint (varint.c). */
const varint = (value: number) => {
  const bytes = [value & 127];
  let rest = Math.floor(value / 128);

  while (rest > 0) {
    rest -= 1;
    bytes.unshift(128 | (rest & 127));
    rest = Math.floor(rest / 128);
  }

  return Buffer.from(bytes);
};

const sharedPrefix = (a: string, b: string) => {
  let n = 0;

  while (n < a.length && n < b.length && a[n] === b[n]) n++;

  return n;
};

const entryBytes = (layout: IndexLayout, entry: Entry, previous: string) => {
  const head = Buffer.concat([
    Buffer.alloc(24),
    u32(entry.mode),
    Buffer.alloc(12),
    Buffer.alloc(layout.hashBytes ?? 20, 0xab),
    u16((entry.extended ? 0x4000 : 0) | Math.min(entry.path.length, 0xfff)),
    entry.extended ? u16(0x2000) : Buffer.alloc(0),
  ]);

  if (layout.version === 4) {
    const kept = sharedPrefix(previous, entry.path);

    return Buffer.concat([
      head,
      varint(previous.length - kept),
      Buffer.from(`${entry.path.slice(kept)}\0`),
    ]);
  }

  const length = head.length + entry.path.length;

  return Buffer.concat([head, Buffer.from(entry.path), Buffer.alloc(8 - (length % 8))]);
};

const indexBytes = (layout: IndexLayout): Buffer => {
  const parts = [Buffer.from("DIRC"), u32(layout.version), u32(layout.entries.length)];
  let previous = "";

  for (const entry of layout.entries) {
    parts.push(entryBytes(layout, entry, previous));
    previous = entry.path;
  }

  for (const extension of layout.extensions ?? []) {
    parts.push(
      Buffer.from(extension.signature),
      u32(extension.data.length),
      Buffer.from(extension.data)
    );
  }

  return Buffer.concat([...parts, Buffer.alloc(layout.hashBytes ?? 20)]);
};

/** Paths with the split index's signature in them, one long enough for a two-byte varint. */
const LINK_PATHS: ReadonlyArray<Entry> = [
  { mode: FILE, path: "docs/symlink.md" },
  { mode: SYMLINK, path: "link" },
  { mode: FILE, path: `linkedDevices/${"deep/".repeat(40)}list.ts` },
  { mode: FILE, path: "linkedDevices/list.ts" },
];

const gitlinkLast = [...LINK_PATHS, { mode: GITLINK, path: "vendor/lib" }];

/** An optional extension whose data holds a gitlink's mode bytes and the split index's signature. */
const noisy: Extension = {
  signature: "TREE",
  data: Buffer.concat([Buffer.from("link"), u32(GITLINK), Buffer.from("link")]),
};

describe("holdsNoGitlinks", () => {
  test.each([2, 3, 4])("version %i: paths holding `link` are not gitlinks", (version) => {
    const bytes = indexBytes({ version, entries: LINK_PATHS, extensions: [noisy] });
    expect(holdsNoGitlinks(bytes, 20)).toBe(true);
  });

  test.each([2, 3, 4])("version %i: a gitlink after other entries is found", (version) => {
    expect(holdsNoGitlinks(indexBytes({ version, entries: gitlinkLast }), 20)).toBe(false);
  });

  test.each([3, 4])("version %i: a gitlink after an entry with extended flags is found", (v) => {
    const extended = { mode: FILE, path: "intent.ts", extended: true };
    const clean = indexBytes({ version: v, entries: [extended, ...LINK_PATHS] });
    const linked = indexBytes({ version: v, entries: [extended, ...gitlinkLast] });
    expect(holdsNoGitlinks(clean, 20)).toBe(true);
    expect(holdsNoGitlinks(linked, 20)).toBe(false);
  });

  test.each([2, 4])("version %i: a name past the flags' 4095 bytes is followed", (version) => {
    const long = { mode: FILE, path: `a/${"n".repeat(5000)}` };
    const clean = indexBytes({ version, entries: [long, { mode: FILE, path: "b" }] });
    const linked = indexBytes({ version, entries: [long, { mode: GITLINK, path: "b" }] });
    expect(holdsNoGitlinks(clean, 20)).toBe(true);
    expect(holdsNoGitlinks(linked, 20)).toBe(false);
  });

  test.each([2, 4])("version %i: 32-byte object names (SHA-256)", (version) => {
    const clean = indexBytes({ version, hashBytes: 32, entries: LINK_PATHS });
    const linked = indexBytes({ version, hashBytes: 32, entries: gitlinkLast });
    expect(holdsNoGitlinks(clean, 32)).toBe(true);
    expect(holdsNoGitlinks(linked, 32)).toBe(false);
    // Read with the wrong hash it can't be followed, so it may hold one.
    expect(holdsNoGitlinks(clean, 20)).toBe(false);
  });

  test("a split index's entries live elsewhere, so it may hold one", () => {
    const link = { signature: "link", data: Buffer.alloc(20) };
    expect(holdsNoGitlinks(indexBytes({ version: 2, entries: [], extensions: [link] }), 20)).toBe(
      false
    );
  });

  test.each([
    ["a sparse index's directory entry", { version: 3, entries: [{ mode: 0o040000, path: "x/" }] }],
    [
      "an extension git must understand that this doesn't",
      {
        version: 2,
        entries: LINK_PATHS,
        extensions: [{ signature: "zzzz", data: Buffer.alloc(4) }],
      },
    ],
    [
      "extended flags in version 2",
      {
        version: 2,
        entries: [{ mode: FILE, path: "a", extended: true }],
      },
    ],
    ["a version after 4", { version: 5, entries: LINK_PATHS }],
  ] satisfies ReadonlyArray<[string, IndexLayout]>)("%s may hold one", (_, layout) => {
    expect(holdsNoGitlinks(indexBytes(layout), 20)).toBe(false);
  });

  test("an index cut short, or with bytes past its last extension, may hold one", () => {
    const whole = indexBytes({ version: 2, entries: LINK_PATHS, extensions: [noisy] });
    expect(holdsNoGitlinks(whole.subarray(0, whole.length - 9), 20)).toBe(false);
    expect(holdsNoGitlinks(Buffer.concat([whole, Buffer.alloc(3)]), 20)).toBe(false);
    expect(holdsNoGitlinks(Buffer.from("not an index"), 20)).toBe(false);
    expect(holdsNoGitlinks(new Uint8Array(), 20)).toBe(false);
  });
});
