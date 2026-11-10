// Portions adapted from pingdotgg/t3code@fa4e4677 (MIT)
/**
 * The React component behind a picked element (ENG-619). React keeps its fibers in expando
 * properties only the page's own world sees, so `reactInPage` runs there: the isolated pick
 * world marks the element, this finds it by the mark. Its answer is page data; main decodes it.
 */
import { Schema } from "effect";

/** Where a React element was written: the component and the JSX's file, line and column. */
export interface PageFrame {
  readonly functionName: string | null;
  readonly fileName: string | null;
  readonly lineNumber: number | null;
  readonly columnNumber: number | null;
}

/** What the page answers for the picked element's React tree; null for a page without React. */
export interface PageReact {
  readonly componentName: string | null;
  readonly source: PageFrame | null;
  readonly stack: ReadonlyArray<PageFrame>;
}

export interface ReactLimits {
  /** A component name, in characters. */
  readonly name: number;
  /** A file name, in characters. */
  readonly file: number;
  /** Enclosing components in `stack`. */
  readonly frames: number;
}

export const REACT_LIMITS: ReactLimits = { name: 200, file: 1000, frames: 12 };

/** The attribute the isolated world marks the picked element with, for the main world to find. */
export const PICK_MARK = "data-polaris-pick";

/** A component as React's fibers hold it: a class, a function, or a forwardRef or memo. */
export interface PageComponentType {
  readonly displayName?: string;
  readonly name?: string;
  readonly render?: PageComponentType;
  readonly type?: PageComponentType;
}

/** The fields of a React fiber the lookup reads; dev builds add the `_debug` ones. */
export interface PageFiber {
  readonly tag?: number;
  /** A host element's type is its tag name, which has none of a component's fields. */
  readonly type?: PageComponentType | null;
  readonly return?: PageFiber | null;
  readonly _debugOwner?: PageFiber | null;
  readonly _debugSource?: {
    readonly fileName?: string;
    readonly lineNumber?: number;
    readonly columnNumber?: number;
  } | null;
  readonly _debugStack?: { readonly stack?: string } | null;
}

/** An element React rendered: its fiber sits under a `__reactFiber$…` key. */
export type PageReactElement = Readonly<Record<string, PageFiber | undefined>>;

/**
 * The picked element's React component, its JSX's source and the components around it,
 * nearest first. Runs in the page's main world, serialised with `toString`, so it references
 * nothing outside its body. The types are what React leaves; anything else throws (null) or
 * fails main's decode.
 */
export function reactInPage(
  document: { querySelector: (selector: string) => PageReactElement | null },
  mark: string,
  limits: ReactLimits
): PageReact | null {
  const COMPONENT_TAGS = new Set([0, 1, 2, 11, 14, 15]);
  const LIBRARY_FRAME = /node_modules|^(jsx|jsxs|jsxDEV|createElement|react-stack-top-frame)$/;

  const text = (value: string | undefined, limit: number) => (value ?? "").slice(0, limit) || null;

  const whole = (value: number | undefined) =>
    Number.isInteger(value) && value !== undefined && value >= 0 ? value : null;

  // A class or function's own name, or the one inside a forwardRef or memo wrapper.
  const nameOf = (type: PageComponentType | undefined, depth = 0): string | null =>
    type === undefined || depth > 2
      ? null
      : (text(type.displayName, limits.name) ??
        text(type.name, limits.name) ??
        nameOf(type.render, depth + 1) ??
        nameOf(type.type, depth + 1));

  const componentOf = (fiber: PageFiber | null | undefined) =>
    fiber && COMPONENT_TAGS.has(fiber.tag ?? -1) ? nameOf(fiber.type ?? undefined) : null;

  // A URL without its cache-busting query (`?t=…`, `?v=…`) or hash.
  const fileOf = (value: string | undefined) =>
    text((value ?? "").replace(/[?#].*$/, ""), limits.file);

  // React 19 records where JSX ran as an Error's stack: the first frame outside the libraries.
  const parsed = (stack: string | undefined) => {
    for (const line of (stack ?? "").split("\n").slice(1)) {
      const match = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
      const [, name = "", file = ""] = match ?? [];

      if (match !== null && !LIBRARY_FRAME.test(name) && !LIBRARY_FRAME.test(file))
        return {
          fileName: fileOf(file),
          lineNumber: whole(Number(match[3])),
          columnNumber: whole(Number(match[4])),
        };
    }

    return null;
  };

  // React 18 and earlier keep `_debugSource`; 19 keeps `_debugStack`. Production keeps neither.
  const siteOf = (fiber: PageFiber, functionName: string | null): PageFrame => {
    const source = fiber._debugSource;

    const site =
      source === undefined || source === null
        ? parsed(fiber._debugStack?.stack)
        : {
            fileName: fileOf(source.fileName),
            lineNumber: whole(source.lineNumber),
            columnNumber: whole(source.columnNumber),
          };

    return { functionName, fileName: null, lineNumber: null, columnNumber: null, ...site };
  };

  try {
    const element = document.querySelector(`[data-polaris-pick="${mark}"]`);

    const key = Object.keys(element ?? {}).find(
      (name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$")
    );

    const fiber = key === undefined ? undefined : element?.[key];

    if (fiber === undefined) return null;

    const stack: Array<PageFrame> = [];
    let nearest: string | null = null;

    for (let node = fiber.return, steps = 0; node && steps < 500; node = node.return, steps++) {
      const name = componentOf(node);

      nearest ??= name;

      if (name !== null && stack.length < limits.frames) stack.push(siteOf(node, name));
    }

    // The owner wrote the element's JSX; the nearest enclosing component may only pass it on.
    const componentName = componentOf(fiber._debugOwner) ?? nearest;
    const source = siteOf(fiber, componentName);

    return { componentName, source: source.fileName === null ? null : source, stack };
  } catch {
    return null;
  }
}

/** The main-world script that answers the marked element's React tree. */
export const reactScript = (mark: string, limits: ReactLimits) =>
  `(${reactInPage.toString()})(document, ${JSON.stringify(mark)}, ${JSON.stringify(limits)})`;

const upTo = (limit: number) => Schema.String.check(Schema.isMaxLength(limit));

const Whole = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

const Frame = Schema.Struct({
  functionName: Schema.NullOr(upTo(REACT_LIMITS.name)),
  fileName: Schema.NullOr(upTo(REACT_LIMITS.file)),
  lineNumber: Whole,
  columnNumber: Whole,
});

const PageReactSchema = Schema.NullOr(
  Schema.Struct({
    componentName: Schema.NullOr(upTo(REACT_LIMITS.name)),
    source: Schema.NullOr(Frame),
    stack: Schema.Array(Frame).check(Schema.isMaxLength(REACT_LIMITS.frames)),
  })
);

/** What the page answered: none for an answer out of bounds; null for a page without React. */
export const decodePageReact = Schema.decodeUnknownOption(PageReactSchema);
