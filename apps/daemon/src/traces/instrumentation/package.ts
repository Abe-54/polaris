import { lstat, realpath } from "node:fs/promises";
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

  if (Option.isNone(parsed)) return { name: null, dependencies: [], valid: false };
  const value = parsed.value;

  return {
    valid: true,
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
  name === "@vercel/otel" ||
  name.startsWith("@opentelemetry/sdk-trace-") ||
  name === "@opentelemetry/sdk-trace";

/** Include ancestor manifests within the checkout for monorepos with a hoisted SDK. */
export const launchPackages = async (checkout: string, cwd: string) => {
  const root = await realpath(checkout).catch(() => resolve(checkout));
  let current = await realpath(cwd).catch(() => resolve(cwd));
  const packages: ReturnType<typeof packageInfo>[] = [];

  if (!contains(root, current)) return packages;

  for (;;) {
    const file = join(current, "package.json");
    const source = await readCheckoutFile(root, relative(root, file));

    const exists = await lstat(file).then(
      () => true,
      () => false
    );

    const info = packageInfo(source);
    packages.push(source === "" && !exists ? { ...info, valid: true } : info);

    if (current === root) break;
    current = dirname(current);
  }

  return packages;
};
