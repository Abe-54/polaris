import { childEnv } from "../service/childEnv.ts";
import { stripNodeInstrumentation } from "../traces/nodeOptions.ts";

/** Instrument application launches, never Harnesses or the MCP servers they spawn. */
export const harnessEnv = (source: Readonly<Record<string, string | undefined>> = process.env) => {
  const env = { ...childEnv(source) };

  for (const [key, value] of Object.entries(env)) {
    // Windows environment names are case-insensitive, including inherited Node options.
    const name = key.toUpperCase();

    if (name.startsWith("POLARIS_OTEL_")) delete env[key];
    else if (name === "NODE_OPTIONS" && value !== undefined) {
      const options = stripNodeInstrumentation(value);

      if (options.trim() === "") delete env[key];
      else env[key] = options;
    }
  }

  return env;
};
