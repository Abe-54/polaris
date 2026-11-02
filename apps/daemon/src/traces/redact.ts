import { redactOutsideUrls, redactText, redactUrls, sensitive } from "@polaris/client/redact";
import type { TraceAttributes } from "@polaris/protocol";
import type { Schema } from "effect";
import type { OtlpAttribute, OtlpValue } from "./otlp.ts";

export { redactText, redactUrls, sensitive };

const stringValue = (text: string) => {
  const urls = redactUrls(text);
  // Preserve URL-only edits; other credential-bearing attributes keep the literal redaction marker.

  return redactOutsideUrls(urls) === urls ? urls : "[redacted]";
};

export const attributes = (items: ReadonlyArray<OtlpAttribute> = []): TraceAttributes =>
  Object.fromEntries(
    items.map(({ key, value }) => {
      if (sensitive(key)) return [key, "[redacted]"];

      if (key === "process.command_args" && value?.arrayValue !== undefined) {
        const joined = (value.arrayValue.values ?? [])
          .map((part) => part.stringValue ?? "")
          .join(" ");

        if (redactText(joined) !== joined) return [key, "[redacted]"];
      }

      return [key, attributeValue(value)];
    })
  );

export const attributeValue = (value: OtlpValue | undefined): Schema.Json => {
  if (value === undefined) return null;

  if (value.stringValue !== undefined) return stringValue(value.stringValue);

  if (value.boolValue !== undefined) return value.boolValue;

  if (value.intValue !== undefined) return String(value.intValue);

  if (value.doubleValue !== undefined) return value.doubleValue;
  // Binary telemetry has no safe text interpretation; never persist opaque credential containers.

  if (value.bytesValue !== undefined) return "[redacted]";

  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map(attributeValue);

  return attributes(value.kvlistValue?.values);
};
