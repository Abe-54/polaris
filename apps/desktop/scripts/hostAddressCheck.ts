#!/usr/bin/env bun
/**
 * Host addresses on a real remote Host (ENG-614): loads each URL in a Workspace's Browser
 * partition through the Host's connection and prints origin, title and text, then edits a
 * Vite page's source on the Host and checks HMR applies it without a reload.
 *
 *   bun scripts/hostAddressCheck.ts <alias> --remote-command "<line>" [--hmr <url> <file> <from> <to>] <url>…
 *
 * The remote command picks the Daemon, e.g. a dev build in its own home:
 * `env POLARIS_HOME=/tmp/ph /tmp/ph/polaris bridge`. Uses ~/.ssh/config read only.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR, stockElectronBinary } from "./lib/electron.ts";

const args = process.argv.slice(2);

const take = (flag: string, count: number) => {
  const at = args.indexOf(flag);

  return at === -1 ? null : args.splice(at, count + 1).slice(1);
};

const remoteCommand = take("--remote-command", 1)?.[0];

const hmr = take("--hmr", 4);

const [alias, ...urls] = args;

if (alias === undefined || remoteCommand === undefined) {
  console.error(
    'usage: bun scripts/hostAddressCheck.ts <alias> --remote-command "<line>" [--hmr <url> <file> <from> <to>] <url>…'
  );
  process.exit(2);
}

const out = mkdtempSync(join(tmpdir(), "polaris-host-address-"));

const built = await Bun.build({
  entrypoints: [join(APP_DIR, "scripts/lib/hostAddressCheckApp.ts")],
  outdir: out,
  target: "node",
  format: "esm",
  external: ["electron", "koffi"],
});

if (!built.success) throw new AggregateError(built.logs, "build failed");

writeFileSync(
  join(out, "package.json"),
  JSON.stringify({ main: "hostAddressCheckApp.js", type: "module" })
);

const run = spawnSync(stockElectronBinary(), [out, "--use-mock-keychain"], {
  stdio: "inherit",
  env: {
    ...process.env,
    POLARIS_HOST_ADDRESS_CHECK: JSON.stringify({
      alias,
      remoteCommand,
      urls,
      hmr: hmr === null ? null : { url: hmr[0], file: hmr[1], from: hmr[2], to: hmr[3] },
    }),
  },
});

process.exit(run.status ?? 1);
