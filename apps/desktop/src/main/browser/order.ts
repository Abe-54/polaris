/**
 * Ordering for work main starts and finishes later: a tab's loads, where the latest asked for
 * wins, and a Host's claims and releases, which run one after another in the order asked.
 */

/**
 * Loads that wait for their partition; one asked for since supersedes one still waiting. A
 * partition that fails to set up starts nothing: the latest load hears of it through `failed`.
 */
export const latestLoads = <K, V = string>(
  start: (key: K, url: V) => void,
  failed: (key: K, url: V, cause: unknown) => void = () => {}
) => {
  const latest = new Map<K, number>();
  /** Never reset, so a load asked for before `forget` can't pass for one asked for after. */
  let turns = 0;

  return {
    request: (key: K, url: V, ready: Promise<void>) => {
      const turn = ++turns;

      latest.set(key, turn);
      ready.then(
        () => {
          if (latest.get(key) === turn) start(key, url);
        },
        (cause: unknown) => {
          if (latest.get(key) === turn) failed(key, url, cause);
        }
      );
    },
    forget: (key: K) => latest.delete(key),
  };
};

/** Runs each key's tasks one at a time, in the order they were queued; a failure doesn't stop the queue. */
export const queueByKey = <K>(onError: (cause: unknown) => void) => {
  const tails = new Map<K, Promise<void>>();

  return (key: K, task: () => Promise<void>) => {
    const next = (tails.get(key) ?? Promise.resolve()).then(task).then(
      () => {},
      (cause: unknown) => onError(cause)
    );

    tails.set(key, next);
    void next.then(() => {
      if (tails.get(key) === next) tails.delete(key);
    });

    return next;
  };
};
