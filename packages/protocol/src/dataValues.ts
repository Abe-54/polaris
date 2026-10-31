/** Wire values and credential scrubbing shared by Data producers (ENG-644). */
import { Match, Option, Predicate, Redacted, Schema, SchemaTransformation } from "effect";

const urlEnd = (text: string, start: number, at: number, boundary: number) => {
  let tail = at !== -1 && at < boundary ? at + 1 : start + 3;

  while (tail < boundary && !/[\s"']/.test(text[tail]!)) tail++;

  return tail;
};

/** Scan schemes once, including malformed userinfo containing quotes or spaces. */
const scrubUrls = (text: string): string => {
  const pieces: string[] = [];
  let copied = 0;
  let schemeStart = 0;
  let nextAt = text.indexOf("@");
  const boundaries = /[\r\n<>]/g;
  let boundary = boundaries.exec(text)?.index ?? text.length;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (char === ":" && text.slice(i, i + 3) === "://" && schemeStart < i) {
      while (boundary < i) boundary = boundaries.exec(text)?.index ?? text.length;

      if (nextAt !== -1 && nextAt < i) nextAt = text.indexOf("@", i + 3);
      const tail = urlEnd(text, i, nextAt, boundary);
      pieces.push(text.slice(copied, schemeStart), "[redacted URL]");
      copied = tail;
      i = tail - 1;
      schemeStart = tail;
    } else if (!/[a-z\d+.-]/i.test(char)) schemeStart = i + 1;
  }

  pieces.push(text.slice(copied));

  return pieces.join("");
};

const scrubShort = (text: string, secret: string) => {
  const pieces: string[] = [];
  let copied = 0;
  let at = text.indexOf(secret);

  while (at !== -1) {
    const end = at + secret.length;

    if (!/\w/.test(text[at - 1] ?? "") && !/\w/.test(text[end] ?? "")) {
      pieces.push(text.slice(copied, at), "[redacted]");
      copied = end;
    }

    at = text.indexOf(secret, end);
  }

  pieces.push(text.slice(copied));

  return pieces.join("");
};

/**
 * Known secrets of four or more characters are scrubbed as substrings. Shorter secrets
 * match only whole values or tokens bounded by non-word characters; credential syntax
 * is always scrubbed. Resolver inputs include decoded, encoded and as-written forms.
 */
export const scrubCredentials = (
  text: string,
  known: ReadonlyArray<Redacted.Redacted<string>> = []
): string => {
  let safe = text;

  const secrets = known.flatMap((secret) => {
    const value = Redacted.value(secret);

    return value.length > 0 ? [value] : [];
  });

  for (const secret of secrets.sort((a, b) => b.length - a.length))
    safe = secret.length >= 4 ? safe.split(secret).join("[redacted]") : scrubShort(safe, secret);

  return scrubUrls(safe)
    .replace(
      /(["']?\b(?:PGPASSWORD|MYSQL_PWD|password|passwd|pwd|token|secret|api_key)["']?\s*[:=]\s*)(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|(?:\\.|[^\s,;}&])+)/gi,
      "$1[redacted]"
    )
    .replace(/[^\s<>]+/g, (token) => {
      const colon = token.indexOf(":");
      const at = token.indexOf("@", colon + 1);

      return colon > 0 && at > colon ? "[redacted credentials]" : token;
    })
    .replace(/(^|\s)-p[^\s]+/g, "$1-p[redacted]");
};

/** Scrub on both decode and encode, including instances built without a wire decode. */
export const ScrubbedText = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (text) => scrubCredentials(text),
      encode: (text) => scrubCredentials(text),
    })
  )
);

/** Hostnames, bracketed IPv6 and Unix sockets, never URLs or userinfo. */
export const DataHost = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (host) =>
      !/[\s@?#]/.test(host) &&
      !host.includes("://") &&
      (host.startsWith("/") ||
        /^[0-9a-f]*:[0-9a-f:]+$/i.test(host) ||
        /^\[[0-9a-f:.]+\]$/i.test(host) ||
        /^[a-z0-9_.-]+$/i.test(host))
  )
);

export const DATA_CELL_BYTES = 64 * 1024;

export const DATA_CHUNK_BYTES = 1024 * 1024;

export const dataJsonBytes = (value: Schema.Json): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DataValueTags = Schema.TaggedUnion({
  Bytes: {
    length: Count,
    preview: Schema.optionalKey(Schema.String),
    base64: Schema.optionalKey(Schema.String),
  },
  BigInt: { value: Schema.String },
  Numeric: { value: Schema.String },
  Json: { text: Schema.String },
  Timestamp: { iso: Schema.String },
  Truncated: { preview: Schema.String, bytes: Count },
});

/** Drivers normalise Dates, bigint, bytes and JSON before constructing a QueryResult. */
export const DataValue = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.String,
  Schema.Finite,
  DataValueTags,
]).check(Schema.makeFilter((value) => dataJsonBytes(value) <= DATA_CELL_BYTES));

export type DataValue = typeof DataValue.Type;

/** Decode only string tokens: parsing the whole document rounds database numeric lexemes. */
const scrubJsonText = (text: string, known: ReadonlyArray<Redacted.Redacted<string>>): string =>
  text.replace(/"(?:\\.|[^"\\])*"/g, (token) =>
    Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))(token), {
      onNone: () => scrubCredentials(token, known),
      onSome: (value) => JSON.stringify(scrubCredentials(value, known)),
    })
  );

/** Apply known credentials to every string value, regardless of the column name. */
export const scrubDataValue = (
  value: DataValue,
  known: ReadonlyArray<Redacted.Redacted<string>> = []
): DataValue => {
  if (Predicate.isString(value)) return scrubCredentials(value, known);

  if (value === null) return value;

  if (!Predicate.isObject(value)) {
    const safe = scrubCredentials(String(value), known);

    return safe === String(value) ? value : safe;
  }

  return Match.value(value).pipe(
    Match.tag("Bytes", (v) => {
      const decoded =
        v.base64 === undefined
          ? undefined
          : new TextDecoder().decode(Uint8Array.fromBase64(v.base64));

      const safe = decoded === undefined || scrubCredentials(decoded, known) === decoded;

      return DataValueTags.cases.Bytes.make({
        length: v.length,
        ...(safe && v.base64 !== undefined ? { base64: v.base64 } : undefined),
        ...(v.preview === undefined ? undefined : { preview: scrubCredentials(v.preview, known) }),
      });
    }),
    Match.tag("BigInt", "Numeric", (v) => ({ ...v, value: scrubCredentials(v.value, known) })),
    Match.tag("Json", (v) => DataValueTags.cases.Json.make({ text: scrubJsonText(v.text, known) })),
    Match.tag("Timestamp", (v) =>
      DataValueTags.cases.Timestamp.make({ iso: scrubCredentials(v.iso, known) })
    ),
    Match.tag("Truncated", (v) =>
      DataValueTags.cases.Truncated.make({ ...v, preview: scrubCredentials(v.preview, known) })
    ),
    Match.exhaustive
  );
};

export const ScrubbedDataValue = DataValue.pipe(
  Schema.decodeTo(
    DataValue,
    SchemaTransformation.transform({
      decode: (value) => scrubDataValue(value),
      encode: (value) => scrubDataValue(value),
    })
  )
);
