import { pathToFileURL } from "node:url";
import type { WorkspaceTracesSettings } from "@polaris/protocol";
import type { TraceEnvironment } from "../runtime.ts";
import { bundledRegisterPath } from "./assets.ts";
import { isNodeSdk, launchPackages } from "./package.ts";

export interface AutoInstrumentationOptions {
  readonly checkout: string;
  readonly cwd: string;
  readonly settings: Pick<
    WorkspaceTracesSettings,
    "enabled" | "autoInstrument" | "autoInstrumentOverride"
  >;
  readonly source: TraceEnvironment;
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

  if (!settings.enabled || settings.autoInstrument === "off")
    return { environment: {}, skipReason: null };

  if (options.runtime === "bun")
    return { environment: {}, skipReason: "Bun does not support Node auto-instrumentation." };

  if (!source.OTEL_EXPORTER_OTLP_ENDPOINT)
    return { environment: {}, skipReason: "The trace receiver is unavailable." };

  if (settings.autoInstrument === "deno")
    return { environment: { OTEL_DENO: "true" }, skipReason: null };
  const packages = await launchPackages(options.checkout, options.cwd);
  const sdk = packages.flatMap((info) => info.dependencies).find(isNodeSdk);

  if (sdk && !settings.autoInstrumentOverride)
    return {
      environment: {},
      skipReason: `The project depends on ${sdk}; its SDK owns instrumentation.`,
    };

  try {
    const path = options.registerPath ?? (await bundledRegisterPath());
    const preload = `--import ${JSON.stringify(pathToFileURL(path).href)}`;

    return {
      environment: {
        NODE_OPTIONS: `${preload}${source.NODE_OPTIONS ? ` ${source.NODE_OPTIONS}` : ""}`,
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
