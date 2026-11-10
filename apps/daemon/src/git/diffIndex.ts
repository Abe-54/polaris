/**
 * `git.diff`'s `fileIndex`: each file's byte range in the patch and its line
 * counts, found in one pass over the bytes without decoding hunk bodies.
 */
import { DiffFile, type DiffFileStatus } from "@polaris/protocol";

const NEWLINE = 0x0a;

const PLUS = 0x2b;

const MINUS = 0x2d;

const decoder = new TextDecoder();

const ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ['"', '"'],
  ["\\", "\\"],
]);

/** Undo git's C-style quoting of a path (`"a\tb"`), including octal-escaped UTF-8 bytes. */
export const unquotePath = (raw: string): string => {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: Array<number> = [];
  const body = raw.slice(1, -1);

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;

    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }

    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));

    if (octal === null) {
      const next = body[i + 1] ?? "";
      bytes.push(...new TextEncoder().encode(ESCAPES.get(next) ?? next));
      i += 1;
    } else {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    }
  }

  return decoder.decode(new Uint8Array(bytes));
};

const stripPrefix = (path: string): string => path.replace(/^[ab]\//, "");

/** `diff --git a/x b/x`: only unambiguous when both halves name the same path. */
const pathFromDiffLine = (line: string): string => {
  const rest = line.slice("diff --git ".length);

  if (rest.startsWith('"')) return stripPrefix(unquotePath(rest.slice(0, rest.indexOf('" ') + 1)));
  const half = (rest.length - 1) / 2;

  return stripPrefix(rest.slice(0, half));
};

interface Building {
  offset: number;
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  inHunk: boolean;
  modeOnly: boolean;
}

const HEADERS: ReadonlyArray<readonly [string, (file: Building, value: string) => void]> = [
  ["new file mode", (file) => void (file.status = "added")],
  ["deleted file mode", (file) => void (file.status = "deleted")],
  ["old mode", (file) => void (file.modeOnly = true)],
  [
    "rename from ",
    (file, value) => {
      file.status = "renamed";
      file.oldPath = unquotePath(value);
    },
  ],
  ["rename to ", (file, value) => void (file.path = unquotePath(value))],
  [
    "copy from ",
    (file, value) => {
      file.status = "copied";
      file.oldPath = unquotePath(value);
    },
  ],
  ["copy to ", (file, value) => void (file.path = unquotePath(value))],
  ["Binary files ", (file) => void (file.binary = true)],
  ["GIT binary patch", (file) => void (file.binary = true)],
  [
    "+++ ",
    (file, value) => {
      if (value !== "/dev/null") file.path = stripPrefix(unquotePath(value));
    },
  ],
];

const applyHeader = (file: Building, line: string) => {
  if (line.startsWith("@@")) {
    file.inHunk = true;

    return;
  }

  for (const [prefix, apply] of HEADERS)
    if (line.startsWith(prefix)) return apply(file, line.slice(prefix.length));
};

const finish = (file: Building, end: number): DiffFile =>
  new DiffFile({
    path: file.path,
    oldPath: file.oldPath,
    status:
      file.status === "modified" && file.modeOnly && file.additions + file.deletions === 0
        ? "mode-changed"
        : file.status,
    offset: file.offset,
    length: end - file.offset,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
  });

const FILE_HEADER = new TextEncoder().encode("diff --git ");

/** Whether a file's header starts at `at`, by its bytes: this runs on every line of the patch. */
const startsWithDiff = (bytes: Uint8Array, at: number): boolean => {
  if (bytes[at] !== FILE_HEADER[0] || at + FILE_HEADER.length > bytes.length) return false;

  for (let k = 1; k < FILE_HEADER.length; k++) if (bytes[at + k] !== FILE_HEADER[k]) return false;

  return true;
};

const countLine = (file: Building, first: number | undefined) => {
  if (first === PLUS) file.additions++;
  else if (first === MINUS) file.deletions++;
};

const newFile = (offset: number, line: string): Building => ({
  offset,
  path: pathFromDiffLine(line),
  oldPath: null,
  status: "modified",
  additions: 0,
  deletions: 0,
  binary: false,
  inHunk: false,
  modeOnly: false,
});

/** One line inside a file: a hunk line is counted, a header line read. */
const readLine = (file: Building, bytes: Uint8Array, start: number, lineEnd: number) => {
  if (file.inHunk) countLine(file, bytes[start]);
  else applyHeader(file, decoder.decode(bytes.subarray(start, lineEnd)));
};

/** Every file of a `git diff` patch, in patch order. */
export const indexDiff = (bytes: Uint8Array): ReadonlyArray<DiffFile> => {
  const files: Array<DiffFile> = [];
  let current: Building | null = null;
  let start = 0;

  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);
    const lineEnd = newline === -1 ? bytes.length : newline;

    if (startsWithDiff(bytes, start)) {
      if (current !== null) files.push(finish(current, start));
      current = newFile(start, decoder.decode(bytes.subarray(start, lineEnd)));
    } else if (current !== null) {
      readLine(current, bytes, start, lineEnd);
    }

    start = lineEnd + 1;
  }

  if (current !== null) files.push(finish(current, bytes.length));

  return files;
};
