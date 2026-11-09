import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  type DaemonBuild,
  backgroundUpgradeDue,
  buildPlatformOf,
  isDevVersion,
  isPlatform,
  platformFromUname,
  upgradeDue,
} from "./builds.ts";
import { Delivery, deliveryFor, type HostProbe, InstallPlan, planInstall } from "./plan.ts";

const build = (platform: DaemonBuild["platform"], version = "1.2.0"): DaemonBuild => ({
  platform,
  version,
  sha256: `sha-${platform}-${version}`,
  files: [
    { name: "polaris", path: `/dist/${platform}/polaris`, sha256: "x", size: 1, executable: true },
  ],
  bundled: true,
  archive: null,
});

/** A release build this app doesn't bundle: it lists the files and a Release archive. */
const published = (platform: DaemonBuild["platform"], version = "1.2.0"): DaemonBuild => ({
  ...build(platform, version),
  bundled: false,
  archive: {
    name: `polaris-daemon-${version}-${platform}.tar.gz`,
    sha256: "archive-sha",
    size: 10,
    url: `https://polaris.lux.dev/api/daemon/${version}/${platform}`,
  },
});

const allTools = { fetch: "curl", tar: true, sha256: true } as const;

const linuxX64 = build("linux-x64");

const builds = [build("darwin-arm64"), linuxX64, build("linux-arm64")];

const linux = (installed: HostProbe["installed"] = null): HostProbe => ({
  os: "Linux",
  arch: "x86_64",
  installed,
});

const user = { trigger: "user", approvedSha256: new Set<string>() } as const;

describe("platformFromUname", () => {
  test("maps the shipped platforms", () => {
    expect(platformFromUname("Darwin", "arm64")).toBe("darwin-arm64");
    expect(platformFromUname("Linux", "x86_64")).toBe("linux-x64");
    expect(platformFromUname("Linux", "aarch64")).toBe("linux-arm64");
    expect(platformFromUname("Darwin", "x86_64")).toBeNull();
    expect(platformFromUname("FreeBSD", "amd64")).toBeNull();
  });
});

describe("buildPlatformOf", () => {
  test("keys a Host's build by its hello: platform plus the libc it reports", () => {
    expect(buildPlatformOf({ platform: "linux-x64", libc: "musl" })).toBe("linux-x64-musl");
    expect(buildPlatformOf({ platform: "linux-arm64", libc: "glibc" })).toBe("linux-arm64");
    expect(buildPlatformOf({ platform: "darwin-arm64" })).toBe("darwin-arm64");
    // An older Daemon sends no libc.
    expect(buildPlatformOf({ platform: "linux-x64" })).toBe("linux-x64");
  });

  test("a libc this Client doesn't know picks no build, not the glibc one", () => {
    expect(isPlatform(buildPlatformOf({ platform: "linux-arm64", libc: "bionic" }))).toBe(false);
  });
});

describe("compareVersions", () => {
  test("orders releases and prereleases", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.2")).toBe(0);
    expect(compareVersions("1.2.0-rc.1", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0-rc.10", "1.2.0-rc.9")).toBeGreaterThan(0);
  });

  test("follows semver prerelease precedence across alpha, beta and rc", () => {
    const ordered = [
      "0.0.0-dev.412.5821ca0",
      "0.0.0",
      "0.1.0-alpha.1-dev.3.aaaaaaa",
      "0.1.0-alpha.1",
      "0.1.0-alpha.2",
      "0.1.0-alpha.10",
      "0.1.0-beta.1",
      "0.1.0-rc.1",
      "0.1.0-dev.7.bbbbbbb",
      "0.1.0",
      "0.1.1-alpha.1",
    ];

    for (const [i, lower] of ordered.entries()) {
      for (const higher of ordered.slice(i + 1)) {
        expect(compareVersions(lower, higher)).toBeLessThan(0);
        expect(compareVersions(higher, lower)).toBeGreaterThan(0);
      }
    }

    expect(compareVersions("0.1.0-alpha.1+build.5", "0.1.0-alpha.1")).toBe(0);
    expect(compareVersions("0.1.0-alpha", "0.1.0-alpha.1")).toBeLessThan(0);
  });

  test("dev builds of one version order by commit count", () => {
    expect(
      compareVersions("0.1.0-alpha.1-dev.9.aaaaaaa", "0.1.0-alpha.1-dev.10.bbbbbbb")
    ).toBeLessThan(0);
  });
});

describe("prerelease upgrades", () => {
  test("a release replaces only an older release or prerelease", () => {
    expect(upgradeDue("0.1.0-alpha.1", "0.1.0-alpha.2")).toBe(true);
    expect(upgradeDue("0.1.0-alpha.2", "0.1.0-beta.1")).toBe(true);
    expect(upgradeDue("0.1.0-rc.1", "0.1.0")).toBe(true);
    expect(upgradeDue("0.0.0-dev.412.5821ca0", "0.1.0-alpha.1")).toBe(true);
    expect(upgradeDue("0.1.0-alpha.2", "0.1.0-alpha.1")).toBe(false);
    expect(upgradeDue("0.1.0", "0.1.0-rc.1")).toBe(false);
  });

  test("a background check never downgrades a dev build", () => {
    expect(backgroundUpgradeDue("0.1.0-alpha.1-dev.9.aaaaaaa", "0.1.0-alpha.1-dev.3.bbbbbbb")).toBe(
      false
    );
    expect(backgroundUpgradeDue("0.1.0-alpha.1-dev.3.aaaaaaa", "0.1.0-alpha.1-dev.9.bbbbbbb")).toBe(
      true
    );
    expect(backgroundUpgradeDue("0.1.0-alpha.2-dev.1.aaaaaaa", "0.1.0-alpha.1-dev.9.bbbbbbb")).toBe(
      false
    );
    expect(backgroundUpgradeDue("0.1.0-alpha.1", "0.1.0-alpha.2")).toBe(true);
    expect(backgroundUpgradeDue("0.1.0-alpha.2", "0.1.0-alpha.1")).toBe(false);
  });
});

describe("dev builds", () => {
  test("are recognised by their version", () => {
    expect(isDevVersion("0.0.0-dev.412.5821ca0")).toBe(true);
    expect(isDevVersion("0.0.0-dev.412.5821ca0.dirty1790787600")).toBe(true);
    expect(isDevVersion("1.2.0")).toBe(false);
    expect(isDevVersion("0.0.1-d210")).toBe(false);
  });

  test("replace any other version; releases only an older one", () => {
    const dev = "0.0.0-dev.412.5821ca0";

    // Newer, older, another branch's dev build, a hand-made prerelease: all replaced.
    for (const installed of ["0.0.0", "0.0.1-d210", "0.0.0-dev.413.aaaaaaa", "1.2.0"]) {
      expect(upgradeDue(installed, dev)).toBe(true);
    }

    expect(upgradeDue(dev, dev)).toBe(false);
    expect(upgradeDue("1.1.0", "1.2.0")).toBe(true);
    expect(upgradeDue("2.0.0", "1.2.0")).toBe(false);
    expect(upgradeDue("0.0.0-dev.412.5821ca0", "0.0.0")).toBe(true);
  });

  test("a Host on another build upgrades without a new approval", () => {
    const dev = build("linux-x64", "0.0.0-dev.412.5821ca0");

    for (const installed of ["0.0.1-d210", "0.0.0-dev.400.bbbbbbb"]) {
      expect(
        planInstall(linux({ version: installed, platform: "linux-x64" }), [dev], {
          trigger: "background",
          approvedSha256: new Set(),
        })
      ).toEqual(InstallPlan.Upgrade({ from: installed, build: dev, delivery: Delivery.Upload() }));
    }

    expect(
      planInstall(linux({ version: dev.version, platform: "linux-x64" }), [dev], user)
    ).toEqual(InstallPlan.UpToDate({ version: dev.version }));
  });

  test("a newer dev build is replaced by an older one only when the user asks", () => {
    const stale = build("linux-x64", "0.0.0-dev.1070.a148fe8");
    const host = linux({ version: "0.0.0-dev.1260.058f292", platform: "linux-x64" });

    expect(backgroundUpgradeDue("0.0.0-dev.1260.058f292", stale.version)).toBe(false);
    expect(backgroundUpgradeDue("0.0.0-dev.1070.a148fe8", "0.0.0-dev.1260.058f292")).toBe(true);
    expect(backgroundUpgradeDue("1.2.0", stale.version)).toBe(true);

    expect(
      planInstall(host, [stale], { trigger: "background", approvedSha256: new Set() })
    ).toEqual(
      InstallPlan.InstalledNewer({ installed: "0.0.0-dev.1260.058f292", bundled: stale.version })
    );
    expect(planInstall(host, [stale], user)).toEqual(
      InstallPlan.Upgrade({
        from: "0.0.0-dev.1260.058f292",
        build: stale,
        delivery: Delivery.Upload(),
      })
    );
  });
});

describe("planInstall", () => {
  test("a fresh Host needs approval of the exact build first", () => {
    expect(planInstall(linux(), builds, user)).toEqual(
      InstallPlan.NeedsApproval({
        platform: "linux-x64",
        version: "1.2.0",
        sha256: "sha-linux-x64-1.2.0",
        reason: "first-install",
      })
    );
  });

  test("installs once that SHA-256 is approved", () => {
    const plan = planInstall(linux(), builds, {
      trigger: "user",
      approvedSha256: new Set(["sha-linux-x64-1.2.0"]),
    });

    expect(plan).toEqual(InstallPlan.Install({ build: linuxX64, delivery: Delivery.Upload() }));
  });

  test("never installs on a background reconnect, even if approved", () => {
    const plan = planInstall(linux(), builds, {
      trigger: "background",
      approvedSha256: new Set(["sha-linux-x64-1.2.0"]),
    });

    expect(plan).toEqual(
      InstallPlan.NeedsApproval({
        platform: "linux-x64",
        version: "1.2.0",
        sha256: "sha-linux-x64-1.2.0",
        reason: "background",
      })
    );
  });

  test("installs on the Client's own machine without approval, also in the background", () => {
    for (const trigger of ["user", "background"] as const) {
      const plan = planInstall(linux(), builds, {
        trigger,
        approvedSha256: new Set(),
        trusted: true,
      });

      expect(plan).toEqual(InstallPlan.Install({ build: linuxX64, delivery: Delivery.Upload() }));
    }
  });

  test("upgrades an older Daemon without asking again, also in the background", () => {
    const plan = planInstall(linux({ version: "1.1.0", platform: "linux-x64" }), builds, {
      trigger: "background",
      approvedSha256: new Set(),
    });

    expect(plan).toEqual(
      InstallPlan.Upgrade({ from: "1.1.0", build: linuxX64, delivery: Delivery.Upload() })
    );
  });

  test("does nothing when up to date, and never downgrades", () => {
    expect(planInstall(linux({ version: "1.2.0", platform: "linux-x64" }), builds, user)).toEqual(
      InstallPlan.UpToDate({ version: "1.2.0" })
    );
    expect(planInstall(linux({ version: "2.0.0", platform: "linux-x64" }), builds, user)).toEqual(
      InstallPlan.InstalledNewer({ installed: "2.0.0", bundled: "1.2.0" })
    );
  });

  test("reports Hosts it cannot serve", () => {
    expect(planInstall({ os: "Darwin", arch: "x86_64", installed: null }, builds, user)).toEqual(
      InstallPlan.Unsupported({ os: "Darwin", arch: "x86_64" })
    );
    expect(planInstall(linux(), [build("darwin-arm64")], user)).toEqual(
      InstallPlan.MissingBuild({ platform: "linux-x64" })
    );
  });
});

describe("musl Hosts", () => {
  const withMusl = [...builds, build("linux-x64-musl"), build("linux-arm64-musl")];

  const approveMusl = InstallPlan.NeedsApproval({
    platform: "linux-arm64-musl",
    version: "1.2.0",
    sha256: "sha-linux-arm64-musl-1.2.0",
    reason: "first-install",
  });

  const alpine = (missingLibraries: ReadonlyArray<string> = []): HostProbe => ({
    os: "Linux",
    arch: "aarch64",
    libc: "musl",
    missingLibraries,
    installed: null,
  });

  test("map to the musl builds", () => {
    expect(platformFromUname("Linux", "x86_64", "musl")).toBe("linux-x64-musl");
    expect(platformFromUname("Linux", "aarch64", "musl")).toBe("linux-arm64-musl");
    expect(platformFromUname("Darwin", "arm64", "musl")).toBe("darwin-arm64");
    expect(planInstall(alpine(), withMusl, user)).toEqual(approveMusl);
  });

  test("are a MissingBuild when the Client bundles no musl build, never the glibc one", () => {
    expect(planInstall(alpine(), builds, user)).toEqual(
      InstallPlan.MissingBuild({ platform: "linux-arm64-musl" })
    );
  });

  test("without libstdc++/libgcc need an administrator first", () => {
    expect(planInstall(alpine(["libstdc++.so.6", "libgcc_s.so.1"]), withMusl, user)).toEqual(
      InstallPlan.MissingLibraries({
        platform: "linux-arm64-musl",
        libraries: ["libstdc++.so.6", "libgcc_s.so.1"],
        command: "apk add libstdc++ libgcc",
      })
    );
  });

  test("an installed glibc Daemon on a musl Host is replaced by the musl build", () => {
    const probe = { ...alpine(), installed: { version: "1.2.0", platform: "linux-arm64" } };
    expect(planInstall(probe, withMusl, user)).toEqual(approveMusl);
  });
});

describe("delivery", () => {
  const approved = (b: DaemonBuild) =>
    ({ trigger: "user", approvedSha256: new Set([b.sha256]) }) as const;

  test("a bundled build uploads, whatever the Host has", () => {
    expect(deliveryFor(linuxX64, { ...linux(), tools: allTools })).toEqual(Delivery.Upload());
  });

  test("a published build the Host can fetch and check is downloaded on the Host", () => {
    const remote = published("linux-x64");

    expect(planInstall({ ...linux(), tools: allTools }, [remote], approved(remote))).toEqual(
      InstallPlan.Install({ build: remote, delivery: Delivery.HostFetch({ tool: "curl" }) })
    );
    expect(deliveryFor(remote, { ...linux(), tools: { ...allTools, fetch: "wget" } })).toEqual(
      Delivery.HostFetch({ tool: "wget" })
    );
  });

  test.each([
    ["no curl or wget", { ...linux(), tools: { ...allTools, fetch: null } }],
    ["no tar", { ...linux(), tools: { ...allTools, tar: false } }],
    ["no sha256sum or shasum", { ...linux(), tools: { ...allTools, sha256: false } }],
    ["an old probe without tools", linux()],
  ] as const)("with %s, this machine downloads and uploads", (_, probe) => {
    expect(deliveryFor(published("linux-x64"), probe)).toEqual(Delivery.ClientFetch());
  });

  test("upgrades take the same path", () => {
    const remote = published("linux-x64", "1.3.0");
    const probe = { ...linux({ version: "1.2.0", platform: "linux-x64" }), tools: allTools };

    expect(planInstall(probe, [remote], user)).toEqual(
      InstallPlan.Upgrade({
        from: "1.2.0",
        build: remote,
        delivery: Delivery.HostFetch({ tool: "curl" }),
      })
    );
  });

  test("a build neither bundled nor published is a MissingBuild", () => {
    const missing = { ...linuxX64, bundled: false };

    expect(planInstall({ ...linux(), tools: allTools }, [missing], approved(missing))).toEqual(
      InstallPlan.MissingBuild({ platform: "linux-x64" })
    );
  });

  test("approval still names the binary's SHA-256, not the archive's", () => {
    const remote = published("linux-x64");

    expect(planInstall({ ...linux(), tools: allTools }, [remote], user)).toEqual(
      InstallPlan.NeedsApproval({
        platform: "linux-x64",
        version: remote.version,
        sha256: remote.sha256,
        reason: "first-install",
      })
    );
  });
});

describe("a Windows Host", () => {
  const windowsX64 = build("windows-x64");
  const approved = { trigger: "user", approvedSha256: new Set([windowsX64.sha256]) } as const;

  const windows = (probe: Partial<HostProbe> = {}): HostProbe => ({
    os: "windows",
    arch: "AMD64",
    installed: null,
    tools: { fetch: null, tar: false, sha256: true },
    windowsShell: "powershell",
    ...probe,
  });

  test("maps the Windows probe's AMD64 to windows-x64, and nothing else yet", () => {
    expect(platformFromUname("windows", "AMD64")).toBe("windows-x64");
    expect(platformFromUname("windows", "ARM64")).toBeNull();
    expect(platformFromUname("MINGW64_NT-10.0-26200", "x86_64")).toBeNull();
  });

  test("installs and upgrades with the commands written for its DefaultShell", () => {
    expect(planInstall(windows({ windowsShell: "cmd" }), [windowsX64], approved)).toEqual(
      InstallPlan.Install({ build: windowsX64, delivery: Delivery.Upload(), windowsShell: "cmd" })
    );

    expect(
      planInstall(
        windows({ installed: { version: "1.1.0", platform: "windows-x64" } }),
        [windowsX64],
        approved
      )
    ).toEqual(
      InstallPlan.Upgrade({
        from: "1.1.0",
        build: windowsX64,
        delivery: Delivery.Upload(),
        windowsShell: "powershell",
      })
    );
  });

  test("is unsupported under a DefaultShell we don't drive, naming it", () => {
    const { windowsShell: _, ...bash } = windows({ unsupportedShell: "bash" });

    expect(planInstall(bash, [windowsX64], approved)).toEqual(
      InstallPlan.Unsupported({ os: "windows (sshd's DefaultShell is bash)", arch: "AMD64" })
    );
  });

  test("downloads a release build here, since the Host has no downloader of its own", () => {
    expect(deliveryFor(published("windows-x64"), windows())).toEqual(Delivery.ClientFetch());
  });
});
