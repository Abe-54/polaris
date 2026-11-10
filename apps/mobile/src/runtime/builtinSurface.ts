/**
 * The standard-library methods an engine has, as `Root.name` paths. The Hermes probe prints
 * Hermes' surface; `scripts/hermes.ts` diffs it against Bun's into `hermesMissing.json`, and the
 * test preload removes those methods from Bun so app tests fail where the app would (ENG-591).
 */

/** A standard constructor, prototype or namespace object. */
interface Builtin {
  readonly constructor: unknown;
}

const protoOf = (value: Builtin): Builtin => Reflect.getPrototypeOf(value) ?? Object.prototype;

const typedArray = protoOf(Uint8Array);

const iteratorPrototype = protoOf(protoOf([][Symbol.iterator]()));

// Without an `Iterator` global, %IteratorPrototype%'s constructor is Object.
const iterator = iteratorPrototype.constructor;

/** Constructors and namespaces whose own methods app code calls. Globals differ by host; skipped. */
export const ROOTS: ReadonlyArray<readonly [string, Builtin | undefined]> = [
  ["Object", Object],
  ["Object.prototype", Object.prototype],
  ["Array", Array],
  ["Array.prototype", Array.prototype],
  ["String", String],
  ["String.prototype", String.prototype],
  ["Number", Number],
  ["Number.prototype", Number.prototype],
  ["Math", Math],
  ["JSON", JSON],
  ["Reflect", Reflect],
  ["Promise", Promise],
  ["Promise.prototype", Promise.prototype],
  ["Map", Map],
  ["Map.prototype", Map.prototype],
  ["Set", Set],
  ["Set.prototype", Set.prototype],
  ["WeakMap.prototype", WeakMap.prototype],
  ["Date", Date],
  ["Date.prototype", Date.prototype],
  ["RegExp.prototype", RegExp.prototype],
  ["ArrayBuffer", ArrayBuffer],
  ["ArrayBuffer.prototype", ArrayBuffer.prototype],
  ["TypedArray", typedArray],
  ["TypedArray.prototype", protoOf(Uint8Array.prototype)],
  ["Uint8Array", Uint8Array],
  ["Iterator", iterator instanceof Function && iterator !== Object ? iterator : undefined],
  ["Iterator.prototype", iteratorPrototype],
];

const methodsOf = (root: Builtin): Array<string> =>
  Object.getOwnPropertyNames(root).filter((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(root, name);

    return descriptor !== undefined && descriptor.value instanceof Function;
  });

/** Every method on `ROOTS` in the running engine, sorted. */
export const builtinSurface = (): Array<string> =>
  ROOTS.flatMap(([path, root]) =>
    root === undefined ? [] : methodsOf(root).map((name) => `${path}.${name}`)
  ).sort();

/** Removes each `Root.name` method from the running engine; names it doesn't have are skipped. */
export const removeBuiltins = (paths: ReadonlyArray<string>): void => {
  const roots = new Map(ROOTS);

  for (const path of paths) {
    const dot = path.lastIndexOf(".");
    const root = roots.get(path.slice(0, dot));

    if (root !== undefined) Reflect.deleteProperty(root, path.slice(dot + 1));
  }
};
