/** Wire values and credential scrubbing shared by Data producers (ENG-644). */
import { Match, Option, Predicate, Redacted, Schema, SchemaTransformation } from "effect";

/** Known credentials must include URL-decoded and percent-encoded forms from the resolver. */
export const scrubCredentials = (
  text: string,
  known: ReadonlyArray<Redacted.Redacted<string>> = []
): string => {
  let safe = text;

  const secrets = known.flatMap((secret) => {
    const value = Redacted.value(secret);

    return value.length >= 4 ? [value] : [];
  });

  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join("[redacted]");
  }

  return safe
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/"'<>]*@/gi,
      (url) => url.slice(0, url.indexOf("://") + 3) + "[redacted]@"
    )
    .replace(
      /\b((?:PGPASSWORD|MYSQL_PWD|password|passwd|pwd)\s*=\s*)(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|(?:\\.|[^\s;&])+)/gi,
      "$1[redacted]"
    );
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
  Bytes: { length: Count, preview: Schema.optionalKey(Schema.String) },
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

  if (value === null || !Predicate.isObject(value)) return value;

  return Match.value(value).pipe(
    Match.tag("Bytes", (v) =>
      v.preview === undefined
        ? v
        : DataValueTags.cases.Bytes.make({
            length: v.length,
            preview: scrubCredentials(v.preview, known),
          })
    ),
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
