/** Canonical typed identities do not depend on object property order or JSON serialization. */
import type { DataValue } from "@polaris/protocol";
import { Match, Predicate } from "effect";
import { writeError } from "./writeSql.ts";

const part = (tag: string, value: string) => `${tag}:${value.length}:${value}`;

export function dataKey(value: DataValue): string {
  if (value === null) return "null";

  if (!Predicate.isObject(value))
    return part(
      Predicate.isString(value) ? "string" : Predicate.isNumber(value) ? "number" : "boolean",
      String(value)
    );

  return Match.value(value).pipe(
    Match.tag("BigInt", "Numeric", (v) => part(v._tag, v.value)),
    Match.tag("Timestamp", (v) => part("Timestamp", v.iso)),
    Match.tag("Bytes", (v) => {
      if (v.base64 === undefined)
        throw writeError(
          "This binary key has no bindable bytes.",
          "Reload the table before editing it."
        );

      return part("Bytes", v.base64);
    }),
    Match.orElse(() => {
      throw writeError(
        "This primary key type cannot be edited.",
        "Use the app's own code for this key type."
      );
    })
  );
}

export const rowKey = (values: ReadonlyArray<DataValue>) => values.map(dataKey).join("|");
