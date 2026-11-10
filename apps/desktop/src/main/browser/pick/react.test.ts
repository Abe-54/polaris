import { afterEach, describe, expect, test } from "bun:test";
import { Option } from "effect";
import { decodePageReact, PICK_MARK, REACT_LIMITS, reactScript } from "./react.ts";

/** The test preload's happy-dom document. */
interface TestDocument {
  readonly body: { innerHTML: string };
  querySelector: (selector: string) => object | null;
}

const isTestScope = (
  scope: typeof globalThis
): scope is typeof globalThis & { readonly document: TestDocument } => "document" in scope;

const { document } = (() => {
  const scope = globalThis;

  if (!isTestScope(scope)) throw new Error("the test preload registers happy-dom");

  return scope;
})();

afterEach(() => {
  document.body.innerHTML = "";
});

const MARK = "0b9e-mark";

/** A fiber as React's dev builds leave it; only the fields the lookup reads. */
interface Fiber {
  readonly tag: number;
  readonly type: unknown;
  return: Fiber | null;
  readonly _debugOwner?: Fiber | null;
  readonly _debugSource?: { fileName: string; lineNumber: number; columnNumber?: number };
  readonly _debugStack?: { stack: string };
}

/** React 19's record of where JSX ran: React's own frame first, then the component's. */
const jsxAt = (component: string, file: string, line: number, column: number) => ({
  stack: [
    "Error: react-stack-top-frame",
    "    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b:250:30)",
    `    at ${component} (${file}:${line}:${column})`,
    "    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/chunk-X.js?v=1a2b:11548:26)",
  ].join("\n"),
});

/** A page whose marked element React rendered from `fiber`, under the key React 17+ uses. */
const rendered = (fiber: Fiber, key = "__reactFiber$x7k2p") => {
  document.body.innerHTML = `<li ${PICK_MARK}="${MARK}">Buy milk</li>`;

  const element = document.querySelector("li");

  if (element === null) throw new Error("no fixture element");
  Object.defineProperty(element, key, { value: fiber, enumerable: true });

  return element;
};

/** Runs the script exactly as main sends it, decoded as main decodes it. */
const lookUp = (mark = MARK) =>
  // oxlint-disable-next-line no-eval -- the test runs the serialised script as the page would.
  Option.getOrNull(decodePageReact((0, eval)(reactScript(mark, REACT_LIMITS))));

function TodoItem() {}

function TodoList() {}

function Card() {}

function App() {}

describe("the React behind a pick", () => {
  test("React 19: the component, where its JSX is, and the components around it", () => {
    const list: Fiber = {
      tag: 11,
      type: { $$typeof: "forward_ref", render: TodoList },
      return: null,
      _debugStack: jsxAt("App", "http://localhost:5173/src/App.tsx?t=1712", 8, 3),
    };

    const item: Fiber = {
      tag: 0,
      type: TodoItem,
      return: { tag: 5, type: "ul", return: list },
      _debugStack: jsxAt("TodoList", "http://localhost:5173/src/TodoList.tsx?t=1712", 30, 9),
    };

    rendered({
      tag: 5,
      type: "li",
      return: item,
      _debugOwner: item,
      _debugStack: jsxAt("TodoItem", "http://localhost:5173/src/TodoItem.tsx?t=1712", 12, 7),
    });

    expect(lookUp()).toEqual({
      componentName: "TodoItem",
      source: {
        functionName: "TodoItem",
        fileName: "http://localhost:5173/src/TodoItem.tsx",
        lineNumber: 12,
        columnNumber: 7,
      },
      stack: [
        {
          functionName: "TodoItem",
          fileName: "http://localhost:5173/src/TodoList.tsx",
          lineNumber: 30,
          columnNumber: 9,
        },
        {
          functionName: "TodoList",
          fileName: "http://localhost:5173/src/App.tsx",
          lineNumber: 8,
          columnNumber: 3,
        },
      ],
    });
  });

  test("React 18: the source from _debugSource, named by displayName through memo", () => {
    const app: Fiber = { tag: 0, type: App, return: null };

    const card: Fiber = {
      tag: 14,
      type: { $$typeof: "memo", type: Object.assign(() => {}, { displayName: "Card" }) },
      return: app,
      _debugSource: { fileName: "/repo/src/App.tsx", lineNumber: 21, columnNumber: 5 },
    };

    // The button is written in App and passed into Card: App owns it, Card only wraps it.
    rendered(
      {
        tag: 5,
        type: "button",
        return: card,
        _debugOwner: app,
        _debugSource: { fileName: "/repo/src/App.tsx", lineNumber: 22, columnNumber: 7 },
      },
      "__reactInternalInstance$abc"
    );

    const react = lookUp();

    expect(react?.componentName).toBe("App");
    expect(react?.source).toEqual({
      functionName: "App",
      fileName: "/repo/src/App.tsx",
      lineNumber: 22,
      columnNumber: 7,
    });
    expect(react?.stack.map((frame) => [frame.functionName, frame.lineNumber])).toEqual([
      ["Card", 21],
      ["App", null],
    ]);
  });

  test("a production build has names but no source", () => {
    rendered({ tag: 5, type: "li", return: { tag: 0, type: Card, return: null } });

    expect(lookUp()).toEqual({
      componentName: "Card",
      source: null,
      stack: [{ functionName: "Card", fileName: null, lineNumber: null, columnNumber: null }],
    });
  });

  test("the enclosing components stop at the limit", () => {
    let top: Fiber | null = null;

    for (let i = 0; i < REACT_LIMITS.frames + 5; i++) top = { tag: 0, type: App, return: top };
    rendered({ tag: 5, type: "li", return: top });

    expect(lookUp()?.stack.length).toBe(REACT_LIMITS.frames);
  });

  test("a page without React, or another pick's mark, has none", () => {
    document.body.innerHTML = `<li ${PICK_MARK}="${MARK}">a</li>`;
    expect(lookUp()).toBeNull();

    rendered({ tag: 5, type: "li", return: null });
    expect(lookUp("other-mark")).toBeNull();
  });

  test("a fiber whose getters throw answers none instead of failing the pick", () => {
    const fiber = {
      tag: 5,
      get return(): never {
        throw new Error("hostile page");
      },
    };

    document.body.innerHTML = `<li ${PICK_MARK}="${MARK}">a</li>`;
    Object.defineProperty(document.querySelector("li"), "__reactFiber$q", {
      value: fiber,
      enumerable: true,
    });

    expect(lookUp()).toBeNull();
  });

  test("main drops an answer a page forged past the limits", () => {
    const frame = { functionName: "A", fileName: "/a.tsx", lineNumber: 1, columnNumber: 2 };
    const ok = { componentName: "A", source: frame, stack: [frame] };

    const decoded = (answer: typeof ok) => Option.getOrNull(decodePageReact(answer));

    expect(decoded(ok)).toEqual(ok);
    expect(decoded({ ...ok, componentName: "x".repeat(REACT_LIMITS.name + 1) })).toBeNull();
    expect(decoded({ ...ok, source: { ...frame, lineNumber: 1.5 } })).toBeNull();
    expect(
      decoded({
        ...ok,
        stack: Array.from({ length: REACT_LIMITS.frames + 1 }, () => frame),
      })
    ).toBeNull();
  });
});
