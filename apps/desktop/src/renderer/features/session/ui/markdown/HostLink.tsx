/**
 * A link in assistant prose that names a path on the session's Host (`hostLinks.ts`): an image
 * opens in the image viewer, read over the Daemon; any other file, an HTML page included, opens
 * in the editor, which says so when the file is outside every Workspace on that Host.
 */
import { type ReactNode, useState } from "react";
import { FileLink, useEditorPlace } from "../../../editor-links/index.ts";
import { imageMime } from "../../model/items.ts";
import { ImageViewer } from "../ImageViewer.tsx";
import { onHost } from "./hostImages.ts";

const LINK =
  "text-text-strong decoration-text-faint hover:decoration-text-subtle inline underline underline-offset-2";

/** SVG never shows as an image here (as in the editor preview); it opens as text. */
const viewable = (path: string) => {
  const mime = imageMime(path);

  return mime !== null && mime !== "image/svg+xml";
};

export interface HostLinkProps {
  readonly path: string;
  readonly children: ReactNode;
}

export const HostLink = ({ path, children }: HostLinkProps) => {
  const place = useEditorPlace();
  const [viewing, setViewing] = useState(false);
  const full = onHost(place?.root ?? null, path) ?? path;

  if (!viewable(full))
    return (
      <FileLink path={full} className={LINK}>
        {children}
      </FileLink>
    );

  if (place === null) return <span>{children}</span>;

  return (
    <>
      <button
        type="button"
        onClick={() => setViewing(true)}
        title={full}
        data-testid="host-image-link"
        className={`${LINK} cursor-pointer text-left`}
      >
        {children}
      </button>
      {viewing ? <ImageViewer path={full} onClose={() => setViewing(false)} /> : null}
    </>
  );
};
