/**
 * Android Emulators through the Simulator tools, with fakes: this Mac has no Android SDK, so a
 * real emulator run is still owed (ENG-834).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type HostSimulatorSupport,
  type SimulatorRequirement,
  SimulatorSupport,
} from "@polaris/protocol";
import { callTool, textOf } from "./mcp.testing.ts";
import { defaultAnswer, disposeAll, ok, setup, UDID } from "./server.testing.ts";

afterEach(disposeAll);

const { Ready, NeedsSetup, Unsupported } = SimulatorSupport.cases;

const LINUX_X64 = { os: "linux", arch: "x64", libc: "glibc" } as const;

const linuxAndroid = (android: HostSimulatorSupport["android"]): HostSimulatorSupport => ({
  ios: Unsupported.make({}),
  android,
});

const SDK = "/opt/android-sdk";

const listing = (platform: string) => ({
  devices:
    platform === "android"
      ? [
          {
            id: "emulator-5554",
            name: "Pixel 9",
            platform: "android",
            osVersion: "15",
            booted: true,
          },
        ]
      : [{ id: UDID, name: "iPhone 17", platform: "ios", osVersion: "27.0", booted: false }],
});

const MISSING: ReadonlyArray<
  readonly [ReadonlyArray<SimulatorRequirement>, ReadonlyArray<string>]
> = [
  [["android-sdk"], ["the Android SDK"]],
  [["ffmpeg"], ["ffmpeg built with libx264"]],
  [["kvm"], ["/dev/kvm"]],
  [
    ["android-sdk", "ffmpeg", "kvm"],
    ["the Android SDK", "ffmpeg built with libx264", "/dev/kvm"],
  ],
];

describe("Android Emulators through the Simulator tools", () => {
  test("a Linux x64 Host with the Android SDK gets the server, and agent-device gets adb", async () => {
    const { open, calls, envs } = setup({
      facts: LINUX_X64,
      support: linuxAndroid(Ready.make({})),
      androidSdk: SDK,
    });

    const { server } = await open();
    const opened = await callTool(server!.url, "simulator_open", { id: "emulator-5554" });

    expect(opened.isError).toBeUndefined();
    expect(calls[0]).toEqual([
      "open",
      "--json",
      "--timeout",
      "300000",
      "--platform",
      "android",
      "--serial",
      "emulator-5554",
      "--session",
      "polaris-s1",
      "--",
    ]);
    expect(envs[0]).toMatchObject({ ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK });
    expect(envs[0]?.PATH?.split(":").slice(0, 2)).toEqual([
      `${SDK}/platform-tools`,
      `${SDK}/emulator`,
    ]);
    await callTool(server!.url, "simulator_tap", { target: "@e3" });

    expect(calls.at(-1)?.slice(0, 6)).toEqual([
      "press",
      "--settle",
      "--platform",
      "android",
      "--serial",
      "emulator-5554",
    ]);
  });

  test("an AVD that isn't running is opened by its name", async () => {
    const { open, calls } = setup({
      facts: LINUX_X64,
      support: linuxAndroid(Ready.make({})),
      androidSdk: SDK,
    });

    const { server } = await open();
    await callTool(server!.url, "simulator_open", { id: "Pixel_9_API_35" });

    expect(calls[0]).toContain("--device");
    expect(calls[0]?.[calls[0].indexOf("--device") + 1]).toBe("Pixel_9_API_35");
  });

  test.each(MISSING)("missing %p, a tool names what the Host needs", async (missing, says) => {
    const { open, calls } = setup({
      facts: LINUX_X64,
      support: linuxAndroid(NeedsSetup.make({ missing })),
    });

    const { server } = await open();
    const result = await callTool(server!.url, "simulator_open", { id: "emulator-5554" });

    expect(result.isError).toBe(true);

    for (const phrase of says) expect(textOf(result)).toContain(phrase);
    expect(calls).toEqual([]);
  });

  test("an Android device on a Host that can't run them says so", async () => {
    const { open } = setup();
    const { server } = await open();
    const result = await callTool(server!.url, "simulator_open", { id: "emulator-5554" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("can't run Android Emulators");
  });

  test("a list shows each platform's devices, or what a platform still needs", async () => {
    const { open } = setup({
      support: {
        ios: Ready.make({}),
        android: NeedsSetup.make({ missing: ["ffmpeg"] }),
      },
      answer: (args) =>
        args[0] === "devices"
          ? ok(listing(args[args.indexOf("--platform") + 1]!))
          : defaultAnswer(args),
    });

    const { server } = await open();
    const listed = textOf(await callTool(server!.url, "simulator_list"));

    expect(listed).toContain(`${UDID} · iPhone 17 · iOS 27.0`);
    expect(listed).toContain("Android: Android Emulators need ffmpeg built with libx264");
  });

  test("a list on a ready Android Host shows its emulators", async () => {
    const { open } = setup({
      facts: LINUX_X64,
      support: linuxAndroid(Ready.make({})),
      androidSdk: SDK,
      answer: (args) =>
        args[0] === "devices"
          ? ok(listing(args[args.indexOf("--platform") + 1]!))
          : defaultAnswer(args),
    });

    const { server } = await open();
    const listed = textOf(await callTool(server!.url, "simulator_list"));

    expect(listed).toBe("emulator-5554 · Pixel 9 · Android 15 · booted");
  });
});
