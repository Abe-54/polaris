import { ComputerUseSetup, ComputerUseState } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { type CardView, cardView, checkedAgo, type HostFacts, switchOf } from "./model.ts";

const studio: HostFacts = { name: "Mac Studio", platform: "macos", local: true };

const macbook: HostFacts = { name: "MacBook Pro", platform: "macos", local: false };

const mac = (accessibility: boolean, screenRecording: boolean) =>
  ComputerUseState.cases.NeedsSetup.make({
    setup: ComputerUseSetup.cases.MacPermissions.make({ accessibility, screenRecording }),
  });

const step = (view: CardView) => {
  if (view.kind !== "mac-setup") throw new Error(`expected mac-setup, got ${view.kind}`);

  return view.step;
};

describe("the macOS setup step", () => {
  test("with nothing granted it is one step: Device Control and Data Access with the helper to drag in", () => {
    const view = cardView(studio, mac(false, false));

    expect(step(view)).toMatchObject({
      label: "Allow computer use",
      permission: null,
      button: "Open System Settings",
    });
    expect(step(view).detail).toContain("Device Control and Data Access");
    expect(step(view).detail).toContain("Polaris Computer Use.app");
  });

  test("once Accessibility is on, Screen Recording gets its own pane, since one drag grants only Accessibility", () => {
    const view = cardView(studio, mac(true, false));

    expect(step(view)).toMatchObject({
      label: "Allow Screen Recording",
      permission: "screen-recording",
    });
    expect(step(view).detail).toContain("Screen & System Audio Recording");
  });

  test("Screen Recording on but Accessibility off goes back to the one step", () => {
    expect(step(cardView(studio, mac(false, true))).permission).toBeNull();
  });

  test("a half-granted state shows each service under the step", () => {
    const services = step(cardView(studio, mac(true, false))).services;

    expect(services.map((s) => [s.name, s.on])).toEqual([
      ["Accessibility", true],
      ["Screen Recording", false],
    ]);
    expect(services[1]?.detail).toBe("Off");
  });

  test("the well counts what is granted and names what is missing", () => {
    const view = cardView(studio, mac(true, false));

    expect(view.kind === "mac-setup" && view.well).toEqual({
      title: "1 of 2 permissions",
      line: "Agents can't use apps on Mac Studio until Screen Recording is on.",
    });
    expect(cardView(studio, mac(false, false))).toMatchObject({
      well: {
        line: "Agents can't use apps on Mac Studio until Accessibility and Screen Recording are on.",
      },
    });
  });

  test("after opening a pane, the well says what to do in it, and only for that pane", () => {
    expect(cardView(studio, mac(false, false), null)).toMatchObject({
      well: { title: "Drag it in, then turn it on" },
    });
    expect(cardView(studio, mac(true, false), "screen-recording")).toMatchObject({
      well: { title: "Turn on Screen Recording" },
    });
    // The drag granted Accessibility: the Screen Recording pane hasn't been opened yet.
    expect(cardView(studio, mac(true, false), null)).toMatchObject({
      well: { title: "1 of 2 permissions" },
    });
  });

  test("a remote Mac opens setup there and asks the person at it", () => {
    const view = cardView(macbook, mac(false, false), null);

    expect(step(view).button).toBe("Open System Settings on MacBook Pro");
    expect(view).toMatchObject({ well: { title: "On MacBook Pro, approve the prompt" } });
  });
});

describe("other hosts", () => {
  const pi: HostFacts = { name: "Raspberry Pi 4", platform: "linux", local: false };

  test("Linux missing a package names it and the command to run there", () => {
    const view = cardView(
      pi,
      ComputerUseState.cases.NeedsSetup.make({
        setup: ComputerUseSetup.cases.LinuxPackages.make({
          packages: ["at-spi2-core"],
          command: "sudo apt-get install -y at-spi2-core",
        }),
      })
    );

    expect(view).toEqual({
      kind: "linux-setup",
      well: {
        title: "Install at-spi2-core",
        line: "Agents can't use apps on Raspberry Pi 4 until it's installed. Run this on Raspberry Pi 4, then check again.",
      },
      command: "sudo apt-get install -y at-spi2-core",
    });
  });

  test("no desktop collapses to one line on Linux and is a card saying why on Windows", () => {
    const none = ComputerUseState.cases.NoDesktop.make({});

    expect(cardView(pi, none).kind).toBe("collapsed");
    expect(cardView({ name: "Windows PC", platform: "windows", local: false }, none)).toMatchObject(
      {
        kind: "unavailable",
        well: { title: "Not available on Windows PC" },
      }
    );
  });

  test("the switch is on through setup, and can't be used without a desktop", () => {
    expect(switchOf(mac(false, false))).toEqual({ on: true, disabled: false });
    expect(switchOf(ComputerUseState.cases.Off.make({}))).toEqual({ on: false, disabled: false });
    expect(switchOf(ComputerUseState.cases.NoDesktop.make({}))).toEqual({
      on: false,
      disabled: true,
    });
  });
});

test("the last check's age reads in seconds, then minutes, then hours", () => {
  const at = "2026-11-10T12:00:00.000Z";
  const t = Date.parse(at);

  expect(checkedAgo(at, t + 2_000)).toBe("checked 2s ago");
  expect(checkedAgo(at, t + 125_000)).toBe("checked 2m ago");
  expect(checkedAgo(at, t + 3 * 3_600_000)).toBe("checked 3h ago");
});
