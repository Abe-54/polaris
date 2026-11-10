import {
  AllowedApp,
  AppId,
  ComputerUseSetup,
  ComputerUseState,
  ComputerUseStatus,
  DesktopApp,
} from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComputerUseActions, ComputerUseFeed } from "../hooks.ts";
import { ComputerUseCard } from "./ComputerUseCard.tsx";

const actions: ComputerUseActions = {
  busy: false,
  opened: undefined,
  setOn: () => undefined,
  openSetup: () => undefined,
  checkAgain: () => undefined,
  remove: () => undefined,
  add: async () => true,
  pickApp: async () => null,
};

const simulator = AllowedApp.make({
  app: DesktopApp.make({
    id: AppId.make("com.apple.iphonesimulator"),
    name: "Simulator",
    icon: null,
  }),
  allowedAt: "2026-11-03T10:00:00.000Z",
});

const render = (state: ComputerUseState, allowed: ComputerUseFeed["allowed"] = []) =>
  renderToStaticMarkup(
    <ComputerUseCard
      host={{ name: "Mac Studio", platform: "macos", local: true }}
      feed={{
        status: ComputerUseStatus.make({ state, checkedAt: new Date().toISOString() }),
        allowed,
        controlled: [],
      }}
      actions={actions}
    />
  );

describe("the host page's computer use card", () => {
  test("half granted, it shows the next step with both services and the always-allowed apps", () => {
    const html = render(
      ComputerUseState.cases.NeedsSetup.make({
        setup: ComputerUseSetup.cases.MacPermissions.make({
          accessibility: true,
          screenRecording: false,
        }),
      }),
      [simulator]
    );

    expect(html).toContain("Allow Screen Recording");
    expect(html).toMatch(/data-testid="computer-use-service-Accessibility" data-on="true"/);
    expect(html).toMatch(/data-testid="computer-use-service-Screen Recording" data-on="false"/);
    expect(html).toContain("Always allowed on Mac Studio");
    expect(html).toContain("Simulator");
    expect(html).toContain("Remove");
    expect(html).toContain("1 app always allowed · others ask each time");
  });

  test("with no desktop on a Linux host it is one line with no switch", () => {
    const html = renderToStaticMarkup(
      <ComputerUseCard
        host={{ name: "Raspberry Pi 4", platform: "linux", local: false }}
        feed={{
          status: ComputerUseStatus.make({
            state: ComputerUseState.cases.NoDesktop.make({}),
            checkedAt: new Date().toISOString(),
          }),
          allowed: [],
          controlled: [],
        }}
        actions={actions}
      />
    );

    expect(html).toContain('data-state="collapsed"');
    expect(html).toContain("No desktop on Raspberry Pi 4");
    expect(html).not.toContain('role="switch"');
  });

  test("off, the switch is off and there's no setup step yet", () => {
    const html = render(ComputerUseState.cases.Off.make({}));

    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("computer-use-step");
  });
});
