import { DataError, DataValueTags } from "@polaris/protocol";
import { Option, Predicate, Schema } from "effect";

export const catalogError = (engine: string, field: string) =>
  new DataError({
    code: "E-DATA-SQL",
    message: `Could not decode ${engine} catalog field ${field}.`,
    fix: "Refresh the schema. If this persists, report the engine and field named here.",
  });

export type CatalogValue = Schema.Json | Uint8Array | undefined;

export function catalogValues(engine: "postgres" | "mysql") {
  function decode<A, I>(field: string, schema: Schema.ConstraintDecoder<A>, value: I): A {
    const decoded = Schema.decodeUnknownOption(schema)(value);

    if (Option.isNone(decoded)) throw catalogError(engine, field);

    return decoded.value;
  }

  function plain(field: string, value: CatalogValue): Schema.Json | undefined {
    if (Schema.is(Schema.Uint8Array)(value)) return new TextDecoder().decode(value);

    if (Predicate.isTagged(value, "Json"))
      return decode(
        field,
        Schema.fromJsonString(Schema.Json),
        decode(field, DataValueTags.cases.Json, value).text
      );

    if (Predicate.isTagged(value, "Numeric") || Predicate.isTagged(value, "BigInt"))
      return Number(
        decode(
          field,
          Schema.Union([DataValueTags.cases.Numeric, DataValueTags.cases.BigInt]),
          value
        ).value
      );

    return value;
  }

  function json<A>(field: string, schema: Schema.ConstraintDecoder<A>, value: CatalogValue): A {
    const parsed = plain(field, value);

    return decode(
      field,
      schema,
      Predicate.isString(parsed)
        ? decode(field, Schema.fromJsonString(Schema.Json), parsed)
        : parsed
    );
  }

  return {
    plain,
    json,
    decode,
    text: (field: string, value: CatalogValue) => decode(field, Schema.String, plain(field, value)),
    number: (field: string, value: CatalogValue) =>
      decode(field, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), plain(field, value)),
    bool: (field: string, value: CatalogValue) => {
      const parsed = decode(
        field,
        Schema.Union([Schema.Boolean, Schema.Literals([0, 1])]),
        plain(field, value)
      );

      return parsed === true || parsed === 1;
    },
  };
}
