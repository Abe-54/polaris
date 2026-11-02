import { useEffect, useState } from "react";
import type { PreviewMediaPool } from "./media.ts";

export const PreviewImage = ({
  source,
  alt,
  pool,
  shown,
}: {
  readonly source: string;
  readonly alt: string;
  readonly pool: PreviewMediaPool | null;
  /** For an external image: counts it as shown until it unmounts. */
  readonly shown?: (() => () => void) | undefined;
}) => {
  const [image, setImage] = useState<{
    source: string;
    pool: PreviewMediaPool;
    url: string;
  } | null>(null);

  const [failed, setFailed] = useState(false);
  useEffect(() => {
    return shown?.();
  }, [shown]);
  useEffect(() => {
    setFailed(false);

    if (pool === null) return;
    let stopped = false;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void pool
      .acquire(source, controller.signal)
      .then((lease) => {
        if (stopped) {
          lease.release();

          return;
        }

        release = lease.release;
        setImage({ source, pool, url: lease.url });
      })
      .catch(() => {
        if (!stopped) setFailed(true);
      });

    return () => {
      stopped = true;
      controller.abort();
      release?.();
    };
  }, [pool, source]);

  if (failed || image?.source !== source || image.pool !== pool)
    return (
      <span className="preview-image-status" role="img" aria-label={alt || "Image"}>
        {alt && <span>{alt} · </span>}
        {failed || pool === null ? "Image unavailable" : "Loading image…"}
      </span>
    );

  return <img src={image.url} alt={alt} onError={() => setFailed(true)} />;
};
