/**
 * The install flow against a fake ssh that runs each remote command in a
 * local `sh` with HOME pointed at a temporary "Host". The remote shell
 * scripts (probe, upload, SHA check) therefore run for real; the uploaded
 * `polaris` is a small shell stand-in for the Daemon's install/upgrade.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer, Predicate } from "effect";
import { type DaemonBuild, loadBuilds, platformFromUname } from "./builds.ts";
import { Delivery, InstallPlan } from "./plan.ts";
import { packArchive } from "./archive.ts";
import { downloadBuild } from "./download.ts";
import {
  type ApplyProgress,
  ApplyResult,
  applyPlan,
  EnsureResult,
  ensureDaemon,
  parseProbe,
  probeScript,
  RemoteInstallError,
} from "./remote.ts";
import { Ssh, SshError } from "./Ssh.ts";

const uname = (flag: string) => Bun.spawnSync(["uname", flag]).stdout.toString().trim();

const platform = platformFromUname(uname("-s"), uname("-m"))!;

let host: string;

let dist: string;

const commands: Array<string> = [];

/** Runs `command` like sshd would, with the fake Host's HOME. */
const localSsh = (
  options: {
    corruptUploads?: boolean;
    unreachable?: boolean;
    env?: Record<string, string>;
    /** The Host's umask; every script must stay private under a permissive one. */
    umask?: string;
  } = {}
) =>
  Layer.succeed(
    Ssh,
    Ssh.of({
      exec: (alias, command, execOptions) =>
        Effect.gen(function* () {
          commands.push(command);

          if (options.unreachable) {
            return yield* new SshError({
              alias,
              failure: "unreachable",
              message: "ssh: connect to host h port 22: Connection refused",
            });
          }

          const stdin = execOptions?.stdinFile ? readFileSync(execOptions.stdinFile) : undefined;

          const bytes =
            stdin && options.corruptUploads ? Buffer.concat([stdin, Buffer.from("!")]) : stdin;

          const proc = Bun.spawnSync(["sh", "-c", `umask ${options.umask ?? "022"}; ${command}`], {
            env: { PATH: process.env.PATH, HOME: host, ...options.env },
            stdin: bytes ?? "ignore",
          });

          return {
            code: proc.exitCode ?? 1,
            stdout: proc.stdout.toString(),
            stderr: proc.stderr.toString(),
          };
        }),
    })
  );

/** A stand-in `polaris` that installs itself and upgrades like the real one. */
const fakePolaris = (version: string) => `#!/bin/sh
case "$1" in
  version) echo "polaris ${version} ${platform}" ;;
  install)
    ls -ldn "$(dirname "$0")" > "$HOME/staging.log"
    dir="$HOME/.polaris/bin/${version}"; mkdir -p "$dir"
    cp "$0" "$dir/polaris"; cp "$(dirname "$0")/libnative.so" "$(dirname "$0")/betterleaks" "$dir/"
    ln -sfn "${version}" "$HOME/.polaris/bin/current"
    echo '{"ok":true,"action":"install","version":"${version}"}' ;;
  upgrade)
    new=$("$2" version | cut -d' ' -f2); dir="$HOME/.polaris/bin/$new"; mkdir -p "$dir"
    cp "$2" "$dir/polaris"; ln -sfn "$new" "$HOME/.polaris/bin/current"
    echo "{\\"ok\\":true,\\"action\\":\\"handoff\\",\\"version\\":\\"$new\\"}" ;;
esac
`;

const sha = (content: string) => createHash("sha256").update(content).digest("hex");

/** Write a dist directory like scripts/build-daemon.ts does, for this machine's platform. */
const writeDist = (version: string): ReadonlyArray<DaemonBuild> => {
  const binary = fakePolaris(version);
  const native = `native library ${version}`;
  const scanner = `#!/bin/sh\necho betterleaks ${version}\n`;
  mkdirSync(join(dist, platform), { recursive: true });
  writeFileSync(join(dist, platform, "polaris"), binary);
  chmodSync(join(dist, platform, "polaris"), 0o755);
  writeFileSync(join(dist, platform, "libnative.so"), native);
  // At its own `path`, as a macOS build keeps it in the app bundle; it uploads flat.
  mkdirSync(join(dist, platform, dirname(SCANNER_PATH)), { recursive: true });
  writeFileSync(join(dist, platform, SCANNER_PATH), scanner);
  writeFileSync(
    join(dist, "manifest.json"),
    JSON.stringify({
      version,
      commit: "test",
      platforms: {
        [platform]: {
          target: "x",
          binary: "polaris",
          sha256: sha(binary),
          files: {
            polaris: { sha256: sha(binary), size: binary.length },
            "libnative.so": { sha256: sha(native), size: native.length },
            betterleaks: {
              sha256: sha(scanner),
              size: scanner.length,
              executable: true,
              path: SCANNER_PATH,
            },
          },
        },
      },
    })
  );

  return loadBuilds(dist);
};

const SCANNER_PATH = "Polaris.app/Contents/MacOS/betterleaks";

beforeEach(() => {
  host = mkdtempSync(join(tmpdir(), "polaris-host-"));
  dist = mkdtempSync(join(tmpdir(), "polaris-dist-"));
  commands.length = 0;
});

afterEach(() => {
  rmSync(host, { recursive: true, force: true });
  rmSync(dist, { recursive: true, force: true });
});

const current = () => readlinkSync(join(host, ".polaris", "bin", "current"));

describe("ensureDaemon", () => {
  test("first contact asks for approval and touches nothing", async () => {
    const builds = writeDist("1.0.0");

    const result = await Effect.runPromise(
      ensureDaemon("h", builds, { trigger: "user", approvedSha256: new Set() }).pipe(
        Effect.provide(localSsh())
      )
    );

    expect(result).toEqual(
      EnsureResult.ApprovalNeeded({
        plan: InstallPlan.NeedsApproval({
          platform,
          version: "1.0.0",
          sha256: builds[0]!.sha256,
          reason: "first-install",
        }),
      })
    );
    expect(commands).toHaveLength(1); // only the probe
  });

  test("installs the approved build, then is up to date", async () => {
    const builds = writeDist("1.0.0");
    const approved = { trigger: "user", approvedSha256: new Set([builds[0]!.sha256]) } as const;

    const result = await Effect.runPromise(
      ensureDaemon("h", builds, approved).pipe(Effect.provide(localSsh()))
    );

    expect(result).toEqual(
      EnsureResult.Ready({
        plan: InstallPlan.Install({ build: builds[0]!, delivery: Delivery.Upload() }),
        applied: ApplyResult.Installed({
          version: "1.0.0",
          report: { ok: true, action: "install", version: "1.0.0" },
        }),
      })
    );
    expect(current()).toBe("1.0.0");
    expect(readFileSync(join(host, ".polaris/bin/1.0.0/libnative.so"), "utf8")).toBe(
      "native library 1.0.0"
    );
    // Files the manifest marks executable upload as 755, others as 644.
    expect(statSync(join(host, ".polaris/bin/1.0.0/betterleaks")).mode & 0o777).toBe(0o755);
    expect(statSync(join(host, ".polaris/bin/1.0.0/libnative.so")).mode & 0o777).toBe(0o644);
    // The upload directory is cleaned up.
    expect(
      Bun.spawnSync(["ls", join(host, ".polaris")])
        .stdout.toString()
        .trim()
    ).toBe("bin");

    const again = await Effect.runPromise(
      ensureDaemon("h", builds, { trigger: "background", approvedSha256: new Set() }).pipe(
        Effect.provide(localSsh())
      )
    );

    expect(again).toEqual(
      EnsureResult.Ready({ plan: InstallPlan.UpToDate({ version: "1.0.0" }), applied: null })
    );
  });

  test("upgrades an installed Daemon with polaris upgrade <path>", async () => {
    const v1 = writeDist("1.0.0");
    await Effect.runPromise(
      ensureDaemon("h", v1, { trigger: "user", approvedSha256: new Set([v1[0]!.sha256]) }).pipe(
        Effect.provide(localSsh())
      )
    );
    const v2 = writeDist("1.1.0");
    commands.length = 0;

    const result = await Effect.runPromise(
      ensureDaemon("h", v2, { trigger: "background", approvedSha256: new Set() }).pipe(
        Effect.provide(localSsh())
      )
    );

    expect(result).toEqual(
      EnsureResult.Ready({
        plan: InstallPlan.Upgrade({ from: "1.0.0", build: v2[0]!, delivery: Delivery.Upload() }),
        applied: ApplyResult.Upgraded({
          from: "1.0.0",
          version: "1.1.0",
          report: { ok: true, action: "handoff", version: "1.1.0" },
        }),
      })
    );
    expect(current()).toBe("1.1.0");
    // The uploaded build runs the upgrade, so its own staging lays the version out.
    expect(commands.some((c) => /upload-[0-9a-f]+\/polaris" upgrade /.test(c))).toBe(true);
    expect(commands.some((c) => c.includes("current/polaris") && c.includes("upgrade"))).toBe(
      false
    );
  });

  test("refuses an upload whose SHA-256 does not match on the Host", async () => {
    const builds = writeDist("1.0.0");

    const error = await Effect.runPromise(
      ensureDaemon("h", builds, {
        trigger: "user",
        approvedSha256: new Set([builds[0]!.sha256]),
      }).pipe(Effect.flip, Effect.provide(localSsh({ corruptUploads: true })))
    );

    expect(error).toBeInstanceOf(RemoteInstallError);
    expect(error).toMatchObject({ step: "upload polaris" });
    expect(error.message).toContain("SHA-256 on the Host");
  });

  test("stages privately under a permissive umask and makes ~/.polaris private", async () => {
    const builds = writeDist("1.0.0");
    mkdirSync(join(host, ".polaris"), { mode: 0o777 });
    chmodSync(join(host, ".polaris"), 0o777);

    await Effect.runPromise(
      ensureDaemon("h", builds, {
        trigger: "user",
        approvedSha256: new Set([builds[0]!.sha256]),
      }).pipe(Effect.provide(localSsh({ umask: "000" })))
    );

    expect(current()).toBe("1.0.0");
    expect(statSync(join(host, ".polaris")).mode & 0o777).toBe(0o700);
    // `ls -ldn` of the staging directory, taken by the uploaded `polaris install`.
    expect(readFileSync(join(host, "staging.log"), "utf8")).toMatch(/^drwx------[.@]? /);
  });

  test("refuses to write into a staging directory another account could change", async () => {
    const builds = writeDist("1.0.0");

    const opened = Layer.effect(
      Ssh,
      Effect.gen(function* () {
        const ssh = yield* Ssh;

        return Ssh.of({
          exec: (alias, command, options) =>
            ssh.exec(alias, command, options).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (!command.includes("mkdir -m 700")) return;

                  for (const name of readdirSync(join(host, ".polaris")))
                    chmodSync(join(host, ".polaris", name), 0o777);
                })
              )
            ),
        });
      })
    ).pipe(Layer.provide(localSsh()));

    const error = await Effect.runPromise(
      applyPlan("h", InstallPlan.Install({ build: builds[0]!, delivery: Delivery.Upload() })).pipe(
        Effect.flip,
        Effect.provide(opened)
      )
    );

    expect(error).toMatchObject({ step: "upload polaris" });
    expect(error.message).toContain("is not a private directory of this user");
    expect(existsSync(join(host, ".polaris/bin"))).toBe(false);
  });

  test("passes ssh failures through, classified", async () => {
    const error = await Effect.runPromise(
      ensureDaemon("h", writeDist("1.0.0"), { trigger: "user", approvedSha256: new Set() }).pipe(
        Effect.flip,
        Effect.provide(localSsh({ unreachable: true }))
      )
    );

    expect(error instanceof SshError ? error.needsAttention : "not an SshError").toBe(false);
  });
});

/** A release dist: the manifest lists this platform, but only the archive holds its files. */
const writeRelease = (version: string, options: { served?: (archive: Buffer) => Buffer } = {}) => {
  const binary = fakePolaris(version);
  const native = `native library ${version}`;
  const scanner = `#!/bin/sh\necho betterleaks ${version}\n`;

  const archive = packArchive([
    { name: "polaris", mode: 0o755, bytes: Buffer.from(binary) },
    { name: "libnative.so", mode: 0o644, bytes: Buffer.from(native) },
    { name: "betterleaks", mode: 0o755, bytes: Buffer.from(scanner) },
  ]);

  const served = options.served?.(Buffer.from(archive)) ?? archive;
  const archivePath = join(dist, "served.tar.gz");
  writeFileSync(archivePath, served);
  writeFileSync(
    join(dist, "manifest.json"),
    JSON.stringify({
      version,
      commit: "test",
      download: { url: "https://polaris.test/api/daemon/{version}/{platform}" },
      bundled: [],
      platforms: {
        [platform]: {
          target: "x",
          binary: "polaris",
          sha256: sha(binary),
          files: {
            polaris: { sha256: sha(binary), size: binary.length },
            "libnative.so": { sha256: sha(native), size: native.length },
            betterleaks: { sha256: sha(scanner), size: scanner.length, executable: true },
          },
          archive: {
            name: `polaris-daemon-${version}-${platform}.tar.gz`,
            sha256: createHash("sha256").update(archive).digest("hex"),
            size: archive.length,
          },
        },
      },
    })
  );

  return { builds: loadBuilds(dist), archive, archivePath };
};

/**
 * A `curl` that writes `FAKE_ARCHIVE` to stdout or `-o` (or fails with 22, like a 404) and
 * records its URL; `trailing` bytes of zeros follow, then it notes it finished.
 */
const fakeCurl = (fail: boolean, trailing = 0) => {
  const bin = join(dist, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
for a; do last="$a"; done
echo "$last" >> "$FAKE_LOG"
${fail ? "exit 22" : ""}
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && exec > "$2"; shift; done
cat "$FAKE_ARCHIVE" && ${trailing > 0 ? `head -c ${trailing} /dev/zero && ` : ""}echo done > "$FAKE_LOG.done"
`
  );
  chmodSync(join(bin, "curl"), 0o755);

  return { PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: join(dist, "curl.log") };
};

/** Applies a Host download of `builds` with no fallback, so its own error comes through. */
const hostFetchOnly = (builds: ReadonlyArray<DaemonBuild>, env: Record<string, string>) =>
  Effect.runPromise(
    applyPlan(
      "h",
      InstallPlan.Install({ build: builds[0]!, delivery: Delivery.HostFetch({ tool: "curl" }) })
    ).pipe(Effect.flip, Effect.provide(localSsh({ env })))
  );

const fetchFrom = (bytes: Uint8Array, status = 200) => {
  const urls: string[] = [];

  const fetcher = async (url: string) => {
    urls.push(url);

    return new Response(status === 200 ? new Uint8Array(bytes) : null, { status });
  };

  return { urls, fetcher };
};

describe("release builds that aren't bundled", () => {
  test("the Host downloads, checks and installs the archive itself", async () => {
    const { builds, archivePath } = writeRelease("2.0.0");
    const env = { ...fakeCurl(false), FAKE_ARCHIVE: archivePath };
    const progress: ApplyProgress[] = [];

    const result = await Effect.runPromise(
      ensureDaemon(
        "h",
        builds,
        { trigger: "user", approvedSha256: new Set([builds[0]!.sha256]) },
        { clientVersion: "2.0.0", progress: (value) => progress.push(value) }
      ).pipe(Effect.provide(localSsh({ env })))
    );

    expect(Predicate.isTagged(result, "Ready") && Predicate.isTagged(result.plan, "Install")).toBe(
      true
    );
    expect(current()).toBe("2.0.0");
    expect(statSync(join(host, ".polaris/bin/2.0.0/betterleaks")).mode & 0o777).toBe(0o755);
    expect(readFileSync(env.FAKE_LOG, "utf8").trim()).toBe(
      `https://polaris.test/api/daemon/2.0.0/${platform}?client=2.0.0&via=host`
    );
    expect(progress[0]).toMatchObject({ stage: "downloading", via: "host" });
    expect(progress.some((p) => p.stage === "uploading")).toBe(false);
  });

  test("a corrupted Host download falls back to downloading here and uploading", async () => {
    const { builds, archive, archivePath } = writeRelease("2.0.0", {
      served: (bytes) => {
        bytes[bytes.length - 1]! ^= 0xff;

        return bytes;
      },
    });

    const env = { ...fakeCurl(false), FAKE_ARCHIVE: archivePath };
    const { urls, fetcher } = fetchFrom(archive);
    const progress: ApplyProgress[] = [];
    const cacheDir = join(dist, "cache");

    await Effect.runPromise(
      ensureDaemon(
        "h",
        builds,
        { trigger: "user", approvedSha256: new Set([builds[0]!.sha256]) },
        {
          download: downloadBuild({ cacheDir, fetch: fetcher, clientVersion: "2.0.0" }),
          progress: (value) => progress.push(value),
        }
      ).pipe(Effect.provide(localSsh({ env })))
    );

    expect(current()).toBe("2.0.0");
    expect(urls).toEqual([
      `https://polaris.test/api/daemon/2.0.0/${platform}?client=2.0.0&via=client`,
    ]);
    expect(progress.map((p) => `${p.stage}:${p.via ?? ""}`)).toContain("downloading:client");
    expect(progress.some((p) => p.stage === "uploading")).toBe(true);
    expect(existsSync(join(cacheDir, "2.0.0", platform, "polaris"))).toBe(true);
    // Nothing the Host downloaded is left behind.
    expect(
      Bun.spawnSync(["ls", join(host, ".polaris")])
        .stdout.toString()
        .trim()
    ).toBe("bin");
  });

  test("the Host stops a download one byte past the manifest's size", async () => {
    const { builds, archivePath } = writeRelease("2.0.0");
    const env = { ...fakeCurl(false, 16 * 1024 * 1024), FAKE_ARCHIVE: archivePath };

    const error = await hostFetchOnly(builds, env);

    expect(error.message).toContain(`larger than ${builds[0]!.archive!.size} bytes`);
    // The stream was cut off rather than written out in full.
    expect(existsSync(`${env.FAKE_LOG}.done`)).toBe(false);
    expect(readdirSync(join(host, ".polaris"))).toEqual([]);
  });

  test("the Host refuses a download shorter than the manifest's size", async () => {
    const { builds, archivePath } = writeRelease("2.0.0", {
      served: (bytes) => bytes.subarray(0, bytes.length - 1),
    });

    const error = await hostFetchOnly(builds, { ...fakeCurl(false), FAKE_ARCHIVE: archivePath });

    expect(error.message).toContain(
      `the archive is ${builds[0]!.archive!.size - 1} bytes, expected ${builds[0]!.archive!.size}`
    );
  });

  test("a Host download that never finishes times out and falls back", async () => {
    const { builds, archive } = writeRelease("2.0.0");
    const { fetcher } = fetchFrom(archive);

    const hanging = Layer.effect(
      Ssh,
      Effect.gen(function* () {
        const ssh = yield* Ssh;

        return Ssh.of({
          exec: (alias, command, options) =>
            command.includes(".tar.gz") ? Effect.never : ssh.exec(alias, command, options),
        });
      })
    ).pipe(Layer.provide(localSsh()));

    const result = await Effect.runPromise(
      applyPlan(
        "h",
        InstallPlan.Install({ build: builds[0]!, delivery: Delivery.HostFetch({ tool: "curl" }) }),
        {
          hostFetchTimeoutMs: 50,
          download: downloadBuild({ cacheDir: join(dist, "cache"), fetch: fetcher }),
        }
      ).pipe(Effect.provide(hanging))
    );

    expect(Predicate.isTagged(result, "Installed")).toBe(true);
    expect(current()).toBe("2.0.0");
  });

  test("an unpublished version (404 on the Host) without a download fails with both reasons", async () => {
    const { builds, archivePath } = writeRelease("2.0.0");
    const env = { ...fakeCurl(true), FAKE_ARCHIVE: archivePath };

    const error = await Effect.runPromise(
      ensureDaemon("h", builds, {
        trigger: "user",
        approvedSha256: new Set([builds[0]!.sha256]),
      }).pipe(Effect.flip, Effect.provide(localSsh({ env })))
    );

    expect(error).toBeInstanceOf(RemoteInstallError);
    expect(error.message).toContain("cannot download one");
    expect(error.message).toContain("download on the host failed first");
    expect(existsSync(join(host, ".polaris/bin"))).toBe(false);
  });

  test("a download here that differs from the manifest installs nothing", async () => {
    const { builds, archive } = writeRelease("2.0.0");
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 1]! ^= 0xff;
    const { fetcher } = fetchFrom(tampered);
    const [only] = builds;

    const error = await Effect.runPromise(
      applyPlan("h", InstallPlan.Install({ build: only!, delivery: Delivery.ClientFetch() }), {
        download: downloadBuild({ cacheDir: join(dist, "cache"), fetch: fetcher }),
      }).pipe(Effect.flip, Effect.provide(localSsh()))
    );

    expect(error.message).toContain("differs from this app's manifest");
    expect(existsSync(join(host, ".polaris/bin"))).toBe(false);
    expect(existsSync(join(dist, "cache", "2.0.0"))).toBe(false);
  });

  test("a cached download is reused without fetching again", async () => {
    const { builds, archive } = writeRelease("2.0.0");
    const { urls, fetcher } = fetchFrom(archive);
    const download = downloadBuild({ cacheDir: join(dist, "cache"), fetch: fetcher });

    await Effect.runPromise(download(builds[0]!, () => {}));
    const again = await Effect.runPromise(download(builds[0]!, () => {}));

    expect(urls).toHaveLength(1);
    expect(again.bundled).toBe(true);
    expect(again.files[0]!.path).toBe(join(dist, "cache", "2.0.0", platform, "polaris"));
  });

  test("dev builds upload their bundled files and never download", async () => {
    const builds = writeDist("1.0.0");
    const env = { ...fakeCurl(false), FAKE_ARCHIVE: "/nonexistent" };

    await Effect.runPromise(
      ensureDaemon("h", builds, {
        trigger: "user",
        approvedSha256: new Set([builds[0]!.sha256]),
      }).pipe(Effect.provide(localSsh({ env })))
    );

    expect(current()).toBe("1.0.0");
    expect(existsSync(env.FAKE_LOG)).toBe(false);
  });
});

describe("probe libc", () => {
  const probeIn = (files: ReadonlyArray<string>) => {
    const root = join(dist, "root");

    for (const file of files) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "");
    }

    return parseProbe(Bun.spawnSync(["sh", "-c", probeScript(root)]).stdout.toString());
  };

  test.each([
    ["an x64", "x86_64", "linux-x64", ["/lib64/ld-linux-x86-64.so.2", "/lib/ld-musl-x86_64.so.1"]],
    [
      "a Debian arm64",
      "aarch64",
      "linux-arm64",
      ["/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1", "/lib/ld-musl-aarch64.so.1"],
    ],
  ] as const)("%s glibc Host with musl's loader installed is glibc", (_, arch, platform, files) => {
    const probe = probeIn(files);

    expect(probe?.libc).toBeUndefined();
    expect(platformFromUname("Linux", arch, probe?.libc)).toBe(platform);
  });

  test("a Host with only musl's loader is musl", () => {
    const probe = probeIn(["/lib/ld-musl-aarch64.so.1", "/usr/lib/libstdc++.so.6"]);

    expect(probe?.libc).toBe("musl");
    expect(probe?.missingLibraries).toEqual(["libgcc_s.so.1"]);
    expect(platformFromUname("Linux", "aarch64", probe?.libc)).toBe("linux-arm64-musl");
  });
});

describe("parsing", () => {
  test("parseProbe reads the probe's key=value lines", () => {
    expect(parseProbe("os=Linux\narch=aarch64\ninstalled=polaris 1.0.0 linux-arm64\n")).toEqual({
      os: "Linux",
      arch: "aarch64",
      installed: { version: "1.0.0", platform: "linux-arm64" },
      tools: { fetch: null, tar: false, sha256: false },
    });
    expect(parseProbe("os=Linux\narch=aarch64\nfetch=wget\ntar=1\nsha256=1\n")?.tools).toEqual({
      fetch: "wget",
      tar: true,
      sha256: true,
    });
    expect(parseProbe("os=Darwin\narch=arm64\n")?.installed).toBeNull();
    expect(parseProbe("Welcome to Ubuntu\n")).toBeNull();
  });

  test("parseProbe reads musl and its missing runtime libraries", () => {
    expect(parseProbe("os=Linux\narch=x86_64\nlibc=musl\nmissing=libstdc++.so.6\n")).toEqual({
      os: "Linux",
      arch: "x86_64",
      libc: "musl",
      missingLibraries: ["libstdc++.so.6"],
      installed: null,
      tools: { fetch: null, tar: false, sha256: false },
    });
    expect(parseProbe("os=Linux\narch=x86_64\nlibc=musl\n")?.missingLibraries).toEqual([]);
  });
});
