/**
 * A lazy mode's chunk (ENG-905): imported once, by whichever asks first, the mode opening or the
 * background warm-up. Importing only evaluates the chunk; a mode's open effects run on its render.
 */
import { use } from "react";

export interface ModeChunk<M> {
  /** The chunk, imported on the first call; a failed import is tried again on the next. */
  readonly load: () => Promise<M>;
  /** The chunk once it has loaded, else null. */
  readonly loaded: () => M | null;
}

export const modeChunk = <M>(importer: () => Promise<M>): ModeChunk<M> => {
  let pending: Promise<M> | null = null;
  let loaded: M | null = null;

  return {
    load: () => {
      if (pending !== null) return pending;
      const next = importer();

      pending = next;
      next.then(
        (module) => {
          loaded = module;
        },
        () => {
          if (pending === next) pending = null;
        }
      );

      return next;
    },
    loaded: () => loaded,
  };
};

/**
 * The chunk for a render: at once when it has loaded, so a warmed mode draws in the switch's
 * first frame (React.lazy suspends once even then); otherwise it suspends until it arrives.
 */
export const useModeChunk = <M>(chunk: ModeChunk<M>): M => chunk.loaded() ?? use(chunk.load());
