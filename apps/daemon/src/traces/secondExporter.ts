import type { SgNode } from "@ast-grep/napi";
import type { TraceEnvironment } from "./runtime.ts";
import { loadAstGrep } from "../rules/patterns/native.ts";

/** Only a direct registerOTel configuration with its automatic processors proves a second path. */
export const secondExporterLine = async (
  source: string,
  environment: TraceEnvironment
): Promise<number | null> => {
  if (!source.includes("traceExporter")) return null;
  const napi = await loadAstGrep();
  const root = napi.parse(napi.Lang.TypeScript, source).root();
  const names = registerNames(root);

  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    if (!names.has(call.field("function")?.text() ?? "")) continue;

    const config = call
      .field("arguments")
      ?.children()
      .find((child) => child.kind() === "object");

    if (
      config === undefined ||
      config.children().some((child) => child.kind() === "spread_element")
    )
      continue;
    const pairs = config.children().filter((child) => child.kind() === "pair");

    const exporter = pairs.find(
      (pair) => pair.field("key")?.text().replace(/['"]/g, "") === "traceExporter"
    );

    if (exporter === undefined || !separateDestination(exporter.field("value"), environment))
      continue;

    const processors = pairs.find(
      (pair) => pair.field("key")?.text().replace(/['"]/g, "") === "spanProcessors"
    );

    if (!automaticProcessors(processors?.field("value"))) continue;

    return exporter.range().start.line + 1;
  }

  return null;
};

const registerNames = (root: SgNode) => {
  const names = new Set<string>();

  for (const declaration of root.findAll({ rule: { kind: "import_statement" } })) {
    if (!/^['"]@vercel\/otel['"]$/.test(declaration.field("source")?.text() ?? "")) continue;

    for (const imported of declaration.findAll({ rule: { kind: "import_specifier" } })) {
      if (imported.field("name")?.text() === "registerOTel")
        names.add(imported.field("alias")?.text() ?? "registerOTel");
    }
  }

  return names;
};

const automaticProcessors = (value: SgNode | null | undefined) => {
  if (value == null || ["undefined", "null"].includes(value.text())) return true;

  return (
    value.kind() === "array" &&
    value.children().some((child) => ['"auto"', "'auto'"].includes(child.text()))
  );
};

const separateDestination = (value: SgNode | null, environment: TraceEnvironment) => {
  if (value?.kind() !== "new_expression") return false;

  const options = value
    .field("arguments")
    ?.children()
    .find((node) => node.kind() === "object");

  if (options === undefined || options.children().some((node) => node.kind() === "spread_element"))
    return false;

  const url = options
    .children()
    .find(
      (node) => node.kind() === "pair" && node.field("key")?.text().replace(/['"]/g, "") === "url"
    )
    ?.field("value")
    ?.text();

  if (url === undefined || url.includes("OTEL_EXPORTER_OTLP")) return false;
  const variable = /^process\.env\.([A-Z_][A-Z0-9_]*)$/.exec(url);
  const literal = /^['"]([^'"\\]+)['"]$/.exec(url)?.[1];
  const destination = variable === null ? literal : environment[variable[1]!];

  if (destination === undefined) return false;

  try {
    const parsed = new URL(destination);

    return (
      ["http:", "https:"].includes(parsed.protocol) && !/\/otlp\/[a-f0-9]{64}/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
};
