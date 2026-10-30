/**
 * Keeps main's view over the Browser area: `browser.show` with the area's bounds whenever they
 * change, empty bounds while a dialog or menu would sit under the page (a view is always on top),
 * and `browser.hide` when the area goes.
 */
import type { SessionId } from "@polaris/protocol";
import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import type { BrowserBounds } from "../../../shared/browserContract.ts";
import { polaris } from "../bridge.ts";

const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * True while a dialog, menu or listbox floats in a portal (a child of `body` beside the app's
 * root). In-tree ones, such as the transcript's Turns rail, never sit over the page.
 */
export const overlayOpen = (body: HTMLElement): boolean =>
  [...body.children].some(
    (child) =>
      child.id !== "root" && (child.matches(OVERLAYS) || child.querySelector(OVERLAYS) !== null)
  );

/** True while a dialog, menu or listbox is open over the window. */
export const useOverlayOpen = () => {
  const [open, setOpen] = useState(() => overlayOpen(document.body));

  useEffect(() => {
    const check = () => setOpen(overlayOpen(document.body));
    const observer = new MutationObserver(check);

    // Radix portals mount and unmount as children of body.
    observer.observe(document.body, { childList: true });
    check();

    return () => observer.disconnect();
  }, []);

  return open;
};

const NONE: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 };

const boundsOf = (element: HTMLElement): BrowserBounds => {
  const box = element.getBoundingClientRect();

  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.max(0, Math.round(box.width)),
    height: Math.max(0, Math.round(box.height)),
  };
};

const same = (a: BrowserBounds | null, b: BrowserBounds) =>
  a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export const useBrowserPlacement = (
  area: RefObject<HTMLElement | null>,
  target: { readonly hostKey: string; readonly sessionId: SessionId },
  covered: boolean
) => {
  const { hostKey, sessionId } = target;

  useLayoutEffect(() => {
    const element = area.current;

    if (element === null) return;

    let last: BrowserBounds | null = null;
    let frame = 0;

    const send = () => {
      frame = 0;

      const bounds = covered ? NONE : boundsOf(element);

      if (same(last, bounds)) return;
      last = bounds;
      void polaris().request("browser.show", { hostKey, sessionId, bounds });
    };

    const soon = () => {
      if (frame === 0) frame = requestAnimationFrame(send);
    };

    const resize = new ResizeObserver(soon);

    resize.observe(element);
    window.addEventListener("resize", soon);
    // The Output panel slides in on `transform`, which no ResizeObserver sees.
    document.addEventListener("animationend", soon, true);
    document.addEventListener("transitionend", soon, true);
    send();

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("resize", soon);
      document.removeEventListener("animationend", soon, true);
      document.removeEventListener("transitionend", soon, true);
    };
  }, [area, hostKey, sessionId, covered]);

  useEffect(
    () => () => void polaris().request("browser.hide", { hostKey, sessionId }),
    [hostKey, sessionId]
  );
};
