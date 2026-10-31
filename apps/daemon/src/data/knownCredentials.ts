/** Exact credential scrubbing until the shared protocol helper lands (CF). */
import { Redacted, Schema, Predicate } from "effect";

export const knownFromUrl = (url: Redacted.Redacted<string>) => {
  const known = [url];

  try {
    const password = decodeURIComponent(new URL(Redacted.value(url)).password);

    if (password !== "")
      known.push(Redacted.make(password), Redacted.make(encodeURIComponent(password)));
  } catch {
    /* An invalid connection target is handled by discovery/execution. */
  }

  return known;
};

export const scrubKnown = (text: string, known: ReadonlyArray<Redacted.Redacted<string>>) => {
  let result = text;

  const secrets: string[] = [];

  for (const credential of known) {
    const value = Redacted.value(credential);

    if (value.length >= 4) secrets.push(value);
  }

  secrets.sort((a, b) => b.length - a.length);

  for (const secret of secrets) result = result.replaceAll(secret, "[redacted]");

  return result;
};

export const scrubKnownJson = (
  value: typeof Schema.Json.Type,
  known: ReadonlyArray<Redacted.Redacted<string>>
): typeof Schema.Json.Type => {
  if (Predicate.isString(value)) return scrubKnown(value, known);

  if (Array.isArray(value))
    return Schema.decodeUnknownSync(Schema.Array(Schema.Json))(value).map((item) =>
      scrubKnownJson(item, known)
    );

  if (Predicate.isObject(value))
    return Object.fromEntries(
      Object.entries(
        Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(value)
      ).map(([key, item]) => [scrubKnown(key, known), scrubKnownJson(item, known)])
    );

  return value;
};
