#!/usr/bin/env bun
/**
 * Licences of the Simulator's tools (expo-device-hub, agent-device and their npm dependencies),
 * which the Daemon installs on demand from `apps/daemon/src/install/simulator/bun.lock.txt`.
 *
 *   bun scripts/simulatorLicenses.ts audit   re-audit them into scripts/simulator-licenses.json
 *
 * `audit` installs the pinned set for every OS and CPU and records each package's declared licence
 * and its licence and NOTICE files, plus those vendored inside expo-device-hub. `licenses.ts
 * --check` judges that file against the allowlist and puts its texts in THIRD_PARTY_NOTICES.md.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Predicate, Schema } from "effect";
import {
  SIMULATOR_TOOLS_LOCKFILE,
  SIMULATOR_TOOLS_MANIFEST,
  SIMULATOR_TOOLS_VERSION,
} from "../apps/daemon/src/install/simulator/pin.ts";

const auditPath = join(import.meta.dir, "simulator-licenses.json");

const LicenseText = Schema.Struct({ file: Schema.String, text: Schema.String });

export const SimulatorPackageLicense = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  /** As the package declares it; null when it declares none. */
  license: Schema.NullOr(Schema.String),
  texts: Schema.Array(LicenseText),
});

export type SimulatorPackageLicense = typeof SimulatorPackageLicense.Type;

export const SimulatorAudit = Schema.Struct({
  tools: Schema.String,
  packages: Schema.Array(SimulatorPackageLicense),
});

export type SimulatorAudit = typeof SimulatorAudit.Type;

export const readSimulatorAudit = (): SimulatorAudit =>
  Schema.decodeUnknownSync(Schema.fromJsonString(SimulatorAudit))(readFileSync(auditPath, "utf8"));

const LockEntries = Schema.Struct({
  packages: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)),
});

/** `name@version` of every package the lockfile pins (bun.lock is JSON with trailing commas). */
export const lockedPackages = (lockfile: string = SIMULATOR_TOOLS_LOCKFILE): Array<string> =>
  Object.values(
    Schema.decodeUnknownSync(Schema.fromJsonString(LockEntries))(
      lockfile.replaceAll(/,(\s*[}\]])/g, "$1")
    ).packages
  )
    .map((entry) => String(entry[0]))
    .sort();

/** Why the audit can't be trusted: it covers another tool set or other packages than the lockfile. */
export const simulatorAuditStale = (
  audit: SimulatorAudit,
  version: string = SIMULATOR_TOOLS_VERSION,
  locked: ReadonlyArray<string> = lockedPackages()
): Array<string> => {
  const audited = new Set(audit.packages.map((p) => `${p.name}@${p.version}`));
  const rerun = "run `bun scripts/simulatorLicenses.ts audit`";

  return [
    ...(audit.tools === version
      ? []
      : [`the audit covers ${audit.tools} but ${version} is pinned: ${rerun}`]),
    ...locked.flatMap((id) => (audited.has(id) ? [] : [`${id} is not audited: ${rerun}`])),
    ...[...audited].flatMap((id) =>
      locked.includes(id) ? [] : [`${id} is no longer pinned: ${rerun}`]
    ),
  ];
};

/** The notices section for the Simulator's tools. */
export const renderSimulatorNotices = (audit: SimulatorAudit): string => {
  const lines = [
    `## The Simulator's tools, ${audit.tools} (downloaded by the Daemon)`,
    "",
    "On a Host that can run Simulators, the Daemon installs these npm packages on first use with `bun install --frozen-lockfile` from a lockfile pinning each tarball's sha512, and runs them unmodified. expo-device-hub vendors serve-sim (forked from EvanBacon/serve-sim) and serve-emu, both Apache-2.0, and LiveKit's WebRTC build (BSD-3-Clause).",
    "",
    "| Package | Version | Licence |",
    "|---|---|---|",
    ...audit.packages.map((p) => `| ${p.name} | ${p.version} | ${p.license ?? "unknown"} |`),
    "",
  ];

  for (const p of audit.packages) {
    lines.push(`### ${p.name}@${p.version}`, "");

    if (p.texts.length === 0)
      lines.push(`Licensed under ${p.license ?? "unknown terms"} (no licence file shipped).`, "");

    for (const { file, text } of p.texts) lines.push(`${file}:`, "", "```text", text, "```", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
};

const LICENSE_OR_NOTICE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

/** Licences inside expo-device-hub's own tree: the vendored servers and the WebRTC framework. */
const VENDORED = new Map([
  [
    "expo-device-hub",
    [
      "vendor/serve-sim/LICENSE",
      "vendor/serve-sim/NOTICE",
      "vendor/serve-emu/LICENSE",
      "vendor/serve-sim/dist/bin/LiveKitWebRTC.framework/Resources/LICENSE.webrtc",
    ],
  ],
]);

const PackageJson = Schema.Struct({
  license: Schema.optional(Schema.Union([Schema.String, Schema.Struct({ type: Schema.String })])),
});

const declared = (dir: string): string | null => {
  const { license } = Schema.decodeUnknownSync(Schema.fromJsonString(PackageJson))(
    readFileSync(join(dir, "package.json"), "utf8")
  );

  if (license === undefined) return null;

  return Predicate.isString(license) ? license : license.type;
};

const auditPackage = (modules: string, id: string): SimulatorPackageLicense => {
  const at = id.lastIndexOf("@");
  const name = id.slice(0, at);
  const dir = join(modules, name);

  if (!existsSync(dir)) throw new Error(`${id} was not installed`);

  const files = [
    ...readdirSync(dir)
      .filter((file) => LICENSE_OR_NOTICE.test(file))
      .sort(),
    ...(VENDORED.get(name) ?? []),
  ];

  return {
    name,
    version: id.slice(at + 1),
    license: declared(dir),
    texts: files.map((file) => ({ file, text: readFileSync(join(dir, file), "utf8").trim() })),
  };
};

const audit = async () => {
  const dir = mkdtempSync(join(tmpdir(), "polaris-simulator-audit-"));

  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify(SIMULATOR_TOOLS_MANIFEST));
    writeFileSync(join(dir, "bun.lock"), SIMULATOR_TOOLS_LOCKFILE);

    const proc = Bun.spawn(
      [
        process.execPath,
        "install",
        "--frozen-lockfile",
        "--production",
        "--ignore-scripts",
        "--linker=hoisted",
        "--os=*",
        "--cpu=*",
      ],
      { cwd: dir, stdout: "inherit", stderr: "inherit" }
    );

    if ((await proc.exited) !== 0) throw new Error("bun install failed");
    const packages = lockedPackages().map((id) => auditPackage(join(dir, "node_modules"), id));
    writeFileSync(
      auditPath,
      `${JSON.stringify({ tools: SIMULATOR_TOOLS_VERSION, packages } satisfies SimulatorAudit, null, 2)}\n`
    );
    console.log(`Wrote ${auditPath} (${packages.length} packages)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  if (process.argv[2] !== "audit") {
    console.error("usage: bun scripts/simulatorLicenses.ts audit");
    process.exit(2);
  }

  await audit();
}
