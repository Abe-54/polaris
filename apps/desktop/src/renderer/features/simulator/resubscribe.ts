/**
 * A Daemon feed kept open: Host feeds end when the connection drops, so it opens again after
 * 1, 2, 5, then every 15 s until the caller stops it. An item resets the wait.
 */
const WAIT_MS = [1000, 2000, 5000, 15_000];

export interface Opened {
  /** Called on every item batch; resets the wait. */
  readonly alive: () => void;
  /** Called when the feed ends, for any reason. */
  readonly ended: () => void;
}

export const keepSubscribed = (open: (opened: Opened) => () => void): (() => void) => {
  let stop: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let attempt = 0;

  const start = () => {
    stop = open({
      alive: () => {
        attempt = 0;
      },
      ended: () => {
        if (disposed) return;
        timer = setTimeout(start, WAIT_MS[Math.min(attempt, WAIT_MS.length - 1)]);
        attempt += 1;
      },
    });
  };

  start();

  return () => {
    disposed = true;
    clearTimeout(timer);
    stop?.();
  };
};
