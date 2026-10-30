/**
 * The composer's uploads: each pasted or dropped file is staged on the Host
 * at once (then sent with the next Turn by id), or with ⌥ copied into the
 * Workspace. Tracks what is in flight, and keeps image thumbnails for chips.
 */
import { useState } from "react";
import type { StagedAttachment } from "../session/state.ts";
import { type DropMode, fileName, type Upload } from "./model.ts";
import { copyIntoWorkspace, type StageTarget, stageFile, thumbnail } from "./stage.ts";

/** Image thumbnails by attachment id; small data URLs, kept for the app's life. */
const thumbnails = new Map<string, string>();

export const thumbnailOf = (attachmentId: string) => thumbnails.get(attachmentId) ?? null;

export const keepThumbnail = (attachmentId: string, url: string) =>
  thumbnails.set(attachmentId, url);

export interface UploadTarget extends StageTarget {
  /** Where ⌥-drop copies to (the session's cwd) and how to name it; null turns copying off. */
  readonly copyTo: { readonly path: string; readonly shown: string } | null;
}

let nextKey = 0;

export const useUploads = (
  target: UploadTarget,
  onStaged: (attachment: StagedAttachment) => void
) => {
  const [uploads, setUploads] = useState<ReadonlyArray<Upload>>([]);

  const one = async (file: File, name: string, mode: DropMode) => {
    if (mode === "copy" && target.copyTo !== null) {
      await copyIntoWorkspace(target, file, name, target.copyTo);

      return;
    }

    const [staged, thumb] = await Promise.all([stageFile(target, file, name), thumbnail(file)]);

    if (staged === null) return;

    if (thumb !== null) thumbnails.set(staged.id, thumb);
    onStaged({
      id: staged.id,
      name: staged.name,
      mimeType: staged.mimeType,
      size: staged.size,
      hostPath: staged.hostPath,
      width: staged.width,
      height: staged.height,
    });
  };

  const upload = (files: ReadonlyArray<File>, mode: DropMode = "attach") => {
    files.forEach((file, index) => {
      const upload: Upload = {
        key: nextKey++,
        name: fileName(file.name, file.type, index),
        size: file.size,
        copy: mode === "copy",
      };

      setUploads((all) => [...all, upload]);
      void one(file, upload.name, mode).finally(() =>
        setUploads((all) => all.filter((u) => u.key !== upload.key))
      );
    });
  };

  return { upload, uploads, canCopy: target.copyTo !== null };
};
