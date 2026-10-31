/**
 * JSON re-indented without parsing (RU2 F9): the inspector shows each lexeme as stored, so big
 * numbers, `1.50`, duplicate keys and key order survive. Text that isn't JSON comes back as it is.
 */

const PAIRS = new Map([
  ["{", "}"],
  ["[", "]"],
]);

const OPENERS = new Map([
  ["}", "{"],
  ["]", "["],
]);

/** Where the string starting at `at` ends (past its closing quote), or -1 when it doesn't. */
const stringEnd = (text: string, at: number) => {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }

  return -1;
};

/** The next character that isn't whitespace, from `at`. */
const nextSolid = (text: string, at: number) => /\S/.exec(text.slice(at, at + 64))?.[0];

interface Writer {
  readonly out: Array<string>;
  readonly stack: Array<string>;
  readonly indent: number;
}

const pad = (w: Writer) => `\n${" ".repeat(w.stack.length * w.indent)}`;

/** Writes the bracket at `at`; false when it closes one that isn't open. */
const bracket = (w: Writer, text: string, at: number): boolean => {
  const ch = text[at] ?? "";
  const close = PAIRS.get(ch);

  if (close !== undefined) {
    w.stack.push(ch);
    w.out.push(nextSolid(text, at + 1) === close ? ch : `${ch}${pad(w)}`);

    return true;
  }

  const opener = OPENERS.get(ch);

  if (w.stack.pop() !== opener) return false;
  w.out.push(w.out.at(-1) === opener ? ch : `${pad(w)}${ch}`);

  return true;
};

/** `text` indented by `indent` spaces a level, or null when its brackets or strings don't close. */
const reindented = (text: string, indent: number): string | null => {
  const w: Writer = { out: [], stack: [], indent };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";

    if (ch === '"') {
      const end = stringEnd(text, i);

      if (end === -1) return null;
      w.out.push(text.slice(i, end));
      i = end - 1;
    } else if (PAIRS.has(ch) || OPENERS.has(ch)) {
      if (!bracket(w, text, i)) return null;
    } else if (ch === ",") w.out.push(`,${pad(w)}`);
    else if (ch === ":") w.out.push(": ");
    else if (/\S/.test(ch)) w.out.push(ch);
  }

  return w.stack.length === 0 ? w.out.join("") : null;
};

/** JSON text indented two spaces a level, each value's text unchanged; else the text itself. */
export const indentJson = (text: string, indent = 2) => reindented(text, indent) ?? text;
