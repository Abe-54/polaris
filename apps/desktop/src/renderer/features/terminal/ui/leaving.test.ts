import "../../../test/dom.testing.ts";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { useTerminalLeaving } from "./leaving.ts";

const advance = (ms: number) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });

const mounted = () =>
  renderHook(({ shown }: { readonly shown: boolean }) => useTerminalLeaving(shown), {
    initialProps: { shown: true },
  });

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  delete document.documentElement.dataset.reduceMotion;
});

test("a hidden terminal stays laid out for the join, then goes", () => {
  document.documentElement.dataset.reduceMotion = "false";
  const { result, rerender } = mounted();

  rerender({ shown: false });
  advance(60);
  expect(result.current).toBe(true);
  advance(220);
  expect(result.current).toBe(false);
});

test("Reduce Motion turned on after the Editor mounted: a hidden terminal goes at once", () => {
  document.documentElement.dataset.reduceMotion = "false";
  const { result, rerender } = mounted();

  document.documentElement.dataset.reduceMotion = "true";
  rerender({ shown: false });
  advance(60);
  expect(result.current).toBe(false);
});

test("a terminal shown again mid-join is no longer leaving", () => {
  document.documentElement.dataset.reduceMotion = "false";
  const { result, rerender } = mounted();

  rerender({ shown: false });
  rerender({ shown: true });
  expect(result.current).toBe(false);
});
