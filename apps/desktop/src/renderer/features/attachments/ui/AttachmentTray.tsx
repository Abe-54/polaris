/**
 * The composer's attachment row: a chip per staged file (a thumbnail for
 * images, the name in mono, the size), removable; an element picked in the
 * Browser is one chip for its screenshot and note. Then what is still on its
 * way to the Host.
 */
import { Chip, CloseIcon, PickElementIcon } from "@polaris/ui";
import type { StagedAttachment } from "../../session/state.ts";
import { chipsOf, formatSize, pickTitle, type Upload, uploadLine } from "../model.ts";
import { thumbnailOf } from "../useUploads.ts";

export interface AttachmentTrayProps {
  readonly attachments: ReadonlyArray<StagedAttachment>;
  readonly uploads: ReadonlyArray<Upload>;
  readonly onRemove: (attachment: StagedAttachment) => void;
}

const Thumb = ({ id }: { readonly id: string }) => {
  const src = thumbnailOf(id);

  return src === null ? null : (
    <img src={src} alt="" className="size-4 shrink-0 rounded-[3px] object-cover" />
  );
};

export const AttachmentTray = ({ attachments, uploads, onRemove }: AttachmentTrayProps) => {
  const line = uploadLine(uploads);

  if (attachments.length === 0 && line === null) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="attachments">
      {chipsOf(attachments).map((chip) =>
        chip.pick === null ? (
          <Chip
            key={chip.key}
            variant="source"
            onClick={() => onRemove(chip.first)}
            aria-label={`Remove ${chip.first.name}`}
            title={`${chip.first.name} · ${formatSize(chip.first.size)} · staged on the host`}
          >
            <Thumb id={chip.first.id} />
            <span className="text-micro font-regular max-w-48 truncate font-mono">
              {chip.first.name}
            </span>
            <span className="text-micro text-text-subtle tabular">
              {formatSize(chip.first.size)}
            </span>
            <CloseIcon size={10} className="text-text-subtle" />
          </Chip>
        ) : (
          <Chip
            key={chip.key}
            variant="source"
            onClick={() => chip.files.forEach(onRemove)}
            aria-label={`Remove the picked element ${chip.pick.selector}`}
            title={pickTitle(chip.pick)}
            data-testid="attachment-pick"
          >
            {chip.image === null ? (
              <PickElementIcon size={12} className="text-text-subtle shrink-0" />
            ) : (
              <Thumb id={chip.image.id} />
            )}
            <span className="text-micro font-regular max-w-48 truncate font-mono">
              {chip.pick.selector}
            </span>
            <span className="text-micro text-text-subtle max-w-32 truncate font-mono">
              {chip.pick.html}
            </span>
            <CloseIcon size={10} className="text-text-subtle" />
          </Chip>
        )
      )}
      {line === null ? null : (
        <span className="text-caption text-text-subtle" role="status" data-testid="uploading">
          {line}
        </span>
      )}
    </div>
  );
};
