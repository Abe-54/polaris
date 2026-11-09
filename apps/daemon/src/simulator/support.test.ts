import { type SimulatorRequirement, SimulatorSupport } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HostPlatform, type PlatformFacts } from "../platform/index.ts";
import { SimulatorDetection } from "./index.ts";
import {
  type CommandResult,
  detectSupport,
  FIRST_LAUNCH_MESSAGE,
  simulatorCapable,
  type SupportProbe,
} from "./support.ts";

const READY = SimulatorSupport.cases.Ready.make({});

const UNSUPPORTED = SimulatorSupport.cases.Unsupported.make({});

const needs = (missing: ReadonlyArray<SimulatorRequirement>) =>
  SimulatorSupport.cases.NeedsSetup.make({ missing });

const MAC: PlatformFacts = { os: "darwin", arch: "arm64", libc: "none" };

const LINUX: PlatformFacts = { os: "linux", arch: "x64", libc: "glibc" };

const PI: PlatformFacts = { os: "linux", arch: "arm64", libc: "glibc" };

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout });

const XCODE_SELECT = "/usr/bin/xcode-select -p";

const SIMCTL = "/usr/bin/xcrun simctl list runtimes --json";

const PS = "/bin/ps -axo command";

const FFMPEG = "/opt/homebrew/bin/ffmpeg -hide_banner -encoders";

const FIRST_LAUNCH =
  "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -runFirstLaunch";

interface HostSpec {
  /** Each command's answer, keyed by its argv joined with spaces; a missing one can't start. */
  readonly commands?: Record<string, CommandResult | "timeout">;
  readonly files?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  readonly readWrite?: ReadonlyArray<string>;
  readonly path?: Record<string, string>;
}

const host = (spec: HostSpec) => {
  const ran: Array<string> = [];

  const probe: SupportProbe = {
    run: async (argv) => {
      const key = argv.join(" ");
      ran.push(key);

      return spec.commands?.[key] ?? null;
    },
    which: (program) => spec.path?.[program] ?? null,
    isFile: (path) => spec.files?.includes(path) ?? false,
    canReadWrite: (path) => spec.readWrite?.includes(path) ?? false,
    env: spec.env ?? {},
    home: "/home/u",
  };

  return { probe, ran };
};

const XCODE = {
  [XCODE_SELECT]: ok("/Applications/Xcode.app/Contents/Developer\n"),
  [PS]: ok("/sbin/launchd\n"),
  [SIMCTL]: ok('{"runtimes":[]}'),
};

const SDK = "/sdk";

const ANDROID: HostSpec = {
  env: { ANDROID_HOME: SDK },
  files: [`${SDK}/emulator/emulator`, `${SDK}/platform-tools/adb`],
  path: { ffmpeg: "/opt/homebrew/bin/ffmpeg" },
  commands: { [FFMPEG]: ok(" V....D libx264  libx264 H.264 / AVC\n") },
};

const merge = (a: HostSpec, b: HostSpec): HostSpec => ({
  commands: { ...a.commands, ...b.commands },
  files: [...(a.files ?? []), ...(b.files ?? [])],
  env: { ...a.env, ...b.env },
  readWrite: [...(a.readWrite ?? []), ...(b.readWrite ?? [])],
  path: { ...a.path, ...b.path },
});

const detect = (facts: PlatformFacts, spec: HostSpec) => detectSupport(facts, host(spec).probe);

describe("iOS support", () => {
  test("a Mac with Xcode selected and simctl answering is Ready", async () => {
    const report = await detect(MAC, { commands: XCODE });

    expect(report.support.ios).toEqual(READY);
    expect(report.iosBlocked).toBeNull();
  });

  test.each([
    ["no Xcode at all", {}],
    [
      "only the Command Line Tools",
      { [XCODE_SELECT]: ok("/Library/Developer/CommandLineTools\n") },
    ],
    ["simctl failing", { ...XCODE, [SIMCTL]: { exitCode: 72, stdout: "" } }],
  ])("a Mac with %s needs Xcode", async (_, commands) => {
    const report = await detect(MAC, { commands });

    expect(report.support.ios).toEqual(needs(["xcode"]));
    expect(report.iosBlocked).toBeNull();
  });

  test("Xcode finishing an update is said, without waiting on simctl", async () => {
    const { probe, ran } = host({ commands: { ...XCODE, [PS]: ok(`${FIRST_LAUNCH}\n`) } });
    const report = await detectSupport(MAC, probe);

    expect(report.support.ios).toEqual(needs(["xcode"]));
    expect(report.iosBlocked).toBe(FIRST_LAUNCH_MESSAGE);
    expect(ran).not.toContain(SIMCTL);
  });

  test("a simctl that hangs because the first launch just started is said too", async () => {
    let psCalls = 0;
    const { probe } = host({ commands: { ...XCODE, [SIMCTL]: "timeout" } });

    const report = await detectSupport(MAC, {
      ...probe,
      run: async (argv, timeoutMs) => {
        if (argv.join(" ") !== PS) return probe.run(argv, timeoutMs);
        psCalls += 1;

        return ok(psCalls === 1 ? "" : `${FIRST_LAUNCH}\n`);
      },
    });

    expect(report.iosBlocked).toBe(FIRST_LAUNCH_MESSAGE);
  });

  test("a simctl that hangs for another reason doesn't time out silently", async () => {
    const report = await detect(MAC, { commands: { ...XCODE, [SIMCTL]: "timeout" } });

    expect(report.support.ios).toEqual(needs(["xcode"]));
    expect(report.iosBlocked).toBe("Xcode's simctl didn't answer within 20 s");
  });

  test("iOS is Unsupported off a Mac", async () => {
    expect((await detect(LINUX, ANDROID)).support.ios).toEqual(UNSUPPORTED);
  });
});

describe("Android support", () => {
  test("a Mac with the SDK and ffmpeg with libx264 is Ready, and reports the SDK", async () => {
    const report = await detect(MAC, ANDROID);

    expect(report.support.android).toEqual(READY);
    expect(report.androidSdk).toBe(SDK);
  });

  test.each([
    ["without ffmpeg", { ...ANDROID, path: {} }, ["ffmpeg"]],
    [
      "with an ffmpeg that has no libx264",
      { ...ANDROID, commands: { [FFMPEG]: ok(" V....D h264_videotoolbox\n") } },
      ["ffmpeg"],
    ],
    ["without an SDK", { ...ANDROID, env: {} }, ["android-sdk"]],
    [
      "with an SDK that has no adb",
      { ...ANDROID, files: [`${SDK}/emulator/emulator`] },
      ["android-sdk"],
    ],
    ["with nothing", {}, ["android-sdk", "ffmpeg"]],
  ] satisfies ReadonlyArray<[string, HostSpec, ReadonlyArray<SimulatorRequirement>]>)(
    "a Mac %s needs setup",
    async (_, spec, missing) => {
      expect((await detect(MAC, spec)).support.android).toEqual(needs(missing));
    }
  );

  test("the SDK is found through ANDROID_SDK_ROOT and the IDE's default folder", async () => {
    const viaRoot = await detect(MAC, { ...ANDROID, env: { ANDROID_SDK_ROOT: SDK } });
    const home = "/home/u/Android/Sdk";

    const viaDefault = await detect(LINUX, {
      ...ANDROID,
      env: {},
      files: [`${home}/emulator/emulator`, `${home}/platform-tools/adb`],
      readWrite: ["/dev/kvm"],
    });

    expect([viaRoot.androidSdk, viaDefault.androidSdk]).toEqual([SDK, home]);
  });

  test("Linux without KVM access needs KVM; with it, it is Ready", async () => {
    expect((await detect(LINUX, ANDROID)).support.android).toEqual(needs(["kvm"]));
    expect(
      (await detect(LINUX, merge(ANDROID, { readWrite: ["/dev/kvm"] }))).support.android
    ).toEqual(READY);
  });
});

describe("Hosts that can't run Simulators", () => {
  test("the Pi is Unsupported for both platforms without running anything", async () => {
    const { probe, ran } = host(merge(ANDROID, { commands: XCODE, readWrite: ["/dev/kvm"] }));
    const report = await detectSupport(PI, probe);

    expect(report.support).toEqual({
      ios: UNSUPPORTED,
      android: UNSUPPORTED,
    });
    expect(ran).toEqual([]);
  });

  test.each([
    [MAC, true],
    [{ os: "darwin", arch: "x64", libc: "none" } satisfies PlatformFacts, true],
    [LINUX, true],
    [PI, false],
    [{ os: "linux", arch: "x64", libc: "musl" } satisfies PlatformFacts, false],
    [{ os: "win32", arch: "x64", libc: "none" } satisfies PlatformFacts, false],
  ])("%o advertises the simulator capability: %p", (facts, capable) => {
    expect(simulatorCapable(facts)).toBe(capable);
  });
});

describe("SimulatorDetection", () => {
  test("detects once and caches until refreshed", async () => {
    const { probe, ran } = host({ commands: XCODE });

    const layer = SimulatorDetection.layerWith(() => probe).pipe(
      Layer.provide(HostPlatform.test(MAC))
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const detection = yield* SimulatorDetection;
        yield* detection.current;
        yield* detection.current;
        expect(ran.filter((c) => c === SIMCTL)).toHaveLength(1);
        yield* detection.refresh;
        expect(ran.filter((c) => c === SIMCTL)).toHaveLength(2);
      }).pipe(Effect.provide(layer))
    );
  });
});
