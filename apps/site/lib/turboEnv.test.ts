import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

/**
 * Turborepo's strict env mode hides undeclared variables from `@polaris/site#build`, and Vercel
 * only warns after deploy (ENG-277). Every env read under apps/site must be declared in turbo.json.
 */
const SITE = join(import.meta.dir, "..");

const TURBO = join(SITE, "../../turbo.json");

/** Vercel's own variables and NODE_ENV; Next.js's `NEXT_PUBLIC_*` is turbo's framework inference. */
const ALLOWED = ["NODE_ENV", "VERCEL", "VERCEL_*", "NEXT_PUBLIC_*"];

/** Dev and smoke scripts run outside the turbo build; tests set their own env. */
const SKIPPED = /^(node_modules|\.next|scripts)\/|\.test\.tsx?$/;

const Names = Schema.optional(Schema.Array(Schema.String));

const TaskEnv = Schema.Struct({ env: Names, passThroughEnv: Names });

const Turbo = Schema.Struct({
  globalEnv: Names,
  globalPassThroughEnv: Names,
  tasks: Schema.Struct({ "@polaris/site#build": TaskEnv }),
});

const decodeTurbo = Schema.decodeUnknownSync(Schema.fromJsonString(Turbo));

/** `process.env.X`, `env.X`, `env?.X` and `env["X"]` reads in `source`. */
const envReads = (source: string): ReadonlyArray<string> =>
  Array.from(
    source.matchAll(/\benv(?:\?\.|\.|\[["'])([A-Z][A-Z0-9_]*)\b/g),
    ([, name]) => name
  ).filter((name) => name !== undefined);

/** Turbo's patterns: `*` is a wildcard, a leading `!` excludes. */
const matcher = (patterns: ReadonlyArray<string>) => {
  const toRegex = (pattern: string) =>
    new RegExp(`^${pattern.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);

  const include = patterns.flatMap((p) => (p.startsWith("!") ? [] : [toRegex(p)]));
  const exclude = patterns.flatMap((p) => (p.startsWith("!") ? [toRegex(p.slice(1))] : []));

  return (name: string) => include.some((r) => r.test(name)) && !exclude.some((r) => r.test(name));
};

const declared = () => {
  const turbo = decodeTurbo(readFileSync(TURBO, "utf8"));
  const site = turbo.tasks["@polaris/site#build"];

  return matcher([
    ...ALLOWED,
    ...(turbo.globalEnv ?? []),
    ...(turbo.globalPassThroughEnv ?? []),
    ...(site.env ?? []),
    ...(site.passThroughEnv ?? []),
  ]);
};

const siteReads = () => {
  const reads = new Map<string, string>();

  for (const file of new Bun.Glob("**/*.{ts,tsx,mts,js,mjs}").scanSync(SITE)) {
    if (SKIPPED.test(file)) continue;

    for (const name of envReads(readFileSync(join(SITE, file), "utf8"))) {
      if (!reads.has(name)) reads.set(name, file);
    }
  }

  return reads;
};

describe("turbo.json declares the site's env", () => {
  test("finds process.env, env, optional and bracket reads", () => {
    const source = `process.env.A_1; env?.B; env["C"]; env.lower; myenv.D; ENV.E`;

    expect(envReads(source)).toEqual(["A_1", "B", "C"]);
  });

  test("every env var apps/site reads is in @polaris/site#build's env or passThroughEnv", () => {
    const isDeclared = declared();

    const missing = [...siteReads()].flatMap(([name, file]) =>
      isDeclared(name) ? [] : [`${name} (read in apps/site/${file})`]
    );

    expect(missing).toEqual([]);
  });
});
