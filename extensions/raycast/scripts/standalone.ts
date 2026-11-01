/**
 * Writes the extension as a project that installs outside this repository: the
 * sources without tests, `@polaris/sdk` from npm, and a tsconfig of its own.
 * The Release attaches it zipped (ENG-456).
 *
 *   bun extensions/raycast/scripts/standalone.ts <out dir>
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Schema } from "effect";

const EXTENSION = resolve(import.meta.dir, "..");

const REPO = resolve(EXTENSION, "..", "..");

/** The npm name of `@polaris/sdk`; imports keep the workspace name through an alias. */
const SDK_ON_NPM = "@doellsoftware/polaris-sdk";

const Packages = Schema.Struct({
  dependencies: Schema.Record(Schema.String, Schema.String),
  devDependencies: Schema.Record(Schema.String, Schema.String),
});

/** Replaces workspace packages with npm versions, or a local SDK tarball for validation. */
export const standaloneManifest = (
  manifest: Schema.JsonObject,
  sdkVersion: string,
  sdkTarball?: string
): Schema.JsonObject => {
  const { private: _private, ...rest } = manifest;
  const packages = Schema.decodeUnknownSync(Packages)(manifest);

  return {
    ...rest,
    dependencies: {
      ...packages.dependencies,
      "@polaris/sdk":
        sdkTarball === undefined ? `npm:${SDK_ON_NPM}@${sdkVersion}` : resolve(sdkTarball),
    },
    devDependencies: {
      "@types/node": "22.15.3",
      "@types/react": packages.devDependencies["@types/react"] ?? "19.0.10",
      typescript: "5.8.3",
    },
    scripts: { dev: "ray develop", build: "ray build -e dist -o dist" },
  };
};

const TSCONFIG = {
  compilerOptions: {
    target: "ES2023",
    lib: ["ES2023"],
    module: "Preserve",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    types: ["node"],
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  },
  include: ["src", "raycast-env.d.ts"],
};

const INSTALL = `## Install from the release

Unzip it, then in its folder:

\`\`\`sh
npm install
npm run dev   # loads Polaris into Raycast; it stays after you stop this
\`\`\`

`;

/** The README with how to install it, the SDK linked on npm, and no monorepo Develop section. */
export const standaloneReadme = (readme: string) =>
  readme
    .replace("\n## Pair it", `\n${INSTALL}## Pair it`)
    .replace("(../../packages/sdk)", `(https://www.npmjs.com/package/${SDK_ON_NPM})`)
    .replace(/\n## Develop\n[\s\S]*$/, "\n");

const isShipped = (path: string) => !path.endsWith(".test.ts") && !path.endsWith(".testing.ts");

const readManifest = (path: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(readFileSync(path, "utf8"));

/** Writes the standalone project into `target`, replacing what is there. */
export const writeStandalone = (target: string, sdkTarball?: string) => {
  const manifest = readManifest(join(EXTENSION, "package.json"));

  const sdk = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
    readManifest(join(REPO, "packages", "sdk", "package.json"))
  );

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(EXTENSION, "src"), join(target, "src"), { recursive: true, filter: isShipped });
  cpSync(join(EXTENSION, "assets"), join(target, "assets"), { recursive: true });

  writeFileSync(
    join(target, "README.md"),
    standaloneReadme(readFileSync(join(EXTENSION, "README.md"), "utf8"))
  );
  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify(standaloneManifest(manifest, sdk.version, sdkTarball), null, 2)}\n`
  );
  writeFileSync(join(target, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
};

if (import.meta.main) {
  const out = process.argv[2];

  if (out === undefined) {
    console.error("usage: bun scripts/standalone.ts <out dir>");
    process.exit(1);
  }

  writeStandalone(resolve(out));
  console.log(resolve(out));
}
