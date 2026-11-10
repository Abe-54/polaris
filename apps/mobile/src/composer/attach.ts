/**
 * Attaching a photo or file to a composer (DESIGN.md, Attachments in the composer): each pick
 * stages on the Host at once (`attachments.stage`, the bytes as a Wire blob) and shows as a chip.
 */
import type { Attachment, AttachmentId, SessionId, WorkspaceId } from "@polaris/protocol";
import { Effect } from "effect";
import type { HostConnection } from "../runtime/hostConnection.ts";

/** One photo or file the user picked, before it reaches the Host. */
export interface Picked {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  /** Null when the picker didn't say. */
  readonly size: number | null;
  readonly isImage: boolean;
}

/** Where a pick is staged: the Host, its Workspace, and the session once it exists. */
export interface StageTarget {
  readonly connection: HostConnection;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId | null;
}

export type ReadBytes = (uri: string) => Promise<Uint8Array>;

/** Sends the pick's bytes to the Host and stages them; rejects with the Host's reason. */
export const stagePicked = async (
  target: StageTarget,
  picked: Picked,
  read: ReadBytes
): Promise<Attachment> => {
  const bytes = await read(picked.uri);
  const live = target.connection.live();

  if (live === null) throw new Error(`${target.connection.name} isn't connected`);

  return Effect.runPromise(
    Effect.flatMap(live.blobs.offer(bytes), (blobId) =>
      live.client["attachments.stage"]({
        sessionId: target.sessionId,
        workspaceId: target.workspaceId,
        name: picked.name,
        mimeType: picked.mimeType,
        blobId,
      })
    )
  );
};

/** A chip: the name, its size, a thumbnail for images, and how staging went. */
export interface Chip {
  readonly key: string;
  readonly name: string;
  readonly size: number | null;
  /** The phone's own copy, shown at 16px; null for files that aren't images. */
  readonly thumbnailUri: string | null;
  readonly status: "staging" | "staged" | "failed";
  readonly attachment: Attachment | null;
  readonly failure: string | null;
}

const KB = 1024;

/** "94 B", "12 KB", "3.4 MB". */
export const sizeLabel = (bytes: number): string => {
  if (bytes < KB) return `${bytes} B`;

  if (bytes < KB * KB) return `${Math.round(bytes / KB)} KB`;

  return `${(bytes / (KB * KB)).toFixed(1)} MB`;
};

/** "Attaching 2 files…" while uploads run, else the first failure; null when quiet. */
export const attachCaption = (chips: ReadonlyArray<Chip>): string | null => {
  const staging = chips.filter((chip) => chip.status === "staging").length;

  if (staging > 0) return `Attaching ${staging} ${staging === 1 ? "file" : "files"}…`;
  const failed = chips.find((chip) => chip.status === "failed");

  return failed === undefined ? null : `Couldn't attach ${failed.name}: ${failed.failure ?? ""}`;
};

/** What Send and Start carry: the staged ones, in the order attached. */
export const stagedIds = (chips: ReadonlyArray<Chip>): ReadonlyArray<AttachmentId> =>
  chips.flatMap((chip) => (chip.attachment === null ? [] : [chip.attachment.id]));

/** `stage` rejects with an Error: the Host's refusal, or the read or connection that failed. */
const failureOf = (error: Error | undefined) =>
  error !== undefined && error.message !== "" ? error.message : "the host refused it";

/** The staged chips one Send or Queue carries; `done` removes only those. */
export interface Submission {
  readonly ids: ReadonlyArray<AttachmentId>;
  /** The same, whole: what the thread shows of a message still on its way. */
  readonly attachments: ReadonlyArray<Attachment>;
  readonly done: () => void;
}

export interface AttachmentStore {
  readonly chips: () => ReadonlyArray<Chip>;
  readonly subscribe: (listener: () => void) => () => void;
  /** Shows each pick as a chip at once and stages it. */
  readonly add: (picks: ReadonlyArray<Picked>) => void;
  readonly remove: (key: string) => void;
  /** Puts files already staged on the Host back as chips: a steer that didn't land. */
  readonly restore: (attachments: ReadonlyArray<Attachment>) => void;
  /** The staged chips now; chips added or replaced after this stay when it's done. */
  readonly submission: () => Submission;
  /** After Send or Start: the composer starts empty again. */
  readonly clear: () => void;
}

/** A composer's chips; a pick that finishes after it was removed or cleared is dropped. */
export const attachmentStore = (
  stage: (picked: Picked) => Promise<Attachment>
): AttachmentStore => {
  let chips: ReadonlyArray<Chip> = [];
  let next = 0;
  const listeners = new Set<() => void>();

  const set = (value: ReadonlyArray<Chip>) => {
    chips = value;
    listeners.forEach((listener) => listener());
  };

  const settle = (key: string, patch: Partial<Chip>) => {
    if (chips.some((chip) => chip.key === key))
      set(chips.map((chip) => (chip.key === key ? { ...chip, ...patch } : chip)));
  };

  const add = (picks: ReadonlyArray<Picked>) => {
    const added = picks.map((picked): Chip => ({
      key: `${++next}`,
      name: picked.name,
      size: picked.size,
      thumbnailUri: picked.isImage ? picked.uri : null,
      status: "staging",
      attachment: null,
      failure: null,
    }));

    set([...chips, ...added]);
    added.forEach((chip, index) => {
      const picked = picks[index];

      if (picked === undefined) return;
      stage(picked).then(
        (attachment) => settle(chip.key, { status: "staged", attachment, size: attachment.size }),
        (error: Error | undefined) =>
          settle(chip.key, { status: "failed", failure: failureOf(error) })
      );
    });
  };

  return {
    chips: () => chips,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    add,
    remove: (key) => set(chips.filter((chip) => chip.key !== key)),
    restore: (attachments) => {
      const held = new Set(stagedIds(chips));

      const back = attachments
        .filter((attachment) => !held.has(attachment.id))
        .map((attachment): Chip => ({
          key: `${++next}`,
          name: attachment.name,
          size: attachment.size,
          thumbnailUri: null,
          status: "staged",
          attachment,
          failure: null,
        }));

      if (back.length > 0) set([...chips, ...back]);
    },
    submission: () => {
      const sent = chips.filter((chip) => chip.attachment !== null);
      const keys = new Set(sent.map((chip) => chip.key));

      return {
        ids: stagedIds(sent),
        attachments: sent.flatMap((chip) => (chip.attachment === null ? [] : [chip.attachment])),
        done: () => set(chips.filter((chip) => !keys.has(chip.key))),
      };
    },
    clear: () => set([]),
  };
};
