import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import type { Violation } from "./baseline.ts";

export const ROOT = resolve(import.meta.dir, "../..");

/** Files oxlint lints; everything else passed on the command line is skipped. */
export const LINTABLE = /\.[cm]?[jt]sx?$/;

const Span = Schema.Struct({ line: Schema.Number, column: Schema.Number });

const Diagnostic = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.String,
  filename: Schema.String,
  labels: Schema.optional(Schema.Array(Schema.Struct({ span: Span }))),
});

const Report = Schema.Struct({ diagnostics: Schema.Array(Diagnostic) });

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(Report));

/** `anti-slop(no-object-parameters)` → `anti-slop/no-object-parameters`; core rules drop `eslint`. */
export const ruleName = (code: string | undefined): string => {
  const match = /^([\w-]+)\((.+)\)$/.exec(code ?? "");

  if (match === null) return code === undefined || code === "" ? "oxlint/diagnostic" : code;

  const [, plugin, rule] = match;

  return plugin === "eslint" ? `${rule}` : `${plugin}/${rule}`;
};

/** Repo paths use `/` on every OS, as the baseline records them. */
export const toPosix = (path: string): string => path.replaceAll("\\", "/");

export class OxlintFailed extends Schema.TaggedError<OxlintFailed>()("OxlintFailed", {
  output: Schema.String,
}) {}

/**
 * Runs oxlint from the repo root (so every workspace's nested `.oxlintrc.json`
 * applies) over `files`, or the whole repo when `files` is empty. `--fix` applies safe fixes first.
 */
export const runOxlint = (
  files: ReadonlyArray<string>,
  flags: ReadonlyArray<"--fix"> = []
): ReadonlyArray<Violation> => {
  // The package's Node entry, not `.bin/oxlint`: Windows has only shims there.
  const bin = join(ROOT, "node_modules/oxlint/bin/oxlint");

  if (!existsSync(bin)) {
    throw new OxlintFailed({ output: `oxlint isn't installed at ${bin}. Run bun install first.` });
  }

  const run = Bun.spawnSync(
    ["node", bin, ...flags, "--format", "json", "--no-error-on-unmatched-pattern", ...files],
    {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: "0" },
    }
  );

  const stdout = run.stdout.toString();

  try {
    return decodeReport(stdout).diagnostics.map((d) => ({
      file: toPosix(d.filename),
      rule: ruleName(d.code),
      line: d.labels?.[0]?.span.line ?? 0,
      column: d.labels?.[0]?.span.column ?? 0,
      message: d.message,
    }));
  } catch {
    throw new OxlintFailed({ output: `${stdout}\n${run.stderr.toString()}`.trim() });
  }
};
