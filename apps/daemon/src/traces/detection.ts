import { opendir } from "node:fs/promises";
import { Option, Schema } from "effect";
import { DetectedTraceExporter, TraceForwardTarget } from "@polaris/protocol";
import { secondExporterLine } from "./secondExporter.ts";
import { read } from "../data/read.ts";
import type { TraceEnvironment } from "./runtime.ts";

export interface Collector {
  readonly traces: string | null;
  readonly logs: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly logHeaders: Readonly<Record<string, string>>;
}

export interface ExporterDetection {
  readonly collector: Collector | null;
  readonly suggestedCollector: Collector | null;
  readonly detectedExporters: ReadonlyArray<DetectedTraceExporter>;
}

const manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export const isPolarisEndpoint = (value: string | undefined) => {
  if (value === undefined) return false;

  try {
    const url = new URL(value);

    return (
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      /\/otlp\/[a-f0-9]{64}/.test(url.pathname)
    );
  } catch {
    return false;
  }
};

const endpoint = (value: string | undefined): string | null => {
  if (!value || value.length > 8192) return null;

  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      return null;
    // A Polaris token endpoint is never an upstream collector, including after a restart.

    if (isPolarisEndpoint(url.href)) return null;

    return url.href;
  } catch {
    return null;
  }
};

const signalUrl = (base: string | undefined, signal: string) => {
  const url = endpoint(base);

  if (url === null) return null;
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/v1/${signal}`;

  return parsed.href;
};

const headers = (value: string | undefined) => {
  const result: Record<string, string> = {};

  if (!value || value.length > 16_384) return result;

  for (const entry of value.split(",").slice(0, 64)) {
    const split = entry.indexOf("=");

    if (split < 1) continue;

    try {
      const key = entry.slice(0, split).trim();
      const value = decodeURIComponent(entry.slice(split + 1).trim());
      const parsed = new Headers({ [key]: value });
      parsed.forEach((v, k) => {
        result[k] = v;
      });
    } catch {
      /* Invalid header entries never prevent local collection. */
    }
  }

  return result;
};

export const collectorFromEnvironment = (env: TraceEnvironment): Collector | null => {
  const traces =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT !== undefined
      ? endpoint(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
      : signalUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT, "traces");

  const logs =
    env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT !== undefined
      ? endpoint(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
      : signalUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT, "logs");

  if (traces === null && logs === null) return null;

  return {
    traces,
    logs,
    headers: headers(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
    logHeaders: headers(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
  };
};

/** Public metadata omits every unknown path: URLs can carry secrets outside userinfo/query. */
export const publicCollector = (collector: Collector | null) => {
  if (collector?.traces == null) return null;
  const url = new URL(collector.traces);

  if (!/^\/(?:v1\/traces)?$/.test(url.pathname)) return null;

  const parsed = Schema.decodeUnknownOption(TraceForwardTarget)({
    url: url.href,
    headerNames: Object.keys(collector.headers).sort(),
  });

  return Option.getOrNull(parsed);
};

const parseEnvironment = (text: string) => {
  const values: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);

    if (match === null) continue;
    let value = match[2]!.trim();

    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s*#.*$/, "").trim();
    // Discovery never expands shell commands or references other environment values.

    if (!value.includes("$")) values[match[1]!] = value;
  }

  return values;
};

const evidence = (
  kind: DetectedTraceExporter["kind"],
  file: string,
  text: string,
  at: number,
  alreadyExporting = false
) =>
  DetectedTraceExporter.make({
    kind,
    file,
    line: text.slice(0, Math.max(0, at)).split("\n").length,
    runtime: null,
    alreadyExporting,
  });

const environmentFiles = async (checkout: string, source: TraceEnvironment) => {
  const names: string[] = [];

  try {
    const directory = await opendir(checkout);
    let scanned = 0;

    for await (const entry of directory) {
      if (entry.name.startsWith(".env")) names.push(entry.name);

      if (++scanned >= 256) break;
    }
  } catch {
    /* Missing checkouts have no file-derived target. */
  }

  const mode = /^[a-z0-9_-]{1,32}$/i.test(source.NODE_ENV ?? "") ? source.NODE_ENV! : "development";
  const preferred = [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"];

  return [...new Set([...preferred, ...names.sort((a, b) => a.localeCompare(b))])]
    .filter(
      (name) =>
        /^\.env(?:\.[a-z0-9_-]+)*$/i.test(name) && !/\.(example|sample|template)$/.test(name)
    )
    .slice(0, 16);
};

const vendorCollector = (env: TraceEnvironment): Collector | null => {
  const configured = endpoint(env.AXIOM_OTLP_ENDPOINT ?? env.VERCEL_OTEL_ENDPOINT);

  if (configured !== null) return { traces: configured, logs: null, headers: {}, logHeaders: {} };

  if (env.VERCEL_OTEL_ENDPOINTS) {
    const port = env.VERCEL_OTEL_ENDPOINTS_PORT ?? "4318";

    if (/^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535)
      return {
        traces: `http://localhost:${port}/v1/traces`,
        logs: null,
        headers: {},
        logHeaders: {},
      };
  }

  if (!env.AXIOM_TOKEN || !env.AXIOM_DATASET) return null;

  return {
    traces: signalUrl(
      env.AXIOM_URL ?? (env.AXIOM_DOMAIN ? `https://${env.AXIOM_DOMAIN}` : "https://api.axiom.co"),
      "traces"
    ),
    logs: null,
    headers: { authorization: `Bearer ${env.AXIOM_TOKEN}`, "x-axiom-dataset": env.AXIOM_DATASET },
    logHeaders: {},
  };
};

export const detectExporters = async (
  checkout: string,
  source: TraceEnvironment
): Promise<ExporterDetection> => {
  const detected: DetectedTraceExporter[] = [];
  const files: Record<string, string> = {};

  for (const file of await environmentFiles(checkout, source)) {
    const text = await read(checkout, file);
    const env = parseEnvironment(text);

    for (const [key, value] of Object.entries(env))
      if (files[key] === undefined) files[key] = value;

    if (Object.keys(env).some((key) => /^(OTEL_EXPORTER_OTLP|AXIOM_|VERCEL_OTEL)/.test(key)))
      detected.push(
        evidence("otlp-env", file, text, text.search(/(?:OTEL_EXPORTER_OTLP|AXIOM_|VERCEL_OTEL)/))
      );
  }

  const env = {
    ...files,
    ...Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined)),
  };

  const text = await read(checkout, "package.json");
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(manifest))(text);

  const dependencies = Option.isSome(parsed)
    ? { ...parsed.value.dependencies, ...parsed.value.devDependencies }
    : {};

  if (Object.keys(dependencies).some((key) => key.startsWith("@axiomhq/") || key === "next-axiom"))
    detected.push(evidence("axiom", "package.json", text, text.search(/@axiomhq\/|next-axiom/)));

  detected.push(...(await detectVercel(checkout, dependencies, env, text)));

  if (
    Object.keys(source).some(
      (key) => key.startsWith("OTEL_EXPORTER_OTLP") && source[key] !== undefined
    )
  )
    detected.push(evidence("otlp-env", "environment", "", 0));

  if (env.AXIOM_TOKEN || env.AXIOM_DATASET) detected.push(evidence("axiom", "environment", "", 0));

  if (env.VERCEL_OTEL_ENDPOINT || env.VERCEL_OTEL_ENDPOINTS)
    detected.push(evidence("vercel", "environment", "", 0));

  return {
    collector: collectorFromEnvironment(source) ?? collectorFromEnvironment(files),
    suggestedCollector: vendorCollector(env),
    detectedExporters: detected,
  };
};

const detectVercel = async (
  checkout: string,
  dependencies: Record<string, string>,
  env: TraceEnvironment,
  text: string
) => {
  const detected: DetectedTraceExporter[] = [];

  if (dependencies["@vercel/otel"] !== undefined) {
    detected.push(evidence("vercel", "package.json", text, text.indexOf("@vercel/otel")));

    for (const file of [
      "instrumentation.ts",
      "instrumentation.js",
      "src/instrumentation.ts",
      "src/instrumentation.js",
      "instrumentation.node.ts",
      "src/instrumentation.node.ts",
    ]) {
      const code = await read(checkout, file);
      const line = env.VERCEL_OTEL_ENDPOINTS ? null : await secondExporterLine(code, env);

      if (line !== null)
        detected.push(
          DetectedTraceExporter.make({
            kind: "vercel",
            file,
            line,
            runtime: "node",
            alreadyExporting: true,
          })
        );
    }
  }

  return detected;
};
