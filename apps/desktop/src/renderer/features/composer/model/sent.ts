/**
 * A sent message read back into the composer's chips: `/name` and `$name` for
 * the Harness's listed commands, `@path` for file and folder mentions. The rest
 * stays text, so a message reads as it did in the composer.
 */
import { type CommandOption, commandHead, insertsChip, placeable, type Sigil } from "./commands.ts";
import { tokenStarts } from "./trigger.ts";

export type SentPiece =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "chip";
      readonly chip: "skill" | "command" | "file" | "folder";
      readonly sigil: Sigil | "@";
      /** A command's name, or a mention's path. */
      readonly name: string;
    };

/** A command word, a quoted mention (Claude Code's form for paths with spaces), or a bare one. */
const WORD = /([/$])([\w][\w:.-]*)(?=\s|$)|@"([^"\n]+)"|@(\S+)/g;

/** Whether a message may name a command, so reading it back needs the Harness's list. */
export const mayNameCommand = (text: string) => /(^|\s)[/$][\w]/.test(text);

/** A bare `@word` is a mention only when it reads as a path, so `@claude` stays text. */
const pathLike = (path: string) => /[/.]/.test(path) && !path.endsWith(".");

type Chip = Extract<SentPiece, { kind: "chip" }>;

const commandChip = (
  sigil: Sigil,
  name: string,
  options: ReadonlyArray<CommandOption>,
  head: boolean
): Chip | null => {
  const option = options.find(
    (o) => o.sigil === sigil && o.name === name && insertsChip(o) && placeable(o, head)
  );

  return option === undefined
    ? null
    : { kind: "chip", chip: option.kind === "skill" ? "skill" : "command", sigil, name };
};

const mentionChip = (path: string): Chip => ({
  kind: "chip",
  chip: path.endsWith("/") ? "folder" : "file",
  sigil: "@",
  name: path,
});

/** The chip a matched word stands for, if any; `head` says whether it leads the message. */
const chipOf = (
  match: RegExpMatchArray,
  options: ReadonlyArray<CommandOption>,
  head: boolean
): Chip | null => {
  const [, sigil, name, quoted, bare] = match;

  if (sigil !== undefined && name !== undefined)
    // SAFETY: WORD's first group only matches "/" or "$".
    return commandChip(sigil as Sigil, name, options, head);

  if (quoted !== undefined) return mentionChip(quoted);

  return bare !== undefined && pathLike(bare) ? mentionChip(bare) : null;
};

/** The message cut into text and chips, in order; one text piece when nothing is a chip. */
export const sentPieces = (
  text: string,
  options: ReadonlyArray<CommandOption>
): ReadonlyArray<SentPiece> => {
  const pieces: Array<SentPiece> = [];
  const chips: Array<Chip> = [];
  let from = 0;

  for (const match of text.matchAll(WORD)) {
    const before = text.slice(0, match.index);

    if (!tokenStarts(before)) continue;

    // Only chips and whitespace before it, as the editor's head rule reads it.
    const leads =
      text.slice(from, match.index).trim() === "" &&
      pieces.every((p) => p.kind === "chip" || p.text.trim() === "");

    const chip = chipOf(match, options, commandHead(leads, chips));

    if (chip === null) continue;

    if (match.index > from) pieces.push({ kind: "text", text: text.slice(from, match.index) });
    pieces.push(chip);
    chips.push(chip);
    from = match.index + match[0].length;
  }

  if (from < text.length) pieces.push({ kind: "text", text: text.slice(from) });

  return pieces;
};
