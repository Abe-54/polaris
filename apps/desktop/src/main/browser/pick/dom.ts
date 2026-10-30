/**
 * The little of the DOM `page.ts` uses. Main's program has no DOM lib (it runs in Node), and a
 * `lib="dom"` reference would hand every main file `window` and `document`.
 */

export interface PageRectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface PageElement {
  readonly localName: string;
  readonly classList: Iterable<string>;
  readonly parentElement: PageElement | null;
  readonly children: ArrayLike<PageElement> & Iterable<PageElement>;
  readonly ownerDocument: { querySelectorAll: (selector: string) => { readonly length: number } };
  readonly isConnected: boolean;
  readonly outerHTML: string;
  getAttribute: (name: string) => string | null;
  matches: (selector: string) => boolean;
  getBoundingClientRect: () => PageRectLike;
}

/** An element pick mode builds: the overlay's host and its parts. */
export interface PageNode extends PageElement {
  /** Written with `Object.assign` only. */
  readonly style: object;
  textContent: string | null;
  append: (...nodes: ReadonlyArray<PageNode>) => void;
  remove: () => void;
  addEventListener: (type: string, listener: (event: PageEvent) => void) => void;
  attachShadow: (init: { mode: "closed" }) => {
    append: (...nodes: ReadonlyArray<PageNode>) => void;
  };
}

export interface PageEvent {
  readonly key?: string;
  /** False for an event a page script dispatched; only the user's own input picks. */
  readonly isTrusted: boolean;
  readonly clientX: number;
  readonly clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/** The page's globals, as the isolated world sees them. */
export interface PageGlobals {
  readonly document: {
    readonly title: string;
    readonly documentElement: PageNode;
    createElement: (name: string) => PageNode;
    elementsFromPoint: (x: number, y: number) => ReadonlyArray<PageElement>;
  };
  readonly location: { readonly href: string };
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly CSS: { escape: (value: string) => string };
  addEventListener: (type: string, listener: (event: PageEvent) => void, capture: boolean) => void;
  removeEventListener: (
    type: string,
    listener: (event: PageEvent) => void,
    capture: boolean
  ) => void;
  requestAnimationFrame: (run: () => void) => void;
  __polarisPick?: { readonly cancel: () => void };
}
