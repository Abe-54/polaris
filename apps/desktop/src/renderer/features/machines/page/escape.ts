/**
 * Esc on a host page goes back to the host list before Settings' own esc closes Settings.
 * Both listen on the window in capture, which runs in the order listeners were added, so this
 * one is added when the module loads (the app's start), ahead of Settings' (on open).
 */
import { useEffect, useRef } from "react";

let current: (() => void) | null = null;

/** An open popover, menu or select takes esc first. */
const layerOpen = () => document.querySelector("[data-radix-popper-content-wrapper]") !== null;

const onKey = (event: KeyboardEvent) => {
  if (current === null || event.key !== "Escape" || event.defaultPrevented || layerOpen()) return;
  event.preventDefault();
  current();
};

if (typeof window !== "undefined") window.addEventListener("keydown", onKey, true);

/** While mounted, esc runs `handle` instead of closing Settings. */
export const useEscape = (handle: () => void) => {
  const latest = useRef(handle);

  latest.current = handle;
  useEffect(() => {
    const run = () => latest.current();

    current = run;

    return () => {
      if (current === run) current = null;
    };
  }, []);
};
