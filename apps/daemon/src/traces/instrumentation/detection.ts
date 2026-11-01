import { DetectedTraceExporter } from "@polaris/protocol";
import { gitText } from "../../git/git.ts";
import { packageInfo } from "./package.ts";
import { readCheckoutFile } from "./read.ts";

/** P10 can offer this task with the evidence's file:line, without exposing the literal collector URL. */
export const fixedExporterChange =
  "Read OTEL_EXPORTER_OTLP_TRACES_ENDPOINT with the existing URL as fallback: url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? existingVendorUrl,";

export interface FixedExporterScan {
  readonly checkout: string;
  readonly appRan: boolean;
  readonly spansArrived: boolean;
}

const files = async (checkout: string) => {
  try {
    const stdout = await gitText(
      checkout,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { timeoutMs: 2000, maxOutputBytes: 256 * 1024 }
    );

    return [...new Set(stdout.split("\0"))]
      .filter((file) => file && !/(^|\/)(node_modules|\.git|dist|build|vendor)\//.test(file))
      .sort()
      .slice(0, 1024);
  } catch {
    return [];
  }
};

/** Conservative source evidence: an OTLP trace exporter constructor with a literal HTTP(S) url. */
export const fixedExporterLines = (source: string) => {
  const strings: Array<{ start: number; end: number }> = [];
  source = source.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (token, offset: number) => {
      if (token.startsWith("/")) return token.replace(/[^\r\n]/g, " ");
      strings.push({ start: offset, end: offset + token.length });

      return token;
    }
  );
  const lines: number[] = [];
  const constructors = /new\s+OTLP(?:Trace)?Exporter\s*\(\s*\{([\s\S]{0,4096}?)\}\s*\)/g;

  for (const match of source.matchAll(constructors)) {
    if (strings.some(({ start, end }) => start <= match.index && match.index < end)) continue;
    const body = match[1]!;
    const url = /(?:\burl|["']url["'])\s*:\s*(["'`])https?:\/\/[^"'`\r\n]+\1/.exec(body);

    if (!url || url[0].includes("${") || body.includes("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"))
      continue;
    const offset = match.index + match[0].indexOf(body) + url.index;
    lines.push(source.slice(0, offset).split("\n").length);
  }

  return lines;
};

/** Launch/read-triggered only: bounded gitignore-aware discovery, with no watcher or idle timer. */
export const detectFixedExporters = async (
  options: FixedExporterScan
): Promise<DetectedTraceExporter[]> => {
  if (!options.appRan || options.spansArrived) return [];
  const paths = await files(options.checkout);
  let budget = 4 * 1024 * 1024;
  let hasOtel = false;
  const sources: Array<{ file: string; source: string }> = [];

  for (const file of paths) {
    if (!/(^|\/)package\.json$|\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = await readCheckoutFile(options.checkout, file);
    budget -= Buffer.byteLength(source);

    if (budget < 0) break;

    if (file.endsWith("package.json")) {
      hasOtel ||= packageInfo(source).dependencies.some(
        (name) => name.startsWith("@opentelemetry/") || name === "@vercel/otel"
      );
    } else sources.push({ file, source });
  }

  if (!hasOtel) return [];

  return sources
    .flatMap(({ file, source }) =>
      fixedExporterLines(source).map((line) =>
        DetectedTraceExporter.make({
          kind: "fixed-url",
          file,
          line,
          runtime: null,
          alreadyExporting: false,
        })
      )
    )
    .slice(0, 32);
};
