/**
 * A command as a short line (ENG-590): a leading `cd <the session's own directory> &&` goes, since
 * the command already runs there; what still doesn't fit is cut in the middle, keeping both ends.
 */

const LEADING_CD = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&\s*/;

const normalized = (dir: string) => (dir.length > 1 ? dir.replace(/\/+$/, "") : dir);

/** `command` without a leading `cd <dir> &&` into one of `dirs`; anything else is kept whole. */
export const withoutOwnCd = (command: string, dirs: ReadonlyArray<string>): string => {
  const match = LEADING_CD.exec(command);
  const target = match?.[1] ?? match?.[2] ?? match?.[3];

  if (match === null || target === undefined) return command;

  const own = dirs.some((dir) => dir !== "" && normalized(dir) === normalized(target));

  return own ? command.slice(match[0].length) : command;
};

/** `text` in at most `points` code points, its middle replaced by "…". */
export const middleCut = (text: string, points: number): string => {
  const chars = Array.from(text);

  if (chars.length <= points) return text;

  const kept = Math.max(0, points - 1);
  const head = Math.ceil(kept / 2);

  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (kept - head)).join("")}`;
};

/** About two lines of the takeover's 13pt mono on the narrowest lock screen. */
export const LIVE_COMMAND_POINTS = 72;

/** A command for the Live Activity's takeover: its own `cd` dropped, then cut in the middle. */
export const commandLine = (
  command: string,
  dirs: ReadonlyArray<string>,
  points = LIVE_COMMAND_POINTS
): string => middleCut(withoutOwnCd(command.trim(), dirs), points);
