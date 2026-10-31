import type { TraceAttributes } from "@polaris/protocol";
import type { Schema } from "effect";
import type { OtlpAttribute, OtlpValue } from "./otlp.ts";

/** Match semantic-convention prefixes and camelCase as well as header names. */
export const sensitive = (key: string): boolean =>
  /auth|cookie|token|api[-_. ]?key|password|passwd|secret|credential|private[-_. ]?key|signature|jwt|session|passphrase|pwd/i.test(
    key
  );

const querySecret = (key: string) => sensitive(key) || /^(sig|code|key|x-amz-.*)$/i.test(key);

/** Preserve URL spelling, paths and stack-frame locations; only credentials are replaced. */
export const redactUrls = (text: string): string =>
  text.replace(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (url) =>
    url
      .replace(/^(\w[\w+.-]*:\/\/)[^/?#]*@/, "$1[redacted]@")
      .replace(/([?&])([^=&#]+)=([^&#]*)/g, (pair, separator: string, key: string) => {
        let decoded = key;

        try {
          decoded = decodeURIComponent(key.replace(/\+/g, " "));
        } catch {
          /* Keep malformed keys literal. */
        }

        return querySecret(decoded) ? `${separator}${key}=[redacted]` : pair;
      })
  );

const redactSecrets = (text: string): string =>
  text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "[redacted]")
    .replace(
      /\b(?:sk-[\w-]+|gh[pousr]_[\w]+|xox[a-z]-[\w-]+|AKIA[A-Z0-9]{16}|eyJ[\w-]*\.[\w-]+\.[\w-]+)\b/g,
      "[redacted]"
    )
    .replace(
      /\b((?:PASSWORD|IDENTIFIED\s+BY)\s+)(?:'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|[^\s;,]+)/gi,
      "$1[redacted]"
    )
    .replace(
      /(--[\w-]*(?:password|passwd|token|secret|api-key|passphrase|pwd)[\w-]*(?:=|\s+))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi,
      "$1[redacted]"
    )
    .replace(
      /(?<![\w.-])([\w.-]*(?:auth|cookie|token|api[-_.]?key|password|passwd|secret|credential|signature|jwt|session|passphrase|pwd)[\w.-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;&\s]+)/gi,
      "$1[redacted]"
    );

const redactOutsideUrls = (text: string): string => {
  if (!text.includes("://")) return redactSecrets(text);

  return text
    .split(/((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+)/gi)
    .map((part, index) => (index % 2 === 0 ? redactSecrets(part) : part))
    .join("");
};

export const redactText = (text: string): string => redactOutsideUrls(redactUrls(text));

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
