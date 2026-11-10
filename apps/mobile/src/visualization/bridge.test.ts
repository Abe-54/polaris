import { FRAME_MESSAGE_MAX_BYTES } from "@polaris/visualization";
import { describe, expect, test } from "bun:test";
import { openBridge } from "./bridge.ts";
import type { SavedState } from "./stateStore.ts";
import { heldWriters } from "./stateWriter.ts";

const harness = (id = "viz_a") => {
  const saved = new Map<string, SavedState>();

  const store = {
    read: (key: string) => saved.get(key),
    write: (key: string, state: SavedState) => void saved.set(key, state),
  };

  let now = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const frames: Array<() => void> = [];
  const heights: Array<number> = [];
  const links: Array<string> = [];

  const clock = {
    now: () => now,
    schedule: (run: () => void, ms: number) => {
      const timer = { at: now + ms, run };

      timers.push(timer);

      return () => void timers.splice(timers.indexOf(timer) >>> 0, 1);
    },
  };

  const open = () =>
    openBridge(
      id,
      store,
      () => ({ onHeight: (height) => heights.push(height), onOpenLink: (url) => links.push(url) }),
      (run) => {
        frames.push(run);

        return () => void frames.splice(frames.indexOf(run) >>> 0, 1);
      },
      clock
    );

  const advance = (ms: number) => {
    now += ms;

    for (const timer of timers.filter(({ at }) => at <= now).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }

    frames.splice(0).forEach((run) => run());
  };

  return { id, saved, heights, links, open, advance };
};

const state = (value: Readonly<Record<string, number>> | string) =>
  JSON.stringify({ type: "pv:state", state: { pv: 1, value } });

const height = (value: number) => JSON.stringify({ type: "pv:height", height: value });

describe("the Mobile frame bridge", () => {
  test("a counter clicked through a flood keeps its last value, and heights land once a frame", () => {
    const { id, saved, heights, open, advance } = harness();
    const bridge = open();

    for (let n = 0; n < 20_000; n++) {
      bridge.receive(height(100 + (n % 500)));
      bridge.receive(state({ count: n }));
      bridge.receive('{"type":"pv:navigate"}');
    }

    advance(1);
    expect(heights.length).toBeLessThanOrEqual(1);
    advance(2000);
    bridge.close();
    expect(saved.get(id)).toEqual({ pv: 1, value: { count: 19_999 } });
    expect(heights.at(-1)).toBe(100 + (19_999 % 500));
    expect(heights.length).toBeLessThan(10);
  });

  test("a slider dragged at 60 Hz reaches the store with its final value", () => {
    const { id, saved, open, advance } = harness();
    const bridge = open();

    for (let rate = 0; rate <= 90; rate++) {
      bridge.receive(state({ rate }));
      advance(1000 / 60);
    }

    advance(1000);
    expect(saved.get(id)).toEqual({ pv: 1, value: { rate: 90 } });
    bridge.close();
  });

  test("a message over the size limit is dropped before it is parsed", () => {
    const { id, saved, open } = harness();
    const bridge = open();

    bridge.receive(state("x".repeat(FRAME_MESSAGE_MAX_BYTES)));
    bridge.close();
    expect(saved.has(id)).toBe(false);
  });

  test("closing the sheet writes the state the inline frame then reads back, and frees the writer", () => {
    const { id, saved, open } = harness("viz_sheet");
    const before = heldWriters();
    const inline = open();
    const sheet = open();

    inline.close();
    sheet.receive(state({ tab: 2 }));
    sheet.close();
    expect(saved.get(id)).toEqual({ pv: 1, value: { tab: 2 } });
    expect(heldWriters()).toBe(before);
  });

  test("after close, nothing more is handled", () => {
    const { heights, links, open, advance } = harness();
    const bridge = open();

    bridge.close();
    bridge.receive(height(300));
    bridge.receive(JSON.stringify({ type: "pv:open-link", url: "https://example.com" }));
    advance(1000);
    expect(heights).toEqual([]);
    expect(links).toEqual([]);
  });
});
