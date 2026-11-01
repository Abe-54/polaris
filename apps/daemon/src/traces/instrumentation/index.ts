import type { WorkspaceTracesSettings } from "@polaris/protocol";
import type { TraceEnvironment } from "../runtime.ts";
import { bundledRegisterPath } from "./assets.ts";
import { isNodeSdk, launchPackages } from "./package.ts";
import { appendNodeImport } from "../nodeOptions.ts";

export interface AutoInstrumentationOptions {
  readonly checkout: string;
  readonly cwd: string;
  readonly settings: Pick<
    WorkspaceTracesSettings,
    "enabled" | "autoInstrument" | "autoInstrumentOverride"
  >;
  readonly source: TraceEnvironment;
  readonly home?: string | undefined;
  readonly registerPath?: string;
  readonly runtime?: "node" | "deno" | "bun";
}

export interface AutoInstrumentationResult {
  readonly environment: Record<string, string>;
  readonly skipReason: string | null;
}

/** Called only for a trusted launch, after endpoint injection; never scans or loads an SDK while idle. */
export const prepareAutoInstrumentation = async (
  options: AutoInstrumentationOptions
): Promise<AutoInstrumentationResult> => {
  const { settings, source } = options;

  if (settings.autoInstrument === "off") return { environment: {}, skipReason: null };

  if (options.runtime === "bun")
    return { environment: {}, skipReason: "Automatic instrumentation is unavailable for Bun." };

  if (!source.OTEL_EXPORTER_OTLP_ENDPOINT)
    return { environment: {}, skipReason: "The trace receiver is unavailable." };

  if (settings.autoInstrument === "deno")
    return { environment: { OTEL_DENO: "true" }, skipReason: null };
  const packages = await launchPackages(options.checkout, options.cwd);

  if (packages.length === 0)
    return { environment: {}, skipReason: "The launch directory is outside this checkout." };

  if (packages.some((info) => !info.valid) && !settings.autoInstrumentOverride)
    return {
      environment: {},
      skipReason: "package.json could not be checked for an existing OpenTelemetry SDK.",
    };
  const sdk = packages.flatMap((info) => info.dependencies).find(isNodeSdk);

  if (sdk && !settings.autoInstrumentOverride)
    return {
      environment: {},
      skipReason: `The project depends on ${sdk}; its SDK owns instrumentation.`,
    };

  try {
    const path = options.registerPath ?? (await bundledRegisterPath(options.home));
    const appended = appendNodeImport(source.NODE_OPTIONS, path);
    const preload = appendNodeImport(undefined, path);

    return {
      environment: {
        NODE_OPTIONS:
          appended === source.NODE_OPTIONS
            ? appended
            : `${preload}${source.NODE_OPTIONS ? ` ${source.NODE_OPTIONS}` : ""}`,
        POLARIS_OTEL_ENDPOINT: source.OTEL_EXPORTER_OTLP_ENDPOINT,
        POLARIS_OTEL_SERVICE_NAME: packages.find((info) => info.name)?.name ?? "node-app",
      },
      skipReason: null,
    };
  } catch {
    return {
      environment: {},
      skipReason: "The bundled Node instrumentation could not be prepared.",
    };
  }
};

export const autoInstrumentationEnvironment = async (options: AutoInstrumentationOptions) =>
  (await prepareAutoInstrumentation(options)).environment;
