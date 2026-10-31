/** Decode raw protocol values without rounding exact numerics, JSON tokens or microseconds. */
import {
  DataValueTags,
  DATA_CELL_BYTES,
  dataJsonBytes,
  scrubDataValue,
  type DataValue,
} from "@polaris/protocol";
import { Schema, Predicate, type Redacted } from "effect";
import { catalogError, catalogValues } from "./catalogValues.ts";

export const Column = Schema.Struct({
  name: Schema.String,
  type: Schema.Int,
  flags: Schema.optionalKey(Schema.Int),
});

export type Column = typeof Column.Type;

export interface RawResult extends Array<Array<Uint8Array | null>> {
  columns: ReadonlyArray<Column>;
}

const decodeColumns = Schema.decodeUnknownSync(Schema.Array(Column));

const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Array(Schema.NullOr(Schema.Uint8Array)))
);

function compactJson(text: string) {
  let quoted = false;
  let escaped = false;
  let result = "";

  for (const char of text) {
    if (quoted) {
      result += char;

      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (!/\s/.test(char)) result += char;
  }

  return result;
}

const numeric = (value: string) => DataValueTags.cases.Numeric.make({ value });

const bigint = (value: string) => DataValueTags.cases.BigInt.make({ value });

const bytes = (length: number) => DataValueTags.cases.Bytes.make({ length });

const json = (text: string) => DataValueTags.cases.Json.make({ text: compactJson(text) });

const timestamp = (iso: string) => DataValueTags.cases.Timestamp.make({ iso });

const pad = (n: number, size = 2) => String(n).padStart(size, "0");

function mysqlDate(buffer: Buffer, type: number): DataValue {
  if (buffer.length === 0) return "0000-00-00";
  const date = `${pad(buffer.readUInt16LE(0), 4)}-${pad(buffer[2]!)}-${pad(buffer[3]!)}`;

  if (type === 10 || buffer.length === 4) return date;
  const time = `${pad(buffer[4]!)}:${pad(buffer[5]!)}:${pad(buffer[6]!)}`;
  const fraction = buffer.length >= 11 ? `.${pad(buffer.readUInt32LE(7), 6)}` : "";

  // DATETIME has no timezone. TIMESTAMP uses the connection's forced UTC session zone.
  return type === 7 ? timestamp(`${date}T${time}${fraction}+00:00`) : `${date} ${time}${fraction}`;
}

function mysqlTime(buffer: Buffer): string {
  if (!buffer.length) return "00:00:00";
  const hours = buffer.readUInt32LE(1) * 24 + buffer[5]!;

  return `${buffer[0] ? "-" : ""}${pad(hours)}:${pad(buffer[6]!)}:${pad(buffer[7]!)}${buffer.length >= 12 ? `.${pad(buffer.readUInt32LE(8), 6)}` : ""}`;
}

export function mysqlValue(buffer: Buffer, column: Column, catalogText: boolean): DataValue {
  const unsigned = ((column.flags ?? 0) & 32) !== 0;

  switch (column.type) {
    case 0:
    case 246:
      return numeric(buffer.toString());
    case 8:
      return bigint((unsigned ? buffer.readBigUInt64LE() : buffer.readBigInt64LE()).toString());
    case 1:
      return unsigned ? buffer.readUInt8() : buffer.readInt8();
    case 2:
    case 13:
      return unsigned ? buffer.readUInt16LE() : buffer.readInt16LE();
    case 3:
    case 9:
      return unsigned ? buffer.readUInt32LE() : buffer.readInt32LE();
    case 4:
      return finite(buffer.readFloatLE());
    case 5:
      return finite(buffer.readDoubleLE());
    case 7:
    case 10:
    case 12:
      return mysqlDate(buffer, column.type);
    case 11:
      return mysqlTime(buffer);
    case 245:
      return json(buffer.toString());
    case 16:
      return bytes(buffer.length);
    default:
      return !catalogText && ((column.flags ?? 0) & 128) !== 0
        ? bytes(buffer.length)
        : buffer.toString();
  }
}

const finite = (value: number): DataValue => (Number.isFinite(value) ? value : String(value));

function postgresValue(buffer: Buffer, column: Column): DataValue {
  const text = buffer.toString();

  switch (column.type) {
    case 16:
      return text === "t";
    case 20:
      return bigint(text);
    case 1700:
      return numeric(text);
    case 21:
    case 23:
    case 26:
    case 700:
    case 701:
      return finite(Number(text));
    case 114:
    case 3802:
      return json(text);
    case 17:
      return bytes(text.startsWith("\\x") ? (text.length - 2) / 2 : buffer.length);
    case 1184:
      return timestamp(text.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
    default:
      return text;
  }
}

function bounded(value: DataValue): DataValue {
  const size = dataJsonBytes(value);

  if (size <= DATA_CELL_BYTES) return value;
  const text = Predicate.isString(value) ? value : JSON.stringify(value);

  // A code unit occupies at most six JSON bytes, even for escaping and lone surrogates.
  return DataValueTags.cases.Truncated.make({
    preview: text.slice(0, Math.floor((DATA_CELL_BYTES - 128) / 6)),
    bytes: size,
  });
}

export function decodeResult(
  result: RawResult,
  engine: "postgres" | "mysql",
  known: ReadonlyArray<Redacted.Redacted<string>>,
  catalogText = false
) {
  const catalog = catalogText ? catalogValues(engine) : undefined;

  const columns = catalog
    ? catalog.decode("result.columns", Schema.Array(Column), result.columns)
    : decodeColumns(result.columns);

  const rows = catalog
    ? catalog.decode(
        "result.rows",
        Schema.Array(Schema.Array(Schema.NullOr(Schema.Uint8Array))),
        result
      )
    : decodeRows(result);

  return {
    columns,
    rows: rows.map((row) =>
      row.map((value, i) => {
        try {
          return value === null
            ? null
            : bounded(
                scrubDataValue(
                  engine === "postgres"
                    ? postgresValue(Buffer.from(value), columns[i]!)
                    : mysqlValue(Buffer.from(value), columns[i]!, catalogText),
                  known
                )
              );
        } catch (error) {
          if (catalogText) throw catalogError(engine, columns[i]?.name ?? "result.columns");
          throw error;
        }
      })
    ),
  };
}

interface TypeNames {
  readonly [id: number]: string;
}

export const typeName = (engine: "postgres" | "mysql", column: Column) => {
  const pg: TypeNames = {
    16: "boolean",
    17: "bytea",
    20: "bigint",
    21: "smallint",
    23: "integer",
    25: "text",
    114: "json",
    700: "real",
    701: "double precision",
    1082: "date",
    1114: "timestamp",
    1184: "timestamptz",
    1700: "numeric",
    2950: "uuid",
    3802: "jsonb",
  };

  const my: TypeNames = {
    0: "decimal",
    1: "tinyint",
    2: "smallint",
    3: "int",
    4: "float",
    5: "double",
    7: "timestamp",
    8: "bigint",
    9: "mediumint",
    10: "date",
    11: "time",
    12: "datetime",
    13: "year",
    16: "bit",
    245: "json",
    246: "decimal",
    252: "blob/text",
    253: "varchar",
    254: "char",
  };

  return (engine === "postgres" ? pg : my)[column.type] ?? String(column.type);
};
