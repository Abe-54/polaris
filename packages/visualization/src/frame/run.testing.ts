/**
 * Runs a frame document's scripts as classic scripts, in order, in one `node:vm` context over a
 * happy-dom window: like a browser, they share one global lexical scope (happy-dom alone doesn't).
 * happy-dom shares Element.prototype and the like across Windows, so each frame starts by putting
 * them back as loaded: a change a test made in one frame can't reach the next one.
 */
import vm from "node:vm";
import { Window } from "happy-dom";

/** What a test reads back out of the frame: its JSON. */
export type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

export interface RunFrame {
  readonly window: Window;
  /** What each script threw, in order; a throw doesn't stop the scripts after it. */
  readonly errors: ReadonlyArray<string>;
  /** Messages the frame posted, parsed from the native bridge's JSON. */
  readonly posted: Array<unknown>;
  /** A global the scripts left, as JSON (functions dropped); undefined when there is none. */
  readonly global: (name: string) => Json | undefined;
  /** An expression's value in the frame, as JSON; undefined when it is undefined. */
  readonly evaluate: (expression: string) => Json | undefined;
  /** Runs statements in the frame (wrapped in a block, so their declarations stay local). */
  readonly run: (statements: string) => void;
}

const prototypesOf = (window: Window): ReadonlyArray<object> =>
  Object.getOwnPropertyNames(window).flatMap((name) => {
    const value: unknown = Object.getOwnPropertyDescriptor(window, name)?.value;
    const prototype: unknown = value instanceof Function ? value.prototype : null;

    return prototype instanceof Object ? [prototype] : [];
  });

const firstWindow = new Window();

const secondPrototypes = new Set(prototypesOf(new Window()));

/** The prototypes every happy-dom Window shares (Node, Element, …), with their own properties as loaded. */
const shared = prototypesOf(firstWindow)
  .filter((prototype) => secondPrototypes.has(prototype))
  .map((prototype) => ({
    prototype,
    properties: new Map(
      Reflect.ownKeys(prototype).flatMap((key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);

        return descriptor ? [[key, descriptor] as const] : [];
      })
    ),
  }));

const sameDescriptor = (a: PropertyDescriptor, b: PropertyDescriptor): boolean =>
  a.value === b.value &&
  a.get === b.get &&
  a.set === b.set &&
  a.writable === b.writable &&
  a.enumerable === b.enumerable &&
  a.configurable === b.configurable;

/**
 * Puts the shared prototypes back as loaded, so a frame starts as its own realm would. One a guard
 * locked (non-configurable) can't be restored and stays as the first frame left it.
 */
const restoreSharedPrototypes = (): void => {
  for (const { prototype, properties } of shared) {
    for (const key of Reflect.ownKeys(prototype)) {
      const current = Reflect.getOwnPropertyDescriptor(prototype, key);
      const loaded = properties.get(key);

      if (!current?.configurable || (loaded && sameDescriptor(current, loaded))) continue;

      if (loaded) Reflect.defineProperty(prototype, key, loaded);
      else Reflect.deleteProperty(prototype, key);
    }
  }
};

export const runFrame = (document: string): RunFrame => {
  restoreSharedPrototypes();
  const window = new Window();
  const posted: Array<unknown> = [];
  const context = vm.createContext(window);
  const bridge = { postMessage: (text: string) => posted.push(JSON.parse(text)) };
  Object.assign(window, { ReactNativeWebView: bridge });
  window.document.write(document);
  const errors: Array<string> = [];

  for (const script of window.document.querySelectorAll("script")) {
    try {
      vm.runInContext(script.textContent ?? "", context);
    } catch (error) {
      errors.push(String(error));
    }
  }

  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

  const evaluate = (expression: string): Json | undefined => {
    const text = String(vm.runInContext(`JSON.stringify({ v: (${expression}) })`, context));

    // SAFETY: JSON.parse of JSON.stringify output is JSON; `v` is absent when the value was undefined.
    return (JSON.parse(text) as { readonly v?: Json }).v;
  };

  return {
    window,
    errors,
    posted,
    global: (name) => evaluate(`typeof ${name} === "undefined" ? undefined : ${name}`),
    evaluate,
    run: (statements) => {
      vm.runInContext(`{ ${statements} }`, context);
    },
  };
};
