import { dirname, join, relative, resolve } from "node:path";
import { Option, Schema } from "effect";
import { contains, readCheckoutFile } from "./read.ts";

const Dependencies = Schema.Record(Schema.String, Schema.String);

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      dependencies: Schema.optional(Dependencies),
      devDependencies: Schema.optional(Dependencies),
      optionalDependencies: Schema.optional(Dependencies),
      peerDependencies: Schema.optional(Dependencies),
    })
  )
);

export const packageInfo = (source: string) => {
  const parsed = decode(source);

  if (Option.isNone(parsed)) return { name: null, dependencies: [] };
  const value = parsed.value;

  return {
    name: value.name ?? null,
    dependencies: Object.keys({
      ...value.dependencies,
      ...value.devDependencies,
      ...value.optionalDependencies,
      ...value.peerDependencies,
    }),
  };
};

export const isNodeSdk = (name: string) =>
  name === "@opentelemetry/sdk-node" ||
  name.startsWith("@opentelemetry/sdk-trace-") ||
  name === "@opentelemetry/sdk-trace";

/** Include ancestor manifests within the checkout for monorepos with a hoisted SDK. */
export const launchPackages = async (checkout: string, cwd: string) => {
  const root = resolve(checkout);
  let current = resolve(cwd);
  const packages: ReturnType<typeof packageInfo>[] = [];

  if (!contains(root, current)) return packages;

  for (;;) {
    packages.push(
      packageInfo(await readCheckoutFile(root, relative(root, join(current, "package.json"))))
    );

    if (current === root) break;
    current = dirname(current);
  }

  return packages;
};
