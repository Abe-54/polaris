/**
 * Install and upgrade the Daemon on a Host over SSH:
 *
 *   probeHost      uname, libc, download tools and `polaris version`, one round trip; a
 *                  Windows Host (no `sh`, or Git's MINGW one) takes a second, in PowerShell
 *   planInstall    (plan.ts) install / upgrade / nothing / needs approval, and the delivery
 *   applyPlan      get the build onto the Host (upload it, or let the Host download the
 *                  Release archive, falling back to downloading here and uploading),
 *                  verify every SHA-256 there, then `polaris install` or `polaris upgrade <path>`
 *   ensureDaemon   all three
 *
 * Nothing needs sudo.
 */
import { randomBytes } from "node:crypto";
import { Data, Effect, Match } from "effect";
import {
  type ApplyOptions,
  ApplyResult,
  type ApplyProgress,
  failed,
  RemoteInstallError,
  type TaskConflict,
  runPolaris,
} from "./apply.ts";
import {
  archiveRequestUrl,
  type DaemonArchive,
  type DaemonBuild,
  GLIBC_LOADERS,
  MUSL_RUNTIME_LIBRARIES,
} from "./builds.ts";
import {
  type FetchTool,
  type HostProbe,
  type InstallPlan,
  type PlanOptions,
  planInstall,
} from "./plan.ts";
import { Ssh, type SshError, shellQuote, shScript } from "./Ssh.ts";
import {
  applyWindowsPlan,
  isWindowsUname,
  parseWindowsProbe,
  stripClixml,
  WINDOWS_PROBE_COMMAND,
} from "./windows/index.ts";

export {
  type ApplyOptions,
  ApplyResult,
  type ApplyProgress,
  type DaemonReport,
  type DownloadBuild,
  RemoteInstallError,
} from "./apply.ts";

/**
 * The probe. `root` prefixes the loader paths, so tests can play a Host's
 * filesystem. glibc wins when its loader exists: musl only when it is the sole libc.
 */
export const probeScript = (root = "") =>
  [
    `printf 'os=%s\\n' "$(uname -s)"`,
    `printf 'arch=%s\\n' "$(uname -m)"`,
    `gnu=; for f in ${GLIBC_LOADERS.map((path) => shellQuote(root + path)).join(" ")}; do [ -e "$f" ] && gnu=1; done`,
    // musl's loader is /lib/ld-musl-<arch>.so.1; `ldd --version` says "musl" there too.
    `if [ -z "$gnu" ] && { ls ${shellQuote(root)}/lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); }; then echo libc=musl; ` +
      `for l in ${MUSL_RUNTIME_LIBRARIES.join(" ")}; do [ -e ${shellQuote(root)}"/usr/lib/$l" ] || [ -e ${shellQuote(root)}"/lib/$l" ] || printf 'missing=%s\\n' "$l"; done; fi`,
    `for t in curl wget; do command -v "$t" >/dev/null 2>&1 && { printf 'fetch=%s\\n' "$t"; break; }; done`,
    "command -v tar >/dev/null 2>&1 && echo tar=1",
    "{ command -v sha256sum || command -v shasum; } >/dev/null 2>&1 && echo sha256=1",
    `v=$("$HOME/.polaris/bin/current/polaris" version 2>/dev/null) && printf 'installed=%s\\n' "$v"`,
    "exit 0",
  ].join("; ");

export const PROBE_SCRIPT = probeScript();

export const parseProbe = (stdout: string): HostProbe | null => {
  const fields = new Map(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );

  const os = fields.get("os");
  const arch = fields.get("arch");

  if (!os || !arch) return null;
  const version = /^polaris (\S+) (\S+)$/.exec(fields.get("installed") ?? "");

  const missing = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("missing="))
    .map((line) => line.slice("missing=".length));

  const fetch = fields.get("fetch");

  const probe: HostProbe = {
    os,
    arch,
    installed: version ? { version: version[1]!, platform: version[2]! } : null,
    tools: {
      fetch: fetch === "curl" || fetch === "wget" ? fetch : null,
      tar: fields.get("tar") === "1",
      sha256: fields.get("sha256") === "1",
    },
  };

  if (fields.get("libc") !== "musl") return probe;

  return { ...probe, libc: "musl", missingLibraries: missing };
};

/** The Windows probe, after the POSIX one found no usable `sh`; null when it isn't Windows either. */
const probeWindows = Effect.fn("probeWindows")(function* (alias: string) {
  const ssh = yield* Ssh;
  const result = yield* ssh.exec(alias, WINDOWS_PROBE_COMMAND);

  return result.code === 0 ? parseWindowsProbe(result.stdout) : null;
});

export const probeHost = Effect.fn("probeHost")(function* (alias: string) {
  const ssh = yield* Ssh;
  const result = yield* ssh.exec(alias, shScript(PROBE_SCRIPT));
  const probe = result.code === 0 ? parseProbe(result.stdout) : null;

  if (probe !== null && !isWindowsUname(probe.os)) return probe;

  // Only a failed or MINGW probe gets here; how a Windows shell fails varies too much to tell.
  const windows = yield* probeWindows(alias);

  if (windows !== null) return windows;

  if (probe !== null) return probe;

  return yield* new RemoteInstallError({
    alias,
    step: "probe",
    message: `unexpected answer (exit ${result.code}): ${(stripClixml(result.stderr) || result.stdout).trim()}`,
  });
});

/** The most the Host may download for one archive, whatever the manifest says. */
export const MAX_HOST_ARCHIVE_BYTES = 512 * 1024 * 1024;

/**
 * Shell: `private D` succeeds only for a real directory this user owns with mode
 * 0700 (`.` and `@` are SELinux and macOS markers, `+` an ACL, which fails).
 */
const PRIVATE_DIR = [
  `private() ( set -f; [ -d "$1" ] && [ ! -L "$1" ] || exit 1; set -- $(ls -ldn "$1")`,
  `case "$1" in drwx------|drwx------.|drwx------@) ;; *) exit 1 ;; esac`,
  `[ "$3" = "$(id -u)" ] )`,
].join("; ");

/** The start of every script that writes into the staging directory `dir`. */
const inStaging = (dir: string) => [
  "set -e",
  "umask 077",
  PRIVATE_DIR,
  `private "$HOME/${dir}" || { echo "$HOME/${dir} is not a private directory of this user" >&2; exit 3; }`,
];

/**
 * Creates `~/.polaris` private to this user and `dir` inside it, fresh (mkdir
 * fails if anything is there), so no other account can swap a verified file.
 */
const stage = Effect.fn("stage")(function* (alias: string, dir: string) {
  const ssh = yield* Ssh;

  const script = [
    "set -e",
    "umask 077",
    PRIVATE_DIR,
    `p="$HOME/.polaris"`,
    `[ -e "$p" ] || mkdir -m 700 "$p"`,
    `set -- $(ls -ldnL "$p")`,
    `[ -d "$p" ] && [ "$3" = "$(id -u)" ] || { echo "$p is not a directory this user owns" >&2; exit 3; }`,
    `chmod 700 "$p"`,
    `mkdir -m 700 "$HOME/${dir}"`,
    `private "$HOME/${dir}" || { echo "$HOME/${dir} is not a private directory of this user" >&2; exit 3; }`,
  ].join("; ");

  const result = yield* ssh.exec(alias, shScript(script));

  if (result.code !== 0) return yield* failed(alias, "stage", result);
});

/** Upload every file of `build` into the staged `~/.polaris/upload-<id>/`, verifying hashes there. */
const upload = Effect.fn("upload")(function* (
  alias: string,
  build: DaemonBuild,
  dir: string,
  progress?: (value: ApplyProgress) => void
) {
  const ssh = yield* Ssh;
  const total = build.files.reduce((sum, file) => sum + file.size, 0);
  let sent = 0;
  let reportedAt = 0;
  progress?.({ stage: "uploading", bytes: 0, total });

  for (const file of build.files) {
    const target = `"$HOME/${dir}/${file.name}"`;
    const mode = file.executable ? "755" : "644";

    const script = [
      ...inStaging(dir),
      `cat > ${target}.part`,
      `chmod ${mode} ${target}.part`,
      `mv ${target}.part ${target}`,
      `(sha256sum ${target} 2>/dev/null || shasum -a 256 ${target}) | cut -d' ' -f1`,
    ].join("; ");

    const result = yield* ssh.exec(alias, shScript(script), {
      stdinFile: file.path,
      onStdinBytes: (bytes) => {
        const now = Date.now();

        if (now - reportedAt < 100 && bytes !== file.size) return;
        reportedAt = now;
        progress?.({ stage: "uploading", bytes: sent + bytes, total });
      },
    });

    if (result.code !== 0) return yield* failed(alias, `upload ${file.name}`, result);
    const remoteSha = result.stdout.trim();

    if (remoteSha !== file.sha256) {
      return yield* new RemoteInstallError({
        alias,
        step: `upload ${file.name}`,
        message: `SHA-256 on the Host is ${remoteSha || "missing"}, expected ${file.sha256}`,
      });
    }

    sent += file.size;
  }

  progress?.({ stage: "switching", bytes: sent, total });

  return { dir, binary: `"$HOME/${dir}/${build.files[0]!.name}"` };
});

const fileModes = (build: DaemonBuild, dir: string) =>
  build.files.map((file) => `chmod ${file.executable ? "755" : "644"} "$HOME/${dir}/${file.name}"`);

/** The Host's `sha256sum`-style lines checked against every file of `build`; null when all match. */
const mismatch = (build: DaemonBuild, stdout: string): string | null => {
  const found = new Map(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+\*?/))
      .map(([hash, name]) => [name ?? "", hash ?? ""])
  );

  const wrong = build.files.find((file) => found.get(file.name) !== file.sha256);

  return wrong === undefined
    ? null
    : `${wrong.name}: SHA-256 on the Host is ${found.get(wrong.name) || "missing"}, expected ${wrong.sha256}`;
};

/** The Host downloads the Release archive with curl or wget, checks it, and unpacks it into `dir`. */
const hostFetch = Effect.fn("hostFetch")(function* (
  alias: string,
  build: DaemonBuild,
  archive: DaemonArchive,
  tool: FetchTool,
  dir: string,
  options: ApplyOptions
) {
  const ssh = yield* Ssh;
  const step = "download on the host";

  if (archive.size > MAX_HOST_ARCHIVE_BYTES) {
    return yield* new RemoteInstallError({
      alias,
      step,
      message: `${archive.name} is larger than ${MAX_HOST_ARCHIVE_BYTES} bytes`,
    });
  }

  const url = shellQuote(archiveRequestUrl(archive, "host", options.clientVersion));
  const target = `"$HOME/${dir}/${archive.name}"`;
  const names = build.files.map((file) => shellQuote(file.name)).join(" ");
  const size = archive.size;

  const get =
    tool === "curl"
      ? `curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --retry 2 --max-time 600 --max-filesize ${size} ${url}`
      : `wget -q -T 30 -t 2 -O - ${url}`;

  // head stops the stream one byte past the manifest's size, so the Host's disk never fills.
  const script = [
    ...inStaging(dir),
    `{ ${get} || echo "the download failed (exit $?)" >&2; } | head -c ${size + 1} > ${target}`,
    `n=$(wc -c < ${target} | tr -d ' ')`,
    `[ "$n" -le ${size} ] || { echo "the archive is larger than ${size} bytes" >&2; exit 3; }`,
    `[ "$n" -eq ${size} ] || { echo "the archive is $n bytes, expected ${size}" >&2; exit 3; }`,
    `s=$( (sha256sum ${target} 2>/dev/null || shasum -a 256 ${target}) | cut -d' ' -f1)`,
    `[ "$s" = "${archive.sha256}" ] || { echo "archive SHA-256 is $s, expected ${archive.sha256}" >&2; exit 3; }`,
    `tar -xzf ${target} -C "$HOME/${dir}"`,
    `rm -f ${target}`,
    ...fileModes(build, dir),
    `cd "$HOME/${dir}"`,
    `sha256sum ${names} 2>/dev/null || shasum -a 256 ${names}`,
  ].join("; ");

  options.progress?.({ stage: "downloading", via: "host", bytes: 0, total: size });
  const timeoutMs = options.hostFetchTimeoutMs ?? 15 * 60_000;

  const result = yield* ssh.exec(alias, shScript(script)).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new RemoteInstallError({ alias, step, message: `did not finish within ${timeoutMs} ms` })
        ),
    })
  );

  if (result.code !== 0) return yield* failed(alias, step, result);
  const wrong = mismatch(build, result.stdout);

  if (wrong !== null) return yield* new RemoteInstallError({ alias, step, message: wrong });
  const total = build.files.reduce((sum, file) => sum + file.size, 0);
  options.progress?.({ stage: "switching", bytes: total, total });

  return { dir, binary: `"$HOME/${dir}/${build.files[0]!.name}"` };
});

/** This machine downloads the build into its cache, then uploads it like a bundled one. */
const clientFetch = (alias: string, build: DaemonBuild, dir: string, options: ApplyOptions) => {
  const total = build.archive?.size ?? 0;

  if (options.download === undefined)
    return Effect.fail(
      new RemoteInstallError({
        alias,
        step: "download",
        message: `This app carries no ${build.platform} daemon and cannot download one.`,
      })
    );

  return options
    .download(build, (bytes) =>
      options.progress?.({ stage: "downloading", via: "client", bytes, total })
    )
    .pipe(Effect.flatMap((local) => upload(alias, local, dir, options.progress)));
};

const cleanUp = (alias: string, dir: string) =>
  Effect.gen(function* () {
    const ssh = yield* Ssh;
    yield* ssh.exec(alias, shScript(`rm -rf "$HOME/${dir}"`));
  }).pipe(Effect.ignore);

/** Gets the build's files into `dir` on the Host by the plan's delivery, falling back as it says. */
const deliver = (
  alias: string,
  plan: Extract<InstallPlan, { _tag: "Install" | "Upgrade" }>,
  dir: string,
  options: ApplyOptions
) =>
  Match.value(plan.delivery).pipe(
    Match.tagsExhaustive({
      Upload: () => upload(alias, plan.build, dir, options.progress),
      ClientFetch: () => clientFetch(alias, plan.build, dir, options),
      HostFetch: ({ tool }) =>
        hostFetch(alias, plan.build, plan.build.archive!, tool, dir, options).pipe(
          Effect.catchTag("RemoteInstallError", (onHost) =>
            cleanUp(alias, dir).pipe(
              Effect.andThen(stage(alias, dir)),
              Effect.andThen(clientFetch(alias, plan.build, dir, options)),
              Effect.catchTag("RemoteInstallError", (error) =>
                Effect.fail(
                  new RemoteInstallError({
                    alias,
                    step: error.step,
                    message: `${error.message} (${onHost.step} failed first: ${onHost.message})`,
                  })
                )
              )
            )
          )
        ),
    })
  );

/** Carry out an `Install` or `Upgrade` plan on a POSIX Host. */
const applyPosixPlan = Effect.fn("applyPosixPlan")(function* (
  alias: string,
  plan: Extract<InstallPlan, { _tag: "Install" | "Upgrade" }>,
  options: ApplyOptions = {}
) {
  const dir = `.polaris/upload-${randomBytes(6).toString("hex")}`;

  return yield* Effect.gen(function* () {
    yield* stage(alias, dir);
    const uploaded = yield* deliver(alias, plan, dir, options);
    const sha256 = shellQuote(plan.build.sha256);

    const run = Match.value(plan).pipe(
      Match.tagsExhaustive({
        Install: () =>
          runPolaris(
            alias,
            "install",
            shScript(`${uploaded.binary} install --json --sha256 ${sha256}`)
          ).pipe(
            Effect.map((report) => ApplyResult.Installed({ version: plan.build.version, report }))
          ),
        // The new build stages itself (an older one can't lay out its macOS bundle, ENG-680),
        // then hands the running Daemon over to it.
        Upgrade: (upgrade) =>
          runPolaris(
            alias,
            "upgrade",
            shScript(`${uploaded.binary} upgrade ${uploaded.binary} --json --sha256 ${sha256}`)
          ).pipe(
            Effect.map((report) =>
              ApplyResult.Upgraded({ from: upgrade.from, version: plan.build.version, report })
            )
          ),
      })
    );

    return yield* run;
  }).pipe(Effect.ensuring(cleanUp(alias, dir)));
});

/** Carry out an `Install` or `Upgrade` plan: PowerShell on a Windows Host, else `sh`. */
export const applyPlan = (
  alias: string,
  plan: Extract<InstallPlan, { _tag: "Install" | "Upgrade" }>,
  options: ApplyOptions = {}
) =>
  plan.windowsShell === undefined
    ? applyPosixPlan(alias, plan, options)
    : applyWindowsPlan(alias, plan, plan.windowsShell, options);

export type EnsureResult = Data.TaggedEnum<{
  Ready: { readonly plan: InstallPlan; readonly applied: ApplyResult | null };
  /** Show inline on the Host as Needs Attention; call again with the SHA approved. */
  ApprovalNeeded: { readonly plan: Extract<InstallPlan, { _tag: "NeedsApproval" }> };
  Unavailable: {
    readonly plan: Extract<InstallPlan, { _tag: "Unsupported" | "MissingBuild" }>;
  };
  /** Needs Attention: an administrator must run `plan.command` on the Host, then retry. */
  HostSetupNeeded: { readonly plan: Extract<InstallPlan, { _tag: "MissingLibraries" }> };
}>;

export const EnsureResult = Data.taggedEnum<EnsureResult>();

/**
 * Make sure the Host runs a Daemon this Client can talk to: install (only
 * with the user's approval of the build's SHA-256, never on a background
 * reconnect), upgrade, or nothing.
 */
export const ensureDaemon = Effect.fn("ensureDaemon")(function* (
  alias: string,
  builds: ReadonlyArray<DaemonBuild>,
  options: PlanOptions,
  apply: ApplyOptions = {}
): Effect.fn.Return<EnsureResult, RemoteInstallError | TaskConflict | SshError, Ssh> {
  const probe = yield* probeHost(alias);
  const plan = planInstall(probe, builds, options);

  const ready = (applied: ApplyResult | null): EnsureResult =>
    EnsureResult.Ready({ plan, applied });

  const decided = (result: EnsureResult) => Effect.succeed(result);

  return yield* Match.value(plan).pipe(
    Match.tagsExhaustive({
      NeedsApproval: (needs) => decided(EnsureResult.ApprovalNeeded({ plan: needs })),
      Unsupported: (unsupported) => decided(EnsureResult.Unavailable({ plan: unsupported })),
      MissingBuild: (missing) => decided(EnsureResult.Unavailable({ plan: missing })),
      MissingLibraries: (missing) => decided(EnsureResult.HostSetupNeeded({ plan: missing })),
      UpToDate: () => decided(ready(null)),
      InstalledNewer: () => decided(ready(null)),
      Install: (install) => Effect.map(applyPlan(alias, install, apply), ready),
      Upgrade: (upgrade) => Effect.map(applyPlan(alias, upgrade, apply), ready),
    })
  );
});
