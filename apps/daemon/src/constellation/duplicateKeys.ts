/**
 * True when JSON text repeats a key within one object. Bun keeps the first and JSON.parse
 * the last, so a manifest with one is refused rather than read two ways (ENG-276).
 */
const STRING = /"(?:[^"\\]|\\.)*"/y;

/** The decoded key a string literal names; unparseable text counts as itself. */
const decoded = (literal: string): string => {
  try {
    return String(JSON.parse(literal));
  } catch {
    return literal;
  }
};

interface Scan {
  /** One frame per open object or array: the keys seen, or null for an array. */
  readonly frames: Array<Set<string> | null>;
  expectingKey: boolean;
}

/** Reads the string literal at `i`; true when it repeats a key. Returns its length too. */
const string = (text: string, i: number, scan: Scan) => {
  STRING.lastIndex = i;
  const literal = STRING.exec(text)?.[0] ?? '"';
  const keys = scan.frames.at(-1);
  let repeated = false;

  if (scan.expectingKey && keys) {
    const key = decoded(literal);
    repeated = keys.has(key);
    keys.add(key);
  }

  scan.expectingKey = false;

  return { repeated, length: literal.length };
};

const punctuation = (c: string, scan: Scan) => {
  if (c === "{" || c === "[") {
    scan.frames.push(c === "{" ? new Set() : null);
    scan.expectingKey = c === "{";
  } else if (c === "}" || c === "]") scan.frames.pop();
  else if (c === ",") scan.expectingKey = scan.frames.at(-1) instanceof Set;
};

export const hasDuplicateKeys = (text: string) => {
  const scan: Scan = { frames: [], expectingKey: false };

  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";

    if (c !== '"') punctuation(c, scan);
    else {
      const { repeated, length } = string(text, i, scan);

      if (repeated) return true;
      i += length - 1;
    }
  }

  return false;
};
