/**
 * Log arguments as text within a budget (ENG-754): each argument is rendered whole or not at all,
 * so the scrubber never sees a value cut in the middle. Rendering gives up as soon as it is over.
 */
import { Predicate } from "effect";
import { sensitive } from "../redact.ts";

type Argument = ReadonlyArray<unknown>[number];

const REDACTED = '"[redacted]"';

const fitsIn = (text: string, budget: number) => (text.length <= budget ? text : null);

/** JSON-like text of `value` in at most `budget` characters, or null once it can't fit. */
const bounded = (value: Argument, budget: number, seen: WeakSet<object>): string | null => {
  const fits = (text: string) => (text.length <= budget ? text : null);

  if (Predicate.isString(value)) return value.length + 2 > budget ? null : JSON.stringify(value);

  if (Predicate.isError(value)) return fits(JSON.stringify(`${value.name}: ${value.message}`));

  if (Predicate.isBigInt(value)) return fits(value.toString());

  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return fits(String(value));

  if (value === null || value === undefined) return fits(String(value));

  if (!Array.isArray(value) && !Predicate.isObject(value)) return fits(`[${typeOfValue(value)}]`);

  if (seen.has(value)) return fits("[Circular]");
  seen.add(value);
  const text = Array.isArray(value) ? list(value, budget, seen) : record(value, budget, seen);

  seen.delete(value);

  return text;
};

const typeOfValue = (value: Argument) => (Predicate.isFunction(value) ? "function" : "symbol");

const list = (items: ReadonlyArray<Argument>, budget: number, seen: WeakSet<object>) => {
  let out = "[";

  for (const item of items) {
    const part = bounded(item, budget - out.length - 2, seen);

    if (part === null) return null;
    out += (out === "[" ? "" : ",") + part;
  }

  return out.length + 1 > budget ? null : `${out}]`;
};

/** A logged object: anything `Predicate.isObject` accepts that isn't an array. */
type Logged = Readonly<object>;

const record = (value: Logged, budget: number, seen: WeakSet<object>) => {
  let out = "{";

  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const name = JSON.stringify(key);
    const room = budget - out.length - name.length - 3;
    // A data property's value; an accessor reads as undefined, so logging never runs a getter.
    const item: Argument = Object.getOwnPropertyDescriptor(value, key)?.value;
    // A sensitive key hides its whole value, nested or not, before the text scrub runs.
    const part = sensitive(key) ? fitsIn(REDACTED, room) : bounded(item, room, seen);

    if (part === null) return null;
    out += `${out === "{" ? "" : ","}${name}:${part}`;
  }

  return out.length + 1 > budget ? null : `${out}}`;
};

/** One console argument in at most `budget` characters, or null when it won't fit whole. */
export const argumentText = (value: Argument, budget: number): string | null => {
  if (Predicate.isString(value)) return value.length > budget ? null : value;

  if (Predicate.isError(value)) {
    const stack = value.stack ?? `${value.name}: ${value.message}`;

    return stack.length > budget ? null : stack;
  }

  return bounded(value, budget, new WeakSet());
};

const omitted = (value: Argument, rest: number) => {
  const first = Predicate.isString(value)
    ? `[… ${value.length.toLocaleString("en-US")} chars omitted]`
    : "[… 1 argument omitted]";

  return rest === 0 ? first : `${first} [… ${rest} more arguments omitted]`;
};

/**
 * The arguments joined in order while they fit in `limit`; the first that doesn't, and every one
 * after it, is replaced by a placeholder rather than cut.
 */
export const joinArguments = (args: ReadonlyArray<unknown>, limit: number): string => {
  let joined = "";

  for (const [index, value] of args.entries()) {
    const separator = joined === "" ? "" : " ";
    const text = argumentText(value, limit - joined.length - separator.length);

    if (text === null) return joined + separator + omitted(value, args.length - index - 1);
    joined += separator + text;
  }

  return joined;
};
