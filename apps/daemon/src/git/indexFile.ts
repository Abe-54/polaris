/**
 * git's index file, read just far enough to rule out gitlinks (submodules): each entry's
 * mode and each extension's signature, in versions 2, 3 and 4 (gitformat-index).
 */

const SIGNATURE = 0x44495243; // "DIRC"

/** The signature, the version and the entry count. */
const HEADER_BYTES = 12;

/** An entry's stat fields, before its object name. */
const STAT_BYTES = 40;

const MODE_AT = 24;

const TYPE_MASK = 0o170000;

const REGULAR_FILE = 0o100000;

const SYMLINK = 0o120000;

/** In an entry's flags: a second flags word follows (version 3 and later). */
const EXTENDED = 0x4000;

/** In an entry's flags: the name's length, or this when it is longer. */
const NAME_MASK = 0xfff;

interface Walk {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  /** Where the trailing checksum starts: entries and extensions end here. */
  readonly end: number;
  readonly hashBytes: number;
  readonly version: number;
}

/** Whether the name the flags declare is the name found on disk. */
const nameFits = (declared: number, found: number): boolean =>
  found > 0 && (declared < NAME_MASK ? found === declared : found >= NAME_MASK);

/** Versions 2 and 3: the whole name, then 1 to 8 NULs up to a multiple of 8 bytes. */
const paddedEnd = (walk: Walk, at: number, nameAt: number, declared: number): number | null => {
  const nul = walk.bytes.indexOf(0, nameAt);

  if (nul === -1 || !nameFits(declared, nul - nameAt)) return null;
  const next = at + ((nul - at + 8) & ~7);

  if (next > walk.end) return null;

  for (let k = nul; k < next; k++) if (walk.bytes[k] !== 0) return null;

  return next;
};

/** git's offset varint: how many bytes of the previous name this one drops. */
const readVarint = (bytes: Uint8Array, at: number): { value: number; next: number } | null => {
  let byte = bytes[at];
  let value = (byte ?? 0) & 127;
  let next = at + 1;

  // Five bytes hold any name length git can write.
  while (byte !== undefined && (byte & 128) !== 0 && next - at < 5) {
    byte = bytes[next++];
    value = (value + 1) * 128 + ((byte ?? 0) & 127);
  }

  return byte === undefined || (byte & 128) !== 0 ? null : { value, next };
};

/** Version 4: the name drops `n` bytes of the previous one and adds a NUL-terminated rest; no padding. */
const compressedEnd = (
  walk: Walk,
  nameAt: number,
  declared: number,
  previousName: number
): { next: number; name: number } | null => {
  const dropped = readVarint(walk.bytes, nameAt);

  if (dropped === null || dropped.value > previousName) return null;
  const nul = walk.bytes.indexOf(0, dropped.next);
  const name = previousName - dropped.value + (nul - dropped.next);

  if (nul === -1 || nul >= walk.end || !nameFits(declared, name)) return null;

  return { next: nul + 1, name };
};

/** Where the entry at `at` ends and how long its name is; null for a gitlink or anything unexpected. */
const entryEnd = (
  walk: Walk,
  at: number,
  previousName: number
): { next: number; name: number } | null => {
  const flagsAt = at + STAT_BYTES + walk.hashBytes;

  if (flagsAt + 4 > walk.end) return null;
  const type = walk.view.getUint32(at + MODE_AT) & TYPE_MASK;

  // A gitlink, a sparse index's directory, or a mode git doesn't write.
  if (type !== REGULAR_FILE && type !== SYMLINK) return null;
  const flags = walk.view.getUint16(flagsAt);
  const extended = (flags & EXTENDED) !== 0;

  if (extended && walk.version === 2) return null;
  const nameAt = flagsAt + (extended ? 4 : 2);
  const declared = flags & NAME_MASK;

  if (walk.version === 4) return compressedEnd(walk, nameAt, declared, previousName);
  const next = paddedEnd(walk, at, nameAt, declared);

  return next === null ? null : { next, name: 0 };
};

/** Whether only optional extensions (`A`-`Z` first) fill `at` to the checksum: no split index's `link`, no `sdir`. */
const onlyOptionalExtensions = (walk: Walk, from: number): boolean => {
  let at = from;

  while (at < walk.end) {
    const first = walk.bytes[at] ?? 0;

    if (at + 8 > walk.end || first < 0x41 || first > 0x5a) return false;
    at += 8 + walk.view.getUint32(at + 4);
  }

  return at === walk.end;
};

/**
 * True only when this index certainly has no gitlink: every entry is a file or a symlink and
 * no entry lives elsewhere (a split index). False for anything this can't follow to the end.
 */
export const holdsNoGitlinks = (bytes: Uint8Array, hashBytes: number): boolean => {
  if (bytes.length < HEADER_BYTES + hashBytes) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4);

  if (view.getUint32(0) !== SIGNATURE || version < 2 || version > 4) return false;
  const walk: Walk = { bytes, view, end: bytes.length - hashBytes, hashBytes, version };
  let at = HEADER_BYTES;
  let name = 0;

  for (let left = view.getUint32(8); left > 0; left--) {
    const entry = entryEnd(walk, at, name);

    if (entry === null) return false;
    at = entry.next;
    name = entry.name;
  }

  return onlyOptionalExtensions(walk, at);
};
