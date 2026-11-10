import { expect, test } from "bun:test";
import {
  type HostSimulatorSupport,
  Simulator,
  type SimulatorRequirement,
  SimulatorSupport,
  SimulatorWatchItem,
} from "@polaris/protocol";
import { applyWatchItem } from "./hostSimulators.ts";
import { blockerOf, pickerGroups, setupOf, shownSimulator, tabVisible } from "./model.ts";

const ready = SimulatorSupport.cases.Ready.make({});

const unsupported = SimulatorSupport.cases.Unsupported.make({});

const needs = (...missing: SimulatorRequirement[]) =>
  SimulatorSupport.cases.NeedsSetup.make({ missing });

const updating = SimulatorSupport.cases.Updating.make({ reason: "xcode-first-launch" });

const host = (ios: SimulatorSupport, android: SimulatorSupport): HostSimulatorSupport => ({
  ios,
  android,
});

const sim = (
  name: string,
  state: Simulator["state"] = "Shutdown",
  platform: Simulator["platform"] = "ios"
) =>
  new Simulator({
    id: name,
    platform,
    name,
    osVersion: platform === "ios" ? "iOS 27.0" : "Android 16",
    state,
    bootedByPolaris: false,
  });

test.each([
  ["a Mac with Xcode", host(ready, needs("android-sdk")), true],
  ["a Mac without Xcode", host(needs("xcode"), needs("android-sdk")), true],
  ["a Mac while Xcode updates", host(updating, unsupported), true],
  ["Linux with the emulator", host(unsupported, ready), true],
  ["Linux with the emulator but no ffmpeg", host(unsupported, needs("ffmpeg")), true],
  ["Linux without the Android SDK", host(unsupported, needs("android-sdk", "ffmpeg")), false],
  ["the Pi", host(unsupported, unsupported), false],
])("the tab on %s: %p", (_, support, visible) => {
  expect(tabVisible(support)).toBe(visible);
});

test("the tab waits for the Host's answer before showing", () => {
  expect(tabVisible(null)).toBe(false);
});

test("Android's setup asks for the SDK before ffmpeg and KVM, whatever order the Host lists", () => {
  expect(setupOf(needs("kvm", "ffmpeg", "android-sdk"))).toEqual({
    kind: "needs",
    requirement: "android-sdk",
  });
  expect(setupOf(needs("kvm", "ffmpeg"))).toEqual({ kind: "needs", requirement: "ffmpeg" });
});

test("a Mac whose Xcode updates shows the update, not the devices it can't run yet", () => {
  const blocker = blockerOf(host(updating, unsupported), [], null);

  expect(blocker).toEqual({ kind: "setup", platform: "ios", setup: { kind: "updating" } });
});

test("a Host with tools but no devices says so instead of a setup state", () => {
  expect(blockerOf(host(ready, needs("android-sdk")), [], null)).toEqual({ kind: "empty" });
});

test("asking for a platform's setup from the picker shows it even with devices elsewhere", () => {
  const blocker = blockerOf(host(ready, needs("android-sdk")), [sim("iPhone 17")], "android");

  expect(blocker).toEqual({
    kind: "setup",
    platform: "android",
    setup: { kind: "needs", requirement: "android-sdk" },
  });
});

test("the picker groups iOS before Android, booted devices first, names in natural order", () => {
  const groups = pickerGroups(host(ready, ready), [
    sim("Pixel 9", "Shutdown", "android"),
    sim("iPhone 17 Pro", "Shutdown"),
    sim("iPhone 9", "Shutdown"),
    sim("iPhone Air", "Booted"),
    sim("iPad Pro", "Booting"),
  ]);

  expect(groups.map((g) => [g.platform, g.simulators.map((s) => s.name)])).toEqual([
    ["ios", ["iPhone Air", "iPad Pro", "iPhone 9", "iPhone 17 Pro"]],
    ["android", ["Pixel 9"]],
  ]);
});

test("on a Mac the picker offers Android's setup; on Linux it never lists iOS", () => {
  expect(
    pickerGroups(host(ready, needs("android-sdk")), [sim("iPhone")]).map((g) => g.platform)
  ).toEqual(["ios", "android"]);
  expect(
    pickerGroups(host(unsupported, ready), [sim("Pixel", "Booted", "android")]).map(
      (g) => g.platform
    )
  ).toEqual(["android"]);
});

test("the session shows the Daemon's choice, then the user's last pick, then a booted one", () => {
  const all = [sim("A"), sim("B", "Booted"), sim("C")];

  expect(shownSimulator(all, "C", "A")?.id).toBe("C");
  expect(shownSimulator(all, null, "A")?.id).toBe("A");
  expect(shownSimulator(all, "gone", "also-gone")?.id).toBe("B");
  expect(shownSimulator([], null, null)).toBeNull();
});

test("a watch folds changes into its Snapshot and ignores them before one", () => {
  const { Snapshot, SimulatorChanged, SimulatorRemoved } = SimulatorWatchItem.cases;

  const snapshot = applyWatchItem(
    undefined,
    Snapshot.make({ support: host(ready, unsupported), simulators: [sim("A"), sim("B")] })
  );

  const booted = applyWatchItem(snapshot, SimulatorChanged.make({ simulator: sim("A", "Booted") }));

  const added = applyWatchItem(booted, SimulatorChanged.make({ simulator: sim("C") }));

  const removed = applyWatchItem(added, SimulatorRemoved.make({ id: "B" }));

  expect(removed?.simulators.map((s) => `${s.id}:${s.state}`)).toEqual(["A:Booted", "C:Shutdown"]);
  expect(applyWatchItem(undefined, SimulatorRemoved.make({ id: "A" }))).toBeUndefined();
});
