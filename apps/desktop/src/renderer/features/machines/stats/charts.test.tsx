import "../../../test/dom.testing.ts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { Sparkline } from "./charts.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
});

const bars = () => screen.getByTestId("sparkline").getAttribute("data-bars");

const mount = (values: ReadonlyArray<number>) => {
  const view = render(<Sparkline values={values} count={4} height={10} label="CPU" />);

  return (next: ReadonlyArray<number>) =>
    view.rerender(<Sparkline values={next} count={4} height={10} label="CPU" />);
};

test("the sparkline advances with each sample", () => {
  const update = mount([10, 20]);
  const before = bars();

  update([10, 20, 90]);
  expect(bars()).not.toBe(before);
});

test("under Reduce Motion the sparkline holds its last frame while samples keep arriving", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const update = mount([10, 20]);
  const before = bars();

  update([10, 20, 90]);
  expect(bars()).toBe(before);
});

test("turning Reduce Motion off lets the sparkline move again", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  const update = mount([10, 20]);
  const frozen = bars();

  await act(async () => {
    document.documentElement.dataset.reduceMotion = "false";
    // The MutationObserver reports on a microtask.
    await Promise.resolve();
  });
  update([10, 20, 90]);
  expect(bars()).not.toBe(frozen);
});
