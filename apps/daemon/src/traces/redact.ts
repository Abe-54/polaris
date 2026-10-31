import { scrubCredentials, type TraceAttributes } from "@polaris/protocol";
import type { Schema } from "effect";
import type { OtlpAttribute, OtlpValue } from "./otlp.ts";

/** Match semantic-convention prefixes and camelCase as well as header names. */
export const sensitive = (key: string): boolean =>
  /authorization|cookie|token|api[-_. ]?key|password|passwd|secret|credential|private[-_. ]?key/i.test(
    key
  );

export const redactText = (text: string): string =>
  scrubCredentials(text)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "[redacted]")
    .replace(
      /(?<![\w.-])((?:authorization|set-cookie|cookie|[\w.-]{0,128}(?:token|api[-_.]?key|password|secret))["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;&]+)/gi,
      "$1[redacted]"
    );

export const attributes = (items: ReadonlyArray<OtlpAttribute> = []): TraceAttributes =>
  Object.fromEntries(
    items.map(({ key, value }) => [key, sensitive(key) ? "[redacted]" : attributeValue(value)])
  );

export const attributeValue = (value: OtlpValue | undefined): Schema.Json => {
  if (value === undefined) return null;

  if (value.stringValue !== undefined)
    return redactText(value.stringValue) === value.stringValue ? value.stringValue : "[redacted]";

  if (value.boolValue !== undefined) return value.boolValue;

  if (value.intValue !== undefined) return String(value.intValue);

  if (value.doubleValue !== undefined) return value.doubleValue;

  if (value.bytesValue !== undefined) return value.bytesValue;

  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map(attributeValue);

  return attributes(value.kvlistValue?.values);
};
