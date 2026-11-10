import { ComputerUseSetup, ComputerUseState } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import type { HostFacts } from "./model.ts";
import { promptView } from "./prompt.ts";

const studio: HostFacts = { name: "Mac Studio", platform: "macos", local: true };

const ask = { harness: "Claude Code", app: "Simulator" };

const mac = (accessibility: boolean, screenRecording: boolean) =>
  ComputerUseState.cases.NeedsSetup.make({
    setup: ComputerUseSetup.cases.MacPermissions.make({ accessibility, screenRecording }),
  });

describe("the inline prompt", () => {
  test("off, it names the app and turns computer use on", () => {
    expect(promptView(studio, ComputerUseState.cases.Off.make({}), ask)).toMatchObject({
      title: "Claude Code wants to use Simulator",
      fix: { kind: "enable", label: "Turn on computer use" },
    });
  });

  test("with Screen Recording missing, it opens that pane and says Accessibility is on", () => {
    expect(promptView(studio, mac(true, false), ask)).toMatchObject({
      title: "Screen Recording is off on Mac Studio",
      fix: { kind: "open-setup", permission: "screen-recording" },
      note: "Accessibility on",
    });
  });

  test("on a remote Mac, the person at it approves", () => {
    const view = promptView(
      { ...studio, name: "MacBook Pro", local: false },
      mac(false, false),
      ask
    );

    expect(view).toMatchObject({
      title: "On MacBook Pro, approve the prompt",
      fix: { label: "Open System Settings on MacBook Pro", permission: null },
    });
  });

  test("Linux without a known package manager can only check again", () => {
    const state = ComputerUseState.cases.NeedsSetup.make({
      setup: ComputerUseSetup.cases.LinuxPackages.make({
        packages: ["at-spi2-core"],
        command: null,
      }),
    });

    expect(promptView({ ...studio, platform: "linux" }, state, ask)?.fix.kind).toBe("check");
  });

  test.each([ComputerUseState.cases.Ready.make({}), ComputerUseState.cases.NoDesktop.make({})])(
    "is gone when there's nothing to fix (%o)",
    (state) => {
      expect(promptView(studio, state, ask)).toBeNull();
    }
  );
});
