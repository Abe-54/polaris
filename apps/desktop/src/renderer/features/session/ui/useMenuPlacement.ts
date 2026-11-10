/**
 * Places the composer's menu slot each time a menu opens in it: the room above
 * and below the composer inside whatever clips it (`../model/menuPlacement.ts`).
 */
import { type RefObject, useEffect, useState } from "react";
import { type MenuPlacement, placeMenu } from "../model/menuPlacement.ts";

const ABOVE: MenuPlacement = { side: "above", room: 320 };

/** The nearest ancestor that clips or scrolls, else the window. */
const clipEdges = (el: HTMLElement) => {
  for (let at = el.parentElement; at !== null; at = at.parentElement) {
    if (getComputedStyle(at).overflowY !== "visible") {
      const rect = at.getBoundingClientRect();

      return { top: rect.top, bottom: rect.bottom };
    }
  }

  return { top: 0, bottom: window.innerHeight };
};

export const useMenuPlacement = (
  box: RefObject<HTMLElement | null>,
  slot: HTMLElement | null
): MenuPlacement => {
  const [placement, setPlacement] = useState(ABOVE);

  useEffect(() => {
    if (slot === null) return undefined;

    const place = () => {
      const el = box.current;

      if (el === null || slot.childElementCount === 0) return;
      const rect = el.getBoundingClientRect();
      const edges = clipEdges(el);
      const next = placeMenu(rect.top - edges.top, edges.bottom - rect.bottom);

      setPlacement((was) => (was.side === next.side && was.room === next.room ? was : next));
    };

    const opened = new MutationObserver(place);

    opened.observe(slot, { childList: true });
    window.addEventListener("resize", place);

    return () => {
      opened.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [box, slot]);

  return placement;
};
