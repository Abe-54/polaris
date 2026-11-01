import type { BunPlugin } from "bun";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface InstrumentationAssets {
  [file: string]: string;
}

/** SDK and loader are bundled separately for Node; neither executes inside the Daemon. */
export const buildInstrumentationAssets = async (): Promise<InstrumentationAssets> => {
  const require = createRequire(import.meta.url);
  const hook = require.resolve("@opentelemetry/instrumentation/hook.mjs");
  const middle = createRequire(hook).resolve("import-in-the-middle");

  const entries = [
    ["sdk.cjs", join(import.meta.dir, "sdk.ts"), "cjs"],
    ["hook.mjs", hook, "esm"],
  ] as const;

  const assets: InstrumentationAssets = {
    "register.mjs": await readFile(join(import.meta.dir, "register.mjs"), "utf8"),
    "lib/register.js": await readFile(join(dirname(middle), "lib/register.js"), "utf8"),
    "lib/package.json": '{"type":"commonjs"}',
  };

  for (const [name, entry, format] of entries) {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "node",
      format,
      minify: true,
      conditions: ["node", "require"],
      plugins: [
        {
          name: "shared-esm-registry",
          setup(builder) {
            builder.onResolve({ filter: /lib\/register(?:\.js)?$/ }, (args) =>
              args.importer.includes("import-in-the-middle")
                ? { path: "./lib/register.js", external: true }
                : undefined
            );
          },
        },
      ],
    });

    if (!result.success || result.outputs.length !== 1)
      throw new Error(`Cannot bundle ${name}: ${result.logs.map((log) => log.message).join("\n")}`);
    assets[name] = await result.outputs[0]!.text();
  }

  return assets;
};

export const instrumentationPlugin = async (): Promise<BunPlugin> => {
  const assets = await buildInstrumentationAssets();

  return {
    name: "polaris-node-instrumentation",
    setup(builder) {
      builder.onLoad({ filter: /traces\/instrumentation\/embedded\.ts$/ }, () => ({
        contents: `export const embeddedInstrumentation = ${JSON.stringify(assets)};`,
        loader: "js",
      }));
    },
  };
};
