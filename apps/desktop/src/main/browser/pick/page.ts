/**
 * Pick mode inside the page (ENG-618): a closed-shadow overlay that highlights the element under
 * the pointer and answers the clicked one, or null on Escape or a cancel. It runs in an isolated
 * world, so the page's scripts never see its code; each function here is serialised with
 * `toString`, so it must not reference anything outside its own body.
 */
import type { PageElement, PageEvent, PageGlobals } from "./dom.ts";

/** What the page answers for a pick; main adds the screenshot. */
export interface PagePick {
  readonly url: string;
  readonly title: string;
  readonly selector: string;
  /** The element's outer HTML, at most `htmlLimit` characters. */
  readonly html: string;
  /** How long the outer HTML was before it was cut. */
  readonly htmlLength: number;
  /** The element's bounds in CSS px, cut to the viewport. */
  readonly rect: { readonly x: number; readonly y: number; width: number; height: number };
}

/** How long each page-derived field may be, in characters; main decodes against the same. */
export interface PickLimits {
  readonly url: number;
  readonly title: number;
  readonly selector: number;
  readonly html: number;
}

/** A CSS selector that matches `element` alone in its document, kept short and readable. */
export function selectorOf(element: PageElement, escape: (value: string) => string): string {
  const unique = (selector: string) => {
    try {
      return element.ownerDocument.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };

  // A CSS string: quotes and backslashes escaped, line breaks as code points (`\\a `).
  const quoted = (value: string) =>
    `"${value.replace(/["\\]/g, (c) => `\\${c}`).replace(/[\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;

  // Build-generated class names (css-1x2y3z, sc-AbCdE, _a1b2c3) change between builds.
  const stable = (name: string) =>
    name.length <= 32 && !/\d{3}|^(css|sc|jsx|svelte)-|^_/.test(name) && !name.includes(":");

  const byId = (node: PageElement) => {
    const id = node.getAttribute("id");

    return id !== null && id !== "" && unique(`#${escape(id)}`) ? `#${escape(id)}` : null;
  };

  const byAttribute = (node: PageElement) => {
    for (const name of ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label"]) {
      const value = node.getAttribute(name);
      const selector = value === null ? null : `${node.localName}[${name}=${quoted(value)}]`;

      if (selector !== null && value !== "" && unique(selector)) return selector;
    }

    return null;
  };

  const step = (node: PageElement) => {
    const classes = [...node.classList].filter(stable).slice(0, 2);
    const base = node.localName + classes.map((name) => `.${escape(name)}`).join("");
    const parent = node.parentElement;

    if (parent === null) return base;

    const siblings = [...parent.children];

    if (siblings.filter((child) => child.matches(base)).length < 2) return base;

    const sameTag = siblings.filter((child) => child.localName === node.localName);

    return `${base}:nth-of-type(${sameTag.indexOf(node) + 1})`;
  };

  const direct = byId(element) ?? byAttribute(element);

  if (direct !== null) return direct;

  const parts: Array<string> = [];

  for (let node: PageElement | null = element; node !== null; node = node.parentElement) {
    const anchor = node === element ? null : byId(node);

    if (anchor !== null) return [anchor, ...parts].join(" > ");
    parts.unshift(step(node));

    const selector = parts.join(" > ");

    if (unique(selector)) return selector;
  }

  return parts.join(" > ");
}

/**
 * Starts pick mode and settles with the pick, or null when cancelled. A second start cancels the
 * first; `cancelPick` cancels from outside.
 */
export function pickInPage(
  page: PageGlobals,
  select: (element: PageElement, escape: (value: string) => string) => string,
  limits: PickLimits
): Promise<PagePick | null> {
  const { document } = page;

  page.__polarisPick?.cancel();

  return new Promise((resolve) => {
    const host = document.createElement("polaris-pick");
    const root = host.attachShadow({ mode: "closed" });
    const box = document.createElement("div");
    const label = document.createElement("div");
    let current: PageElement | null = null;
    let done = false;

    // CSSOM, not <style>: a page's CSP may refuse inline styles but never these.
    Object.assign(host.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      cursor: "crosshair",
      background: "transparent",
      display: "block",
    });
    Object.assign(box.style, {
      position: "fixed",
      pointerEvents: "none",
      boxSizing: "border-box",
      border: "1.5px solid #4F82E8",
      background: "rgba(79, 130, 232, 0.16)",
      borderRadius: "2px",
      display: "none",
    });
    Object.assign(label.style, {
      position: "fixed",
      pointerEvents: "none",
      display: "none",
      maxWidth: "min(480px, 90vw)",
      overflow: "hidden",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
      padding: "2px 6px",
      borderRadius: "4px",
      background: "#26272B",
      color: "#E6E7EA",
      font: "11px/16px ui-monospace, SFMono-Regular, Menlo, monospace",
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.3)",
    });
    root.append(box, label);

    const under = (event: PageEvent) =>
      document.elementsFromPoint(event.clientX, event.clientY).find((e) => e !== host) ?? null;

    const paint = () => {
      if (current === null || !current.isConnected) {
        Object.assign(box.style, { display: "none" });
        Object.assign(label.style, { display: "none" });

        return;
      }

      const rect = current.getBoundingClientRect();
      const classes = [...current.classList].slice(0, 2).map((name) => `.${name}`);
      const below = Math.min(rect.bottom + 4, page.innerHeight - 22);

      Object.assign(box.style, {
        display: "block",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      label.textContent = `${current.localName}${classes.join("")}  ${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      Object.assign(label.style, {
        display: "block",
        left: `${Math.max(4, rect.left)}px`,
        top: `${rect.top >= 24 ? rect.top - 22 : below}px`,
      });
    };

    const swallow = (event: PageEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const picked = (element: PageElement): PagePick => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const html = element.outerHTML;

      return {
        url: page.location.href.slice(0, limits.url),
        title: document.title.slice(0, limits.title),
        selector: select(element, page.CSS.escape).slice(0, limits.selector),
        html: html.slice(0, limits.html),
        htmlLength: html.length,
        rect: {
          x: left,
          y: top,
          width: Math.max(0, Math.min(page.innerWidth, rect.right) - left),
          height: Math.max(0, Math.min(page.innerHeight, rect.bottom) - top),
        },
      };
    };

    const state = {
      cancel: () => finish(null),
    };

    const onKey = (event: PageEvent) => {
      if (event.key !== "Escape" || !event.isTrusted) return;
      swallow(event);
      finish(null);
    };

    function finish(pick: PagePick | null) {
      if (done) return;
      done = true;
      page.removeEventListener("keydown", onKey, true);
      page.removeEventListener("scroll", paint, true);
      host.remove();

      if (page.__polarisPick === state) delete page.__polarisPick;
      // Two frames: the overlay is off screen before main captures the element.
      page.requestAnimationFrame(() => page.requestAnimationFrame(() => resolve(pick)));
    }

    // Only the user's own input counts: a page could dispatch a click at an element it chose.
    host.addEventListener("mousemove", (event) => {
      if (!event.isTrusted) return;
      current = under(event);
      paint();
    });
    host.addEventListener("mousedown", swallow);
    host.addEventListener("mouseup", swallow);
    host.addEventListener("click", (event) => {
      swallow(event);

      if (!event.isTrusted) return;

      const element = under(event);

      finish(element === null ? null : picked(element));
    });
    host.addEventListener("contextmenu", (event) => {
      swallow(event);

      if (event.isTrusted) finish(null);
    });
    page.addEventListener("keydown", onKey, true);
    page.addEventListener("scroll", paint, true);
    page.__polarisPick = state;
    document.documentElement.append(host);
  });
}

/** Cancels the page's pick, if one is running. */
export function cancelPick(page: PageGlobals): void {
  page.__polarisPick?.cancel();
}

/** The script that starts a pick, for `executeJavaScriptInIsolatedWorld`: the world's window. */
export const pickScript = (limits: PickLimits) =>
  `(${pickInPage.toString()})(window, ${selectorOf.toString()}, ${JSON.stringify(limits)})`;

export const cancelScript = () => `(${cancelPick.toString()})(window)`;
