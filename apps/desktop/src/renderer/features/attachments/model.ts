/**
 * Attachments, pure: what a drop means, how an upload and a chip read, and
 * the Host-side copy for ⌥-drop (ENG-180). There is no file write in M1, so
 * the copy runs `cp` on the Host through `terminal.open`.
 */
import type { PickedElement } from "../session/state.ts";

/** A file on its way to the Host. */
export interface Upload {
  readonly key: number;
  readonly name: string;
  readonly size: number;
  readonly copy: boolean;
}

/** Drop to attach (staged for the next Turn); ⌥-drop to copy into the Workspace instead. */
export type DropMode = "attach" | "copy";

export const dropMode = (altKey: boolean, canCopy: boolean): DropMode =>
  altKey && canCopy ? "copy" : "attach";

/** A pasted image has no name; give it one the Harness and the user can tell apart. */
export const fileName = (name: string, mimeType: string, index: number) => {
  if (name !== "") return name;
  const extension = /^image\/(png|jpeg|gif|webp)$/.exec(mimeType)?.[1];

  return extension === undefined ? `pasted-${index + 1}` : `pasted-${index + 1}.${extension}`;
};

const UNITS = ["B", "KB", "MB", "GB"] as const;

export const formatSize = (bytes: number) => {
  let size = bytes;
  let unit = 0;

  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit++;
  }

  return `${unit === 0 ? size : size.toFixed(size < 10 ? 1 : 0)} ${UNITS[unit]}`;
};

/** "Attaching 2 files…", "Copying shot.png…". */
export const uploadLine = (uploads: ReadonlyArray<Upload>) => {
  if (uploads.length === 0) return null;
  const copying = uploads.every((u) => u.copy);
  const verb = copying ? "Copying" : "Attaching";

  return uploads.length === 1
    ? `${verb} ${uploads[0]?.name ?? ""}…`
    : `${verb} ${uploads.length} files…`;
};

/** A copy refuses to overwrite: exit 17 means the target already exists. */
export const COPY_EXISTS = 17;

export const copyArgv = (from: string, to: string): ReadonlyArray<string> => [
  "/bin/sh",
  "-c",
  `test -e "$2" && exit ${COPY_EXISTS}; cp "$1" "$2"`,
  "polaris-copy",
  from,
  to,
];

export const joinPath = (dir: string, name: string) =>
  `${dir.replace(/\/+$/, "")}/${name.replaceAll("/", "_")}`;

export const copyOutcome = (code: number | null, name: string, where: string) => {
  if (code === 0) return { ok: true as const, title: `Copied ${name}`, message: `Into ${where}` };

  if (code === COPY_EXISTS)
    return {
      ok: false as const,
      title: `Didn't copy ${name}`,
      message: `${where} already has one`,
    };

  return {
    ok: false as const,
    title: `Couldn't copy ${name}`,
    message: "The copy on the host failed",
  };
};

/** One composer chip: a staged file, or every file of one element picked in the Browser. */
export interface AttachmentChip<A> {
  readonly key: string;
  readonly first: A;
  readonly files: ReadonlyArray<A>;
  readonly pick: PickedElement | null;
  /** The pick's screenshot, for its thumbnail. */
  readonly image: A | null;
}

interface Chippable {
  readonly id: string;
  readonly mimeType: string;
  readonly pick?: PickedElement;
}

/** Chips in the order their first file was staged; a pick's files share one. */
export const chipsOf = <A extends Chippable>(attachments: ReadonlyArray<A>) => {
  const chips: Array<AttachmentChip<A>> = [];
  const byPick = new Map<string, number>();

  for (const a of attachments) {
    const at = a.pick === undefined ? undefined : byPick.get(a.pick.key);
    const image = a.mimeType.startsWith("image/") ? a : null;
    const chip = at === undefined ? undefined : chips[at];

    if (at !== undefined && chip !== undefined) {
      chips[at] = { ...chip, files: [...chip.files, a], image: chip.image ?? image };
      continue;
    }

    if (a.pick !== undefined) byPick.set(a.pick.key, chips.length);
    chips.push({
      key: a.pick?.key ?? a.id,
      first: a,
      files: [a],
      pick: a.pick ?? null,
      image: a.pick === undefined ? null : image,
    });
  }

  return chips;
};

const TITLE_HTML = 300;

/** A pick chip's tooltip: the selector, the page and the start of its HTML. */
export const pickTitle = (pick: PickedElement) => {
  const html = pick.html.length > TITLE_HTML ? `${pick.html.slice(0, TITLE_HTML)}…` : pick.html;

  return `${pick.selector}\n${pick.url}\n\n${html}`;
};
