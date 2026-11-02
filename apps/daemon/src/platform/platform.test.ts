import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { loadHostInfo } from "../transport/hostInfo.ts";
import {
  detectPlatform,
  HostPlatform,
  isEmbeddedPath,
  languagePlatformOf,
  libcPathOf,
  runtimePlatformOf,
  wireLibcOf,
} from "./index.ts";
import { newTempDir, removeTempDir } from "./tempDir.testing.ts";

const probe = (files: ReadonlyArray<string>, compiledLibc?: string, arch = "x64") => ({
  os: "linux",
  arch,
  compiledLibc,
  exists: (path: string) => files.includes(path),
});

describe("detectPlatform", () => {
  test("glibc wins over musl's loader installed beside it (Debian's musl package)", () => {
    const facts = detectPlatform(
      probe(["/lib64/ld-linux-x86-64.so.2", "/lib/ld-musl-x86_64.so.1"])
    );

    expect(facts.libc).toBe("glibc");
    expect(runtimePlatformOf(facts)).toBe("linux-x64");
    expect(libcPathOf(facts)).toBe("libc.so.6");
    expect(languagePlatformOf(facts)).toEqual({ os: "linux", arch: "x64", libc: "glibc" });
  });

  test("a Host whose only libc is musl is musl", () => {
    const facts = detectPlatform(probe(["/lib/ld-musl-aarch64.so.1"], undefined, "arm64"));

    expect(facts.libc).toBe("musl");
    expect(runtimePlatformOf(facts)).toBe("linux-arm64-musl");
    expect(libcPathOf(facts)).toBe("/lib/ld-musl-aarch64.so.1");
    expect(wireLibcOf(facts)).toBe("musl");
  });

  test("a compiled build's define decides, whatever the filesystem has", () => {
    expect(detectPlatform(probe(["/lib64/ld-linux-x86-64.so.2"], "musl")).libc).toBe("musl");
    expect(detectPlatform(probe(["/lib/ld-musl-x86_64.so.1"], "gnu")).libc).toBe("glibc");
  });

  test("macOS has no libc to name", () => {
    const facts = detectPlatform({
      os: "darwin",
      arch: "arm64",
      compiledLibc: undefined,
      exists: () => true,
    });

    expect(facts.libc).toBe("none");
    expect(runtimePlatformOf(facts)).toBe("darwin-arm64");
    expect(libcPathOf(facts)).toBe("/usr/lib/libSystem.B.dylib");
    expect(wireLibcOf(facts)).toBeUndefined();
    expect(languagePlatformOf(facts)).toEqual({ os: "darwin", arch: "arm64", libc: "none" });
  });

  test("a Linux with neither loader is glibc by build id, but has no language platform", () => {
    const facts = detectPlatform(probe([]));

    expect(facts.libc).toBe("unknown");
    expect(runtimePlatformOf(facts)).toBe("linux-x64");
    expect(languagePlatformOf(facts)).toBeNull();
    expect(wireLibcOf(facts)).toBeUndefined();
  });
});

describe("HostPlatform", () => {
  test("hello's HostInfo carries the Host's libc from the provided platform", async () => {
    const root = newTempDir("polaris-platform-");

    try {
      const musl = await Effect.runPromise(
        loadHostInfo(root).pipe(Effect.provide(HostPlatform.test({ arch: "arm64", libc: "musl" })))
      );

      expect(musl.platform).toBe("linux-arm64");
      expect(musl.libc).toBe("musl");

      const mac = await Effect.runPromise(
        loadHostInfo(root).pipe(
          Effect.provide(HostPlatform.test({ os: "darwin", arch: "arm64", libc: "none" }))
        )
      );

      expect(mac.platform).toBe("darwin-arm64");
      expect("libc" in mac).toBe(false);

      const windows = await Effect.runPromise(
        loadHostInfo(root).pipe(
          Effect.provide(HostPlatform.test({ os: "win32", arch: "x64", libc: "unknown" }))
        )
      );

      expect(windows.platform).toBe("windows-x64");
      expect("libc" in windows).toBe(false);
    } finally {
      removeTempDir(root);
    }
  });
});

describe("Windows", () => {
  test("a Windows Host's build id is windows-x64, the name its archive ships under", () => {
    const facts = detectPlatform({
      os: "win32",
      arch: "x64",
      compiledLibc: undefined,
      exists: () => false,
    });

    expect(runtimePlatformOf(facts)).toBe("windows-x64");
    expect(languagePlatformOf(facts)).toBeNull();
    expect(wireLibcOf(facts)).toBeUndefined();
  });

  test.each([
    ["/$bunfs/root/fffWorker.ts", true],
    ["B:\\~BUN\\root\\fffWorker.ts", true],
    ["/B:/%7EBUN/root/fffWorker.ts", true],
    ["/b:/~BUN/root/grammar.so", true],
    ["C:\\Users\\lucas\\polaris\\fffWorker.ts", false],
    ["/home/pi/polaris/src/fffWorker.ts", false],
  ])("%s is inside a compiled binary: %p", (path, expected) => {
    expect(isEmbeddedPath(path)).toBe(expected);
  });
});
