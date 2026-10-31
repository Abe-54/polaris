/** Persist display-safe SQL text; fingerprints preserve comparisons of redacted literals. */
import { createHash } from "node:crypto";
import { scrubCredentials } from "@polaris/protocol";

export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

export const scrubCatalogText = (text: string) => {
  if (/\\['"]/.test(text)) return "[redacted SQL expression]";

  return scrubCredentials(text)
    .replace(/(\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$)[\s\S]*?\1/g, "'[redacted]'")
    .replace(/'(?:''|\\.|[^'\\])*'/gs, "'[redacted]'")
    .replace(/"(?:""|\\.|[^"\\])*"/gs, '"[redacted]"');
};
