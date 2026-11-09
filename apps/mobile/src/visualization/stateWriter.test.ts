import { describe, expect, test } from "bun:test";
import type { SavedState } from "./stateStore.ts";
import {
  flushState,
  heldWriters,
  holdWriter,
  STATE_MAX_BYTES,
  stateWriter,
} from "./stateWriter.ts";

const harness = () => {
  const written: Array<SavedState> = [];
  const due: Array<() => void> = [];

  const writer = stateWriter(
    "viz_a",
    { read: () => undefined, write: (_id, state) => written.push(state) },
    500,
    (run) => {
      due.push(run);

      return () => undefined;
    }
  );

  const tick = () => due.splice(0).forEach((run) => run());

  return { writer, written, tick };
};

describe("pv.state writes", () => {
  test("a burst lands once, with its latest state", () => {
    const { writer, written, tick } = harness();

    for (let rate = 1; rate <= 50; rate++) writer.offer({ pv: 1, value: { rate } });

    expect(written).toEqual([]);
    tick();
    expect(written).toEqual([{ pv: 1, value: { rate: 50 } }]);
  });

  test("a state over 64 KB, counted in UTF-8, is refused and nothing is written", () => {
    const { writer, written, tick } = harness();
    // Each "é" is two bytes: under the cap in characters, over it in bytes.
    const big = { pv: 1, value: "é".repeat(STATE_MAX_BYTES / 2 + 1) };

    expect(writer.offer(big)).toBe(false);
    expect(writer.offer({ pv: 1, value: 1n })).toBe(false);
    writer.flush();
    tick();
    expect(written).toEqual([]);
  });

  test("flush writes what is pending at once", () => {
    const { writer, written } = harness();

    writer.offer({ pv: 1, value: 3 });
    writer.flush();
    expect(written).toEqual([{ pv: 1, value: 3 }]);
  });

  test("a writer is shared while held and evicted when the last frame lets go", () => {
    const written: Array<SavedState> = [];

    const store = {
      read: () => undefined,
      write: (_id: string, state: SavedState) => written.push(state),
    };

    const before = heldWriters();
    const inline = holdWriter("viz_held", store);
    const sheet = holdWriter("viz_held", store);

    expect(sheet.writer).toBe(inline.writer);
    inline.release();
    inline.release();
    expect(heldWriters()).toBe(before + 1);
    sheet.writer.offer({ pv: 1, value: 7 });
    sheet.release();
    expect(written).toEqual([{ pv: 1, value: 7 }]);
    expect(heldWriters()).toBe(before);
    expect(flushState("viz_held")).toBeUndefined();
  });

  test("many Visualizations mounted and unmounted leave no writers behind", () => {
    const store = { read: () => undefined, write: () => undefined };
    const before = heldWriters();

    for (let n = 0; n < 1000; n++) holdWriter(`viz_${n}`, store).release();
    expect(heldWriters()).toBe(before);
  });
});
