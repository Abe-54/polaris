/** One line of a file with its offsets; `end` excludes the line ending, `next` starts the next line. */
export interface Line {
  readonly text: string;
  readonly number: number;
  readonly start: number;
  readonly end: number;
  readonly next: number;
}

export const splitLines = (text: string): Line[] => {
  const lines: Line[] = [];
  const pattern = /\r?\n/g;
  let start = 0;
  let number = 1;

  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    lines.push({
      text: text.slice(start, match.index),
      number,
      start,
      end: match.index,
      next: pattern.lastIndex,
    });
    start = pattern.lastIndex;
    number++;
  }

  if (start < text.length)
    lines.push({ text: text.slice(start), number, start, end: text.length, next: text.length });

  return lines;
};

/** The file's line ending: CRLF when its first line ends so, LF otherwise. */
export const lineEnding = (text: string) => (/^[^\n]*\r\n/.test(text) ? "\r\n" : "\n");

export const isBlank = (line: string) => line.trim() === "";

export const isComment = (line: string) => /^\s*(?:#|\/\/)/.test(line);
