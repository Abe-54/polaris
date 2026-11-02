/**
 * Secret redaction for trace text, shared by the Daemon's receiver and every Self-Trace recorder
 * (ENG-754): credentials in URLs, bearer and vendor tokens, and key=value secrets become markers.
 */
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

const stackLocation = (text: string, offset: number, match: string): boolean => {
  if (!/^[\w.-]+\.[cm]?[jt]sx?:\d+:\d+\)?$/.test(match)) return false;

  const start = text.lastIndexOf("\n", offset) + 1;
  const end = text.indexOf("\n", offset);
  const line = text.slice(start, end === -1 ? undefined : end);

  return /^\s*at\s+(?:.*\s+\()?[^()\r\n]+\.[cm]?[jt]sx?:\d+:\d+\)?\s*$/.test(line);
};

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
      (match, key: string, offset: number, input: string) =>
        stackLocation(input, offset, match) ? match : `${key}[redacted]`
    );

export const redactOutsideUrls = (text: string): string => {
  if (!text.includes("://")) return redactSecrets(text);

  return text
    .split(/((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+)/gi)
    .map((part, index) => (index % 2 === 0 ? redactSecrets(part) : part))
    .join("");
};

export const redactText = (text: string): string => redactOutsideUrls(redactUrls(text));
