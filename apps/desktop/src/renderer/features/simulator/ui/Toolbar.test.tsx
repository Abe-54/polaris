import { describe, expect, test } from "bun:test";
import type { SimulatorPlatform } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { Controls } from "./Toolbar.tsx";

const noop = () => undefined;

const controls = (platform: SimulatorPlatform) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <Controls
        live
        platform={platform}
        hostLabel="Mac Studio"
        canAttach
        canRestart
        onHome={noop}
        onRotate={noop}
        onLock={noop}
        onScreenshot={noop}
        onRestart={noop}
      />
    </TooltipProvider>
  );

describe("the Simulator's controls", () => {
  test("iOS has no lock: iOS 27 ignores serve-sim's lock button", () => {
    const html = controls("ios");

    expect(html).toContain('aria-label="Home"');
    expect(html).not.toContain('aria-label="Lock"');
  });

  test("Android keeps lock, its power key", () => {
    expect(controls("android")).toContain('aria-label="Lock"');
  });
});
