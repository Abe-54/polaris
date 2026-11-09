/** POSIX shell words for a pasted curl command: quotes, `$'…'`, escapes and `\` line continuations. */

const ANSI_ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["0", "\0"],
]);

interface Cursor {
  readonly text: string;
  at: number;
}

const single = (cursor: Cursor) => {
  const end = cursor.text.indexOf("'", cursor.at);

  if (end < 0) return undefined;
  const value = cursor.text.slice(cursor.at, end);
  cursor.at = end + 1;

  return value;
};

const ansi = (cursor: Cursor) => {
  let value = "";

  for (; cursor.at < cursor.text.length; cursor.at++) {
    const char = cursor.text[cursor.at]!;

    if (char === "'") {
      cursor.at++;

      return value;
    }

    if (char === "\\") {
      const next = cursor.text[++cursor.at] ?? "";
      value += ANSI_ESCAPES.get(next) ?? `\\${next}`;
    } else value += char;
  }

  return undefined;
};

/** Inside double quotes a backslash escapes only `$`, `` ` ``, `"`, `\` and a newline. */
const double = (cursor: Cursor) => {
  let value = "";

  for (; cursor.at < cursor.text.length; cursor.at++) {
    const char = cursor.text[cursor.at]!;

    if (char === '"') {
      cursor.at++;

      return value;
    }

    if (char === "\\" && /[$`"\\\n]/.test(cursor.text[cursor.at + 1] ?? "")) {
      const next = cursor.text[++cursor.at]!;

      if (next !== "\n") value += next;
    } else value += char;
  }

  return undefined;
};

const quoted = (cursor: Cursor, char: string) => {
  if (char === "'") return single(cursor);

  if (char === '"') return double(cursor);
  cursor.at++;

  return ansi(cursor);
};

/** The words of `text`, or undefined when a quote is left open. */
export const shellWords = (text: string): string[] | undefined => {
  const cursor: Cursor = { text: text.replace(/\\\r?\n/g, " "), at: 0 };
  const words: string[] = [];
  let word: string | undefined;

  while (cursor.at < cursor.text.length) {
    const char = cursor.text[cursor.at]!;

    if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      cursor.at++;
    } else if (
      char === "'" ||
      char === '"' ||
      (char === "$" && cursor.text[cursor.at + 1] === "'")
    ) {
      cursor.at++;
      const value = quoted(cursor, char);

      if (value === undefined) return undefined;
      word = (word ?? "") + value;
    } else if (char === "\\") {
      word = (word ?? "") + (cursor.text[cursor.at + 1] ?? "");
      cursor.at += 2;
    } else {
      word = (word ?? "") + char;
      cursor.at++;
    }
  }

  if (word !== undefined) words.push(word);

  return words;
};
