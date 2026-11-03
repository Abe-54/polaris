#!/usr/bin/env bun
/**
 * Licence gate and third-party notices.
 *
 *   bun scripts/licenses.ts           regenerate THIRD_PARTY_NOTICES.md
 *   bun scripts/licenses.ts --check   fail on a disallowed licence or stale notices
 *
 * Walks the installed production dependency tree (`dependencies`,
 * `optionalDependencies` and `peerDependencies`, transitively) of every workspace package (apps/*,
 * packages/*), reads each package's declared licence, and enforces the
 * allowlist below. Anything else, including an unknown or missing licence,
 * fails unless `scripts/license-exceptions.json` lists the package with a
 * reason. Notices include each package's licence text and any upstream
 * NOTICE file verbatim (Apache-2.0 §4d).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Match, Schema } from "effect";
import { BETTERLEAKS_VERSION } from "../apps/daemon/src/rules/secrets/pin.ts";
import { auditProblems, GoAudit, renderGoNotices } from "./goLicenses.ts";
import {
  readSimulatorAudit,
  renderSimulatorNotices,
  simulatorAuditStale,
} from "./simulatorLicenses.ts";

export const ALLOWED = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "OFL-1.1",
  "MPL-2.0",
]);

const root = join(import.meta.dir, "..");

const noticesPath = join(root, "THIRD_PARTY_NOTICES.md");

const LIBSODIUM = {
  name: "libsodium",
  version: "1.0.21",
  license: "ISC",
  shippedBy:
    "The Android and iOS builds of the Mobile App link it statically. Android uses the pinned tarball in `apps/mobile/modules/polaris-sodium/android/CMakeLists.txt`.",
};

const exceptionsPath = join(import.meta.dir, "license-exceptions.json");

/** The licence audit of the Go modules inside the shipped Betterleaks binary (`scripts/betterleaks.ts`). */
const goAuditPath = join(import.meta.dir, "betterleaks-licenses.json");

const LicenseObject = Schema.Struct({ type: Schema.optional(Schema.String) });

const StringMap = Schema.Record(Schema.String, Schema.String);

const StringList = Schema.Array(Schema.String);

const PackageJson = Schema.Struct({
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  private: Schema.optional(Schema.Boolean),
  license: Schema.optional(Schema.Union([Schema.String, LicenseObject])),
  licenses: Schema.optional(Schema.Array(LicenseObject)),
  repository: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ url: Schema.optional(Schema.String) })])
  ),
  homepage: Schema.optional(Schema.String),
  workspaces: Schema.optional(
    Schema.Union([StringList, Schema.Struct({ packages: Schema.optional(StringList) })])
  ),
  dependencies: Schema.optional(StringMap),
  optionalDependencies: Schema.optional(StringMap),
  peerDependencies: Schema.optional(StringMap),
  peerDependenciesMeta: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ optional: Schema.optional(Schema.Boolean) }))
  ),
  os: Schema.optional(StringList),
  cpu: Schema.optional(StringList),
});

type PackageJson = typeof PackageJson.Type;

export interface Dependency {
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly dir: string;
  readonly repository: string | null;
  /** Workspace packages that (transitively) pull this in. */
  readonly requiredBy: Set<string>;
  /**
   * Optional per-platform builds published with this package (`name@spec`,
   * from its own package.json, so the list does not depend on which ones
   * this machine installed).
   */
  readonly platformBuilds: Array<string>;
}

const decodePackageJson = Schema.decodeUnknownSync(Schema.fromJsonString(PackageJson));

const readPackageJson = (path: string): PackageJson =>
  decodePackageJson(readFileSync(path, "utf8"));

const licenseField = Match.type<NonNullable<PackageJson["license"]>>().pipe(
  Match.when(Match.string, (license): string | null => license),
  Match.orElse((license) => license.type || null)
);

/** The declared licence as an SPDX expression, or null if none is declared. */
export const declaredLicense = (pkg: PackageJson): string | null => {
  const direct = pkg.license === undefined ? null : licenseField(pkg.license);

  if (direct !== null) return direct;
  const legacy = pkg.licenses?.flatMap((entry) => (entry.type ? [entry.type] : [])) ?? [];

  if (legacy.length === 1) return legacy[0]!;

  if (legacy.length > 1) return `(${legacy.join(" OR ")})`;

  return null;
};

/**
 * Whether an SPDX expression is satisfied by the allowlist: `A OR B` needs
 * one side, `A AND B` needs both, `A WITH exception` is judged by `A`.
 * Anything unparseable (e.g. `SEE LICENSE IN …`) is not allowed.
 */
export const isAllowed = (expression: string, allowed: ReadonlySet<string> = ALLOWED): boolean => {
  // SPDX ids are case-insensitive ("apache-2.0" is Apache-2.0).
  const known = new Set([...allowed].map((id) => id.toLowerCase()));
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];

  const orExpr = (): boolean => {
    let value = andExpr();

    while (peek()?.toUpperCase() === "OR") {
      position++;
      const right = andExpr();
      value = value || right;
    }

    return value;
  };

  const andExpr = (): boolean => {
    let value = atom();

    while (peek()?.toUpperCase() === "AND") {
      position++;
      const right = atom();
      value = value && right;
    }

    return value;
  };

  const atom = (): boolean => {
    const token = tokens[position++];

    if (token === undefined) throw new Error("unexpected end");

    if (token === "(") {
      const value = orExpr();

      if (tokens[position++] !== ")") throw new Error("expected )");

      return value;
    }

    if (peek()?.toUpperCase() === "WITH") position += 2;

    return known.has(token.replace(/\+$/, "").toLowerCase());
  };

  try {
    const value = orExpr();

    return position === tokens.length && value;
  } catch {
    return false;
  }
};

const workspacePatterns = Match.type<NonNullable<PackageJson["workspaces"]>>().pipe(
  Match.when(Schema.is(StringList), (patterns): ReadonlyArray<string> => patterns),
  Match.orElse((workspaces) => workspaces.packages ?? [])
);

const workspaceDirs = (): ReadonlyArray<string> => {
  const { workspaces } = readPackageJson(join(root, "package.json"));
  const patterns = workspaces === undefined ? [] : workspacePatterns(workspaces);

  return patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [join(root, pattern)];
    const parent = join(root, pattern.slice(0, -2));

    if (!existsSync(parent)) return [];

    return readdirSync(parent)
      .map((name) => join(parent, name))
      .filter((dir) => existsSync(join(dir, "package.json")));
  });
};

/** Node's lookup: `<dir>/node_modules/<name>`, walking up from the requiring package's real path. */
const resolvePackageDir = (fromDir: string, name: string): string | null => {
  let dir = realpathSync(fromDir);

  for (;;) {
    const candidate = join(dir, "node_modules", name);

    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);

    if (parent === dir) return null;
    dir = parent;
  }
};

const repositoryField = Match.type<NonNullable<PackageJson["repository"]>>().pipe(
  Match.when(Match.string, (repository): string | undefined => repository),
  Match.orElse((repository) => repository.url)
);

const repositoryUrl = (pkg: PackageJson): string | null => {
  const repo = pkg.repository === undefined ? undefined : repositoryField(pkg.repository);
  const url = repo ?? pkg.homepage ?? null;

  return url?.replace(/^git\+/, "").replace(/\.git$/, "") ?? null;
};

export interface Collected {
  readonly deps: Map<string, Dependency>;
  /** Installed per-platform builds: judged, but listed only under their parent. */
  readonly platformBuilds: Map<string, Dependency>;
  readonly missing: Array<string>;
}

const toDependency = (child: PackageJson, name: string, dir: string, workspace: string) => ({
  name: child.name ?? name,
  version: child.version ?? "0.0.0",
  license: declaredLicense(child),
  dir,
  repository: repositoryUrl(child),
  requiredBy: new Set([workspace]),
  platformBuilds: [],
});

/** An installed package: its real directory and its parsed package.json. */
interface Installed {
  readonly dir: string;
  readonly child: PackageJson;
}

const locate = (fromDir: string, name: string): Installed | null => {
  const dir = resolvePackageDir(fromDir, name);

  return dir === null ? null : { dir, child: readPackageJson(join(dir, "package.json")) };
};

// Peers are runtime dependencies too (Bun installs them); optional peers only if present.
const dependencyNames = (pkg: PackageJson): ReadonlyArray<string> => [
  ...new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]),
];

const optionalPeerNames = (pkg: PackageJson): ReadonlySet<string> =>
  new Set(
    Object.keys(pkg.peerDependencies ?? {}).filter(
      (name) => pkg.peerDependenciesMeta?.[name]?.optional === true
    )
  );

// An optional dependency that is absent, or restricted by os/cpu, is a
// per-platform build (native binaries); which ones are installed varies by machine.
const isPlatformBuild = (found: Installed | null): boolean =>
  found === null || found.child.os !== undefined || found.child.cpu !== undefined;

export const collect = (): Collected => {
  const deps = new Map<string, Dependency>();
  const platformBuilds = new Map<string, Dependency>();
  const missing: Array<string> = [];

  const workspaces = workspaceDirs().map((dir) => ({
    dir,
    pkg: readPackageJson(join(dir, "package.json")),
  }));

  const workspaceNames = new Set(workspaces.map((w) => w.pkg.name));

  const addPlatformBuild = (
    parent: Dependency | null,
    name: string,
    variant: string,
    found: Installed | null,
    workspace: string
  ) => {
    if (parent && !parent.platformBuilds.includes(variant)) parent.platformBuilds.push(variant);

    if (found !== null) {
      const { child, dir } = found;
      platformBuilds.set(
        `${child.name}@${child.version}`,
        toDependency(child, name, dir, workspace)
      );
    }
  };

  /** Records `found` for `workspace`; returns it when its own dependencies still need a visit. */
  const addDependency = (
    found: Installed,
    name: string,
    workspace: string,
    seen: Set<string>
  ): Dependency | null => {
    const key = `${found.child.name}@${found.child.version}`;
    const existing = deps.get(key);

    if (existing) existing.requiredBy.add(workspace);

    if (existing && seen.has(key)) return null;
    const dep = existing ?? toDependency(found.child, name, found.dir, workspace);
    deps.set(key, dep);
    seen.add(key);

    return dep;
  };

  const visit = (
    fromDir: string,
    pkg: PackageJson,
    parent: Dependency | null,
    workspace: string,
    seen: Set<string>
  ) => {
    const optional = pkg.optionalDependencies ?? {};
    const optionalPeers = optionalPeerNames(pkg);

    for (const name of dependencyNames(pkg)) {
      if (workspaceNames.has(name)) continue; // visited as a workspace in its own right
      const found = locate(fromDir, name);

      if (name in optional && isPlatformBuild(found)) {
        addPlatformBuild(parent, name, `${name}@${optional[name]}`, found, workspace);
        continue;
      }

      if (found === null) {
        if (!optionalPeers.has(name)) missing.push(`${name} (required by ${pkg.name})`);
        continue;
      }

      const dep = addDependency(found, name, workspace, seen);

      if (dep !== null) visit(found.dir, found.child, dep, workspace, seen);
    }
  };

  for (const { dir, pkg } of workspaces) visit(dir, pkg, null, pkg.name ?? dir, new Set());

  for (const dep of deps.values()) dep.platformBuilds.sort();

  return { deps, platformBuilds, missing };
};

const Exceptions = Schema.Struct({
  exceptions: Schema.Record(Schema.String, Schema.Struct({ reason: Schema.String })),
});

type Exceptions = typeof Exceptions.Type;

const decodeExceptions = Schema.decodeUnknownSync(Schema.fromJsonString(Exceptions));

const readExceptions = (): Exceptions["exceptions"] =>
  existsSync(exceptionsPath)
    ? decodeExceptions(readFileSync(exceptionsPath, "utf8")).exceptions
    : {};

export interface Verdict {
  readonly dep: Dependency;
  readonly status: "allowed" | "exception" | "violation";
  readonly reason: string | null;
}

export const judge = (
  deps: Iterable<Dependency>,
  exceptions: Exceptions["exceptions"]
): Array<Verdict> =>
  [...deps].map((dep) => {
    if (dep.license !== null && isAllowed(dep.license)) {
      return { dep, status: "allowed", reason: null } as const;
    }

    const exception =
      exceptions[dep.name] ??
      Object.entries(exceptions).find(
        ([pattern]) => pattern.endsWith("*") && dep.name.startsWith(pattern.slice(0, -1))
      )?.[1];

    if (exception) return { dep, status: "exception", reason: exception.reason } as const;

    return { dep, status: "violation", reason: null } as const;
  });

const LICENSE_FILE = /^(licen[cs]e|copying)(\.|-|$)/i;

const NOTICE_FILE = /^notice(\.|$)/i;

const filesMatching = (dir: string, pattern: RegExp): Array<string> =>
  readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8").trim());

const byName = (a: Verdict, b: Verdict) =>
  a.dep.name.localeCompare(b.dep.name) || a.dep.version.localeCompare(b.dep.version);

export const renderNotices = (verdicts: ReadonlyArray<Verdict>): string => {
  const sorted = [...verdicts].sort(byName);

  const lines: Array<string> = [
    "# Third-party notices",
    "",
    "Generated by `bun run licenses` from the installed production dependencies of the Polaris workspace packages. Do not edit by hand.",
    "",
    "| Package | Version | Licence | Source |",
    "|---|---|---|---|",
    ...sorted.map(
      ({ dep, status }) =>
        `| ${dep.name} | ${dep.version} | ${dep.license ?? "unknown"}${status === "exception" ? " (exception)" : ""} | ${dep.repository ?? ""} |`
    ),
    "",
  ];

  const exceptions = sorted.filter((v) => v.status === "exception");

  if (exceptions.length > 0) {
    lines.push("## Licence exceptions", "");

    for (const { dep, reason } of exceptions) lines.push(`- **${dep.name}**: ${reason}`);
    lines.push("");
  }

  lines.push("## Licence texts", "");

  for (const { dep } of sorted) {
    lines.push(`### ${dep.name}@${dep.version}`, "");
    const texts = filesMatching(dep.dir, LICENSE_FILE);

    if (texts.length === 0)
      lines.push(`Licensed under ${dep.license ?? "unknown terms"} (no licence file shipped).`, "");

    for (const text of texts) lines.push("```text", text, "```", "");

    if (dep.platformBuilds.length > 0) {
      lines.push(
        `Per-platform builds published with this package: ${dep.platformBuilds.map((b) => `\`${b}\``).join(", ")}.`,
        ""
      );
    }

    for (const notice of filesMatching(dep.dir, NOTICE_FILE)) {
      lines.push("NOTICE:", "", "```text", notice, "```", "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
};

/** A Simulator tool package as `judge` sees it: installed by the Daemon, not by a workspace. */
const simulatorDependency = (p: {
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
}): Dependency => ({
  ...p,
  dir: "",
  repository: null,
  requiredBy: new Set(["the Simulator's tools"]),
  platformBuilds: [],
});

const main = () => {
  const check = process.argv.includes("--check");
  const { deps, platformBuilds, missing } = collect();
  const exceptions = readExceptions();
  const verdicts = judge(deps.values(), exceptions);

  const violations = [...verdicts, ...judge(platformBuilds.values(), exceptions)].filter(
    (v) => v.status === "violation"
  );

  let failed = false;

  if (missing.length > 0) {
    console.error(`Not installed (run bun install):\n  ${missing.join("\n  ")}`);
    failed = true;
  }

  if (violations.length > 0) {
    console.error(
      `Licences outside the allowlist (${[...ALLOWED].join(", ")}):\n${violations
        .map(
          ({ dep }) =>
            `  ${dep.name}@${dep.version}: ${dep.license ?? "no licence declared"} (via ${[...dep.requiredBy].join(", ")})`
        )
        .join(
          "\n"
        )}\nReplace the dependency or add it to scripts/license-exceptions.json with a reason.`
    );
    failed = true;
  }

  const goAudit = Schema.decodeUnknownSync(Schema.fromJsonString(GoAudit))(
    readFileSync(goAuditPath, "utf8")
  );

  const goProblems = auditProblems(goAudit, BETTERLEAKS_VERSION, (id) => isAllowed(id));

  if (goProblems.length > 0) {
    console.error(`Betterleaks' Go modules:\n  ${goProblems.join("\n  ")}`);
    failed = true;
  }

  const simulatorAudit = readSimulatorAudit();

  const simulatorProblems = [
    ...simulatorAuditStale(simulatorAudit),
    ...judge(simulatorAudit.packages.map(simulatorDependency), exceptions)
      .filter((v) => v.status === "violation")
      .map(({ dep }) => `${dep.name}@${dep.version}: ${dep.license ?? "no licence declared"}`),
  ];

  if (simulatorProblems.length > 0) {
    console.error(`The Simulator's tools:\n  ${simulatorProblems.join("\n  ")}`);
    failed = true;
  }

  const sodiumNotices = [
    `## ${LIBSODIUM.name}@${LIBSODIUM.version} (${LIBSODIUM.license})`,
    "",
    LIBSODIUM.shippedBy,
    "",
    "```text",
    readFileSync(join(root, "docs/licenses/libsodium.txt"), "utf8").trimEnd(),
    "```",
    "",
  ].join("\n");

  const notices = `${renderNotices(verdicts)}\n${renderGoNotices(goAudit)}\n${renderSimulatorNotices(simulatorAudit)}\n${sodiumNotices}`;

  if (check) {
    const current = existsSync(noticesPath) ? readFileSync(noticesPath, "utf8") : "";

    if (current !== notices) {
      console.error("THIRD_PARTY_NOTICES.md is out of date: run `bun run licenses`.");
      failed = true;
    }
  } else if (violations.length === 0) {
    writeFileSync(noticesPath, notices);
    console.log(`Wrote ${noticesPath}`);
  }

  const exceptionCount = verdicts.filter((v) => v.status === "exception").length;
  const allowedCount = verdicts.filter((v) => v.status === "allowed").length;
  console.log(
    `${verdicts.length} production dependencies (plus ${platformBuilds.size} installed per-platform builds): ${allowedCount} allowed, ${exceptionCount} by exception, ${violations.length} violations.`
  );
  process.exit(failed ? 1 : 0);
};

if (import.meta.main) main();
