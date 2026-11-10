import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { Dialog, DialogOverlay, DialogPortal } from "../components/ui/dialog";
import { FLOAT_MOTION, TOOLTIP_MOTION } from "./float";

afterEach(cleanup);

describe("floating layer motion", () => {
  test("floating layers fade in and close at once", () => {
    expect(FLOAT_MOTION).toContain("data-[state=open]:fade-in-0");
    expect(FLOAT_MOTION).not.toContain("data-[state=closed]");
  });

  test("floating layers scale in from the side that faces their trigger", () => {
    expect(FLOAT_MOTION).toContain("data-[state=open]:zoom-in-[0.96]");
    expect(FLOAT_MOTION).toContain("origin-(--radix-popper-transform-origin)");
    expect(TOOLTIP_MOTION).not.toContain("zoom-in");
  });

  test("tooltips fade in only on a delayed open", () => {
    expect(TOOLTIP_MOTION).toContain("data-[state=delayed-open]:fade-in-0");
    expect(TOOLTIP_MOTION).not.toContain("data-[state=closed]");
    expect(TOOLTIP_MOTION).not.toContain("instant-open");
  });

  test("a closing dialog scrim lets clicks through", () => {
    render(
      <Dialog open>
        <DialogPortal>
          <DialogOverlay />
        </DialogPortal>
      </Dialog>
    );

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');

    expect(overlay?.className).toContain("data-[state=closed]:pointer-events-none!");
  });
});
