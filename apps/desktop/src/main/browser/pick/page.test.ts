import { afterEach, describe, expect, test } from "bun:test";
import { Option } from "effect";
import type { PageElement, PageEvent, PageGlobals, PageNode } from "./dom.ts";
import { decodePagePick, PICK_LIMITS } from "./index.ts";
import { cancelScript, pickScript, selectorOf } from "./page.ts";

interface EventInit {
  readonly bubbles?: boolean;
  readonly cancelable?: boolean;
  readonly key?: string;
}

type TestElement = PageElement & PageNode & { dispatchEvent: (event: PageEvent) => boolean };

/** The test preload's happy-dom window, with what the fixtures need beyond `PageGlobals`. */
interface TestWindow extends PageGlobals {
  readonly document: PageGlobals["document"] & {
    readonly body: { innerHTML: string };
    title: string;
    querySelector: (selector: string) => TestElement | null;
    querySelectorAll: (selector: string) => { readonly length: number };
    elementsFromPoint: (x: number, y: number) => ReadonlyArray<PageElement>;
  };
  CSS: PageGlobals["CSS"];
  readonly MouseEvent: new (type: string, init: EventInit) => PageEvent;
  readonly KeyboardEvent: new (type: string, init: EventInit) => PageEvent;
  dispatchEvent: (event: PageEvent) => boolean;
}

const isTestWindow = (scope: typeof globalThis): scope is typeof globalThis & TestWindow =>
  "document" in scope && "MouseEvent" in scope && "KeyboardEvent" in scope;

const page = (() => {
  const scope = globalThis;

  if (!isTestWindow(scope)) throw new Error("the test preload registers happy-dom");

  return scope;
})();

const { document } = page;

/** happy-dom has no CSS.escape; the fixtures' names only need the identifier escapes. */
const escape = (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`);

const element = (selector: string) => {
  const found = document.querySelector(selector);

  if (found === null) throw new Error(`no ${selector} in the fixture`);

  return found;
};

afterEach(() => {
  document.body.innerHTML = "";
});

/** The selector, checked to find exactly the element it was made for. */
const selectorFor = (selector: string) => {
  const target = element(selector);
  const made = selectorOf(target, escape);

  expect(document.querySelectorAll(made).length).toBe(1);
  expect(document.querySelector(made)).toBe(target);

  return made;
};

describe("selectors", () => {
  test("a unique id or test attribute is the whole selector", () => {
    document.body.innerHTML = `
      <main><button id="save">Save</button><button data-testid="cancel">Cancel</button></main>`;

    expect(selectorFor("#save")).toBe("#save");
    expect(selectorFor("[data-testid=cancel]")).toBe('button[data-testid="cancel"]');
  });

  test("a repeated element is numbered under its nearest ancestor with an id", () => {
    document.body.innerHTML = `
      <ul id="todos"><li class="item">a</li><li class="item">b</li><li class="item">c</li></ul>
      <ul><li class="item">d</li><li class="item">e</li></ul>`;

    expect(selectorFor("#todos li:nth-child(2)")).toBe("#todos > li.item:nth-of-type(2)");
  });

  test("build-generated class names are left out, so the selector survives a rebuild", () => {
    document.body.innerHTML = `
      <section><p class="css-1x2y3z lead">one</p></section><section><p>two</p></section>`;

    expect(selectorFor("p.lead")).toBe("p.lead");
  });

  test("a duplicate id isn't trusted", () => {
    document.body.innerHTML = `<div><span id="dup">a</span></div><p><span id="dup">b</span></p>`;

    expect(selectorFor("p > span")).toBe("p > span");
  });
});

/** Runs a script exactly as main sends it: a string, with nothing from this module in scope. */
const evaluate = (script: string) => {
  // oxlint-disable-next-line no-eval -- the test runs the serialised script as the page would.
  (0, eval)(script);
};

/** Starts a pick as main does, settling with the answer as main decodes it. */
const start = async (html = PICK_LIMITS.html) => {
  // oxlint-disable-next-line no-eval -- the test runs the serialised script as the page would.
  const answer: unknown = await (0, eval)(pickScript({ ...PICK_LIMITS, html }));

  return Option.getOrNull(decodePagePick(answer));
};

describe("pick mode in the page", () => {
  page.CSS ??= { escape };

  const overlay = () => {
    const host = document.querySelector("polaris-pick");

    if (host === null) throw new Error("no overlay");

    return host;
  };

  /** The pointer is over `target`: the overlay first, as in a real page. */
  const pointAt = (target: PageElement) => {
    document.elementsFromPoint = () => [overlay(), target];
  };

  /** The user's own input: a real browser marks it trusted, which no page script can forge. */
  const byUser = (event: PageEvent) => Object.defineProperty(event, "isTrusted", { value: true });

  const mouseClick = () => new page.MouseEvent("click", { bubbles: true, cancelable: true });

  const click = (target: TestElement) => target.dispatchEvent(byUser(mouseClick()));

  test("a click answers the element, cut to the limit, and takes the overlay away", async () => {
    document.title = "Todos";
    document.body.innerHTML = `<button id="add" class="primary">Add a todo</button>`;

    const pick = start(20);

    pointAt(element("#add"));
    click(overlay());

    expect(await pick).toMatchObject({
      title: "Todos",
      selector: "#add",
      html: '<button id="add" cla',
      htmlLength: '<button id="add" class="primary">Add a todo</button>'.length,
    });
    expect(document.querySelector("polaris-pick")).toBeNull();
  });

  test("a click the page dispatches itself never picks", async () => {
    document.body.innerHTML = `<button id="add">Add</button><input id="secret" value="x">`;

    const pick = start();

    // The page finds the overlay and fakes a click while the pointer is over its own choice.
    pointAt(element("#secret"));
    overlay().dispatchEvent(mouseClick());
    page.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(document.querySelector("polaris-pick")).not.toBeNull();

    pointAt(element("#add"));
    click(overlay());
    expect((await pick)?.selector).toBe("#add");
  });

  test("a page's title and selector are cut to their limits", async () => {
    document.title = "t".repeat(PICK_LIMITS.title + 50);
    document.body.innerHTML = `<button aria-label="${"a".repeat(PICK_LIMITS.selector)}">x</button>`;

    const pick = start();

    pointAt(element("button"));
    click(overlay());

    const answer = await pick;

    expect(answer?.title.length).toBe(PICK_LIMITS.title);
    expect(answer?.selector.length).toBe(PICK_LIMITS.selector);
  });

  test("main drops an answer over the limits, as a page could forge one", () => {
    const forged = {
      url: "http://localhost/",
      title: "t".repeat(PICK_LIMITS.title + 1),
      selector: "#a",
      html: "<a></a>",
      htmlLength: 7,
      rect: { x: 0, y: 0, width: 1, height: 1 },
    };

    expect(Option.isNone(decodePagePick(forged))).toBe(true);
    expect(Option.isSome(decodePagePick({ ...forged, title: "ok" }))).toBe(true);
  });

  test("the page never sees the click", async () => {
    document.body.innerHTML = `<button id="add">Add</button>`;

    let pageSaw = 0;

    element("#add").addEventListener("click", () => pageSaw++);

    const pick = start();

    pointAt(element("#add"));
    click(overlay());
    await pick;
    expect(pageSaw).toBe(0);
  });

  test("Escape, a cancel from main, or a second pick each end it with null", async () => {
    const escaped = start();

    page.dispatchEvent(
      byUser(new page.KeyboardEvent("keydown", { key: "Escape", cancelable: true }))
    );
    expect(await escaped).toBeNull();

    const cancelled = start();

    evaluate(cancelScript());
    expect(await cancelled).toBeNull();

    const first = start();
    const second = start();

    expect(await first).toBeNull();
    evaluate(cancelScript());
    expect(await second).toBeNull();
    expect(document.querySelector("polaris-pick")).toBeNull();
  });
});
