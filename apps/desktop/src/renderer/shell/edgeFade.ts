/**
 * The still edge fade on a scrolling strip with no scrollbar (the Workspace and machine bars, the
 * Editor's tabs): `data-fade` names the edges with content past them, and `EDGE_FADE` masks them.
 */
import { type RefObject, useLayoutEffect } from "react";
import { edgeFade } from "../routes/topBar.ts";

/** A 24px fade on each side with content past it; still, never animated (DESIGN.md, Chrome redesign). */
export const EDGE_FADE =
  "data-[fade=start]:[mask-image:linear-gradient(to_right,transparent,black_24px)] data-[fade=end]:[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)] data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]";

/** Marks which edges have content past them (`data-fade`), for the mask; set directly, no render. */
export const markFade = (strip: HTMLElement) => {
  strip.dataset["fade"] = edgeFade({
    offset: strip.scrollLeft,
    view: strip.clientWidth,
    content: strip.scrollWidth,
  });
};

/** Keeps a strip's edge fade current on scroll, resize and every render (its items come and go). */
export const useEdgeFade = (strip: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const element = strip.current;

    if (element === null) return;
    markFade(element);

    const observer = new ResizeObserver(() => markFade(element));
    const onScroll = () => markFade(element);

    observer.observe(element);
    element.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, [strip]);

  useLayoutEffect(() => {
    if (strip.current !== null) markFade(strip.current);
  });
};
