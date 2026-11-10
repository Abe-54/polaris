/** Whether to keep the UI still: the app's Motion setting, else the system's Reduce Motion. */
export function reducedMotion(): boolean {
  const setting = document.documentElement.dataset.reduceMotion;

  if (setting !== undefined) return setting === "true";

  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A morph's length in ms (DESIGN.md, Motion); `--duration-morph` in CSS. */
export const MORPH_MS = 400;

/** The morph spring, a 280ms response with 20% bounce over `MORPH_MS`; `--ease-morph` in CSS. */
export const MORPH_EASE =
  "linear(0, 0.0791, 0.2478, 0.4364, 0.608, 0.7471, 0.8507, 0.9223, 0.9682, 0.9951, 1.0089, 1.0144, 1.015, 1.0132, 1.0105, 1.0076, 1.0052, 1.0033, 1.0019, 1.0009, 1)";
