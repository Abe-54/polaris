import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORMS, loadBuilds } from "@polaris/client/install";
import { DARWIN_PATHS, daemonDist, hash, removeDists } from "./dist.testing.ts";
import { signDaemonBuilds, verifyDaemonManifest } from "./manifest.ts";
import { signingCredentials, type Signing } from "./release.ts";

afterEach(removeDists);

const signing: Signing = {
  ...signingCredentials({
    APPLE_TEAM_ID: "TEAM123456",
    APPLE_API_KEY: "/fake/key.p8",
    APPLE_API_KEY_ID: "KEY1234567",
    APPLE_API_ISSUER: "issuer",
  })!,
  identity: "test-identity",
  keychain: "/fake/keychain",
};

describe("shipped Daemon manifest", () => {
  test("hashes signed bytes, keeps Linux builds, and survives staging for remote Host installs", () => {
    const dist = daemonDist("0.1.0-rc.1");
    const linuxBefore = readFileSync(join(dist, "linux-x64/polaris"));
    const commands: ReadonlyArray<string>[] = [];
    const bundle = join(dist, "darwin-arm64/PolarisDaemon.app");

    const append = (path: string) =>
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("-signed")]));

    signDaemonBuilds(dist, signing, "/entitlements", (argv) => {
      commands.push(argv);

      // Signing the bundle rewrites its executable and its sealed resources, as codesign does.
      if (argv[0] === "codesign" && argv.includes("--sign")) {
        const target = argv.at(-1)!;

        if (target !== bundle) append(target);
        else
          for (const name of ["polaris", "CodeResources"] as const)
            append(join(dist, "darwin-arm64", DARWIN_PATHS[name]));
      }

      return argv[1] === "selftest" ? "polaris 0.1.0-rc.1 darwin-arm64\nfff ok" : "";
    });
    verifyDaemonManifest(dist, "0.1.0-rc.1");
    expect(readFileSync(join(dist, "linux-x64/polaris"))).toEqual(linuxBefore);
    const signed = commands.filter((argv) => argv.includes("--sign"));
    expect(signed.map((argv) => argv.at(-1))).toEqual([
      join(bundle, "Contents/MacOS/betterleaks"),
      bundle,
    ]);
    expect(signed[1]).toContain("runtime");
    expect(signed[1]).toContain("--timestamp");
    expect(signed[1]).toContain("/fake/keychain");
    expect(signed[1]).toContain("/entitlements/daemon.plist");
    expect(signed[0]).toContain("/entitlements/betterleaks.plist");
    expect(commands).toContainEqual(["codesign", "--verify", "--deep", "--strict", bundle]);

    const stage = join(dist, "staged");
    mkdirSync(stage);

    for (const name of [...PLATFORMS, "manifest.json"])
      cpSync(join(dist, name), join(stage, name), { recursive: true });
    verifyDaemonManifest(stage, "0.1.0-rc.1");
    const mac = loadBuilds(stage).find((build) => build.platform === "darwin-arm64")!;

    for (const file of mac.files) expect(file.sha256).toBe(hash(readFileSync(file.path)));

    const resigned = mac.files.filter((file) =>
      readFileSync(file.path).toString().endsWith("-signed")
    );

    expect(resigned.map((file) => file.name).sort()).toEqual([
      "CodeResources",
      "betterleaks",
      "polaris",
    ]);
    expect(mac.files.map((file) => file.path)).toContain(
      join(stage, "darwin-arm64", DARWIN_PATHS["Info.plist"])
    );
    expect(mac.sha256).toBe(mac.files[0]!.sha256);
    expect(mac.files.find((file) => file.name === "betterleaks")!.executable).toBe(true);
  });

  test("unsigned builds keep their manifest and never call signing tools", () => {
    const dist = daemonDist("0.1.0-rc.1");
    const before = readFileSync(join(dist, "manifest.json"));
    signDaemonBuilds(dist, null, "/entitlements", () => {
      throw new Error("unexpected signing");
    });
    expect(readFileSync(join(dist, "manifest.json"))).toEqual(before);
  });

  test("rejects mismatched, stale or incomplete release builds", () => {
    const dist = daemonDist("0.1.0-rc.1");
    expect(() => verifyDaemonManifest(dist, "0.2.0")).toThrow("does not match release");
    writeFileSync(join(dist, "linux-x64/polaris"), "changed");
    expect(() => verifyDaemonManifest(dist)).toThrow("bytes differ");
    const incomplete = daemonDist("0.1.0-rc.1");
    writeFileSync(
      join(incomplete, "manifest.json"),
      readFileSync(join(incomplete, "manifest.json"), "utf8").replace(
        '"linux-arm64-musl":',
        '"unexpected":'
      )
    );
    expect(() => verifyDaemonManifest(incomplete, "0.1.0-rc.1")).toThrow(
      "missing linux-arm64-musl"
    );
  });

  test("a failed signer or signed selftest cannot produce a refreshed manifest", () => {
    const dist = daemonDist("0.1.0-rc.1");
    const before = readFileSync(join(dist, "manifest.json"));
    expect(() =>
      signDaemonBuilds(dist, signing, "/entitlements", () => {
        throw new Error("signing failed");
      })
    ).toThrow("signing failed");
    expect(() => signDaemonBuilds(dist, signing, "/entitlements", () => "wrong version")).toThrow(
      "selftest"
    );
    expect(readFileSync(join(dist, "manifest.json"))).toEqual(before);
  });
});
