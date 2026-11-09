#!/usr/bin/env bun
/**
 * `oxlint --fix` over the given files with the repo's configs and plugins: applies the
 * safe fixes and leaves what remains to the ratchet, so it fails only when oxlint can't run.
 *
 *   bun tooling/quality/lint-fix.ts <files…>
 */
import { LINTABLE, OxlintFailed, runOxlint } from "../lint/oxlint.ts";

const files = process.argv.slice(2).filter((file) => LINTABLE.test(file));

try {
  if (files.length > 0) runOxlint(files, ["--fix"]);
} catch (error) {
  if (!(error instanceof OxlintFailed)) throw error;
  console.error(error.output);
  process.exit(1);
}
