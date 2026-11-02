/**
 * An image in assistant prose that names a path, read from the session's Host over its Daemon
 * (`files.read`, capped and measured by `readHostImage`) and shown from an object URL. While it
 * loads or when it can't show, a quiet line in its place: the alt text and the reason. A click opens
 * it whole in the image viewer. Tool rows use it too, for an image the agent viewed.
 */
import { Match } from "effect";
import { useEffect, useState } from "react";
import { useEditorPlace } from "../../../editor-links/index.ts";
import { HostImagePool, type HostImageView, readHostImage } from "../../../host-images/index.ts";
import { ImageViewer } from "../ImageViewer.tsx";
import { onHost } from "./hostImages.ts";

/** One pool for every transcript, so the same image in many messages is read and held once. */
const transcriptImages = new HostImagePool({ read: readHostImage });

type Reason = Extract<HostImageView, { kind: "failed" }>["reason"];

const reasonCopy = (reason: Reason): string =>
  Match.value(reason).pipe(
    Match.when("missing", () => "Not found on the host"),
    Match.when("too-large", () => "Too large to show"),
    Match.when("not-image", () => "Not an image"),
    Match.when("offline", () => "Host offline"),
    Match.when("busy", () => "Too many images open"),
    Match.when("unreadable", () => "Couldn't be read"),
    Match.exhaustive
  );

const Status = ({ label, text }: { readonly label: string; readonly text: string }) => (
  <span
    className="text-text-subtle"
    role="img"
    aria-label={`${label} · ${text}`}
    data-host-image="status"
  >
    {label} · {text}
  </span>
);

const useHostImage = (hostKey: string | null, path: string | null): HostImageView | null => {
  const key = hostKey === null || path === null ? null : `${hostKey}\n${path}`;

  const [shown, setShown] = useState<{ readonly key: string; readonly view: HostImageView } | null>(
    null
  );

  useEffect(() => {
    if (hostKey === null || path === null || key === null) return;
    const lease = transcriptImages.acquire(hostKey, path);
    let live = true;

    if (lease.current !== null) setShown({ key, view: lease.current });
    else void lease.settled.then((view) => live && setShown({ key, view }));

    return () => {
      live = false;
      lease.release();
    };
  }, [hostKey, path, key]);

  return shown?.key === key ? shown.view : null;
};

export interface HostImageProps {
  readonly path: string;
  readonly alt: string;
  /** The `<img>`'s classes; up to the message's width by default. */
  readonly className?: string;
}

/** The image in place; a click opens it whole in the image viewer. */
export const HostImage = ({ path, alt, className }: HostImageProps) => {
  const place = useEditorPlace();
  const full = place === null ? null : onHost(place.root, path);
  const view = useHostImage(place?.hostKey ?? null, full);
  const [broken, setBroken] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const label = alt.trim() || (path.split("/").at(-1) ?? path);

  if (full === null) return <Status label={label} text="Image unavailable" />;

  if (view === null) return <Status label={label} text="Loading image…" />;

  if (view.kind === "failed") return <Status label={label} text={reasonCopy(view.reason)} />;

  if (broken === view.url) return <Status label={label} text={reasonCopy("not-image")} />;

  return (
    <>
      <button
        type="button"
        onClick={() => setViewing(true)}
        title={full}
        aria-label={`View ${label}`}
        className="rounded-row focus-visible:ring-starlight inline-block max-w-full cursor-zoom-in align-top focus-visible:ring-2 focus-visible:outline-none"
      >
        <img
          src={view.url}
          alt={alt}
          className={className ?? "rounded-row h-auto max-w-full"}
          data-host-image="ready"
          onError={() => setBroken(view.url)}
        />
      </button>
      {viewing ? <ImageViewer path={full} onClose={() => setViewing(false)} /> : null}
    </>
  );
};
