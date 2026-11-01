let since = performance.now();

/** Bound CPU slices while avoiding an event-loop hop for every small SQL page. */
export const compareYield = (force = false) => {
  if (!force && performance.now() - since < 4) return;

  return new Promise<void>((resolve) =>
    setImmediate(() => {
      since = performance.now();
      resolve();
    })
  );
};
