/**
 * The misspelled word under a right-click in the composer, and its replacement. Radix's menu
 * cancels the native one, so its corrections come from the preload's spellchecker instead.
 */
const WORD_CHARACTER = /[\p{L}\p{M}'’]/u;

const APOSTROPHE = /['’]/u;

export interface Misspelling {
  readonly range: Range;
  readonly suggestions: ReadonlyArray<string>;
}

/** The word around `offset` in `text`, without apostrophes at its edges; null off a word. */
export const wordAround = (text: string, offset: number): { start: number; end: number } | null => {
  let start = offset;
  let end = offset;

  while (start > 0 && WORD_CHARACTER.test(text.charAt(start - 1))) start--;

  while (end < text.length && WORD_CHARACTER.test(text.charAt(end))) end++;

  while (start < end && APOSTROPHE.test(text.charAt(start))) start++;

  while (end > start && APOSTROPHE.test(text.charAt(end - 1))) end--;

  return start === end ? null : { start, end };
};

/** The misspelled word at a viewport point, or null where the word there is spelled right. */
export const misspellingAt = (
  x: number,
  y: number,
  check: (word: string) => ReadonlyArray<string> | null
): Misspelling | null => {
  const caret = document.caretRangeFromPoint(x, y);
  const node = caret?.startContainer;

  if (caret === null || node === undefined || node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent ?? "";
  const bounds = wordAround(text, caret.startOffset);

  if (bounds === null) return null;

  const suggestions = check(text.slice(bounds.start, bounds.end));

  if (suggestions === null) return null;

  const range = document.createRange();

  range.setStart(node, bounds.start);
  range.setEnd(node, bounds.end);

  return { range, suggestions };
};

/** Selects the word and types over it, so the editor sees an ordinary edit (and undo works). */
export const replaceWord = (range: Range, text: string) => {
  const selection = window.getSelection();

  if (selection === null) return;
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand("insertText", false, text);
};
