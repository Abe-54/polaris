import { useEffect, useState } from "react";
import { exitMs } from "./morph.ts";

/**
 * True while the terminal leaves: keep passing `terminal` meanwhile. Reduce Motion is read
 * as it hides, in the effect: read in render, the React Compiler caches it per mount.
 */
export const useTerminalLeaving = (shown: boolean) => {
  const [previous, setPrevious] = useState(shown);
  const [leaving, setLeaving] = useState(false);

  if (previous !== shown) {
    setPrevious(shown);
    setLeaving(!shown);
  }

  useEffect(() => {
    if (!leaving) return;

    const timer = setTimeout(() => setLeaving(false), exitMs());

    return () => clearTimeout(timer);
  }, [leaving]);

  return leaving;
};
