/** The frame document: CSP, tokens, the libraries, the kit and the agent's fragment, in that order. */
import { resolveFrameTokens } from "../tokens.ts";
import { source as chartJsSource } from "../vendor/chartjs.ts";
import { source as d3Source } from "../vendor/d3.ts";
import { bootstrapScript } from "./bootstrap/index.ts";
import { KIT_CSS } from "./kit-css.ts";

/** The only policy a frame runs under; it is the first thing in `<head>` (ADR 0101). */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Which vendored libraries a document carries: `auto` only those the fragment names. */
export type FrameLibraries = "auto" | "all";

export interface FrameDocumentInput {
  readonly html: string;
  readonly title: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly scheme: "light" | "dark";
  readonly state?: unknown;
  readonly mode: "inline" | "expanded";
  readonly libraries?: FrameLibraries;
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** A fragment can only reach a library through its global or the kit helper built on it. */
const USES_CHART = /\bChart\b|\bpv\s*\.\s*chart\b/;

const USES_D3 = /\bd3\b|\bpv\s*\.\s*flow\b/;

const rootRule = (tokens: Readonly<Record<string, string>>, scheme: "light" | "dark"): string => {
  const lines = Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`);

  return `:root {\n${lines.join("\n")}\n  color-scheme: ${scheme};\n}`;
};

export const buildFrameDocumentWith = (options: FrameDocumentInput): string => {
  const all = (options.libraries ?? "auto") === "all";

  const scripts = [
    all || USES_CHART.test(options.html) ? chartJsSource : undefined,
    all || USES_D3.test(options.html) ? d3Source : undefined,
    bootstrapScript(
      options.state === undefined
        ? { mode: options.mode, scheme: options.scheme }
        : { mode: options.mode, scheme: options.scheme, state: options.state }
    ),
  ].filter((script): script is string => script !== undefined);

  const tokens = resolveFrameTokens(options.tokens, options.scheme);

  return [
    `<!doctype html><html lang="en" data-pv-mode="${options.mode}"><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>\n${rootRule(tokens, options.scheme)}\n${KIT_CSS}</style>`,
    ...scripts.map((script) => `<script>${script}</script>`),
    `</head><body>`,
    options.html,
    `</body></html>`,
  ].join("\n");
};
