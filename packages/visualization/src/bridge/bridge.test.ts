import { describe, expect, test } from "bun:test";
import {
  boundedJson,
  coalesced,
  frameInbox,
  type FrameLane,
  laneOfText,
  laneOfType,
  LINK_CONFIRM_COOLDOWN_MS,
  LINK_CONFIRM_MAX_DECLINED,
  linkConfirms,
} from "./index.ts";

/** A clock the test moves by hand; scheduled runs fire when time passes them. */
const manualClock = () => {
  let now = 0;
  const due: Array<{ at: number; run: () => void }> = [];

  return {
    now: () => now,
    schedule: (run: () => void, ms: number) => {
      const entry = { at: now + ms, run };

      due.push(entry);

      return () => {
        const index = due.indexOf(entry);

        if (index >= 0) due.splice(index, 1);
      };
    },
    advance: (ms: number) => {
      const end = now + ms;

      for (;;) {
        const next = due.filter((entry) => entry.at <= end).sort((a, b) => a.at - b.at)[0];

        if (next === undefined) break;
        due.splice(due.indexOf(next), 1);
        now = next.at;
        next.run();
      }

      now = end;
    },
    pending: () => due.length,
  };
};

type Message = { readonly lane: "height" | "state" | "other"; readonly n: number };

const inbox = (rate: number) => {
  const clock = manualClock();
  const handled: Array<Message> = [];
  const box = frameInbox<Message>((message) => handled.push(message), clock, rate);
  const send = (lane: Message["lane"], n: number) => box.receive(lane, { lane, n });

  return { clock, handled, box, send };
};

describe("frame inbox", () => {
  test("a flood is handled at the rate, and the last height and state still arrive", () => {
    const { clock, handled, send } = inbox(10);

    for (let n = 0; n < 10_000; n++) send(n % 2 === 0 ? "height" : "state", n);

    expect(handled).toHaveLength(10);
    clock.advance(1000);
    expect(handled.length).toBeLessThanOrEqual(12);
    expect(handled.slice(-2).map(({ n }) => n)).toEqual([9998, 9999]);
    expect(clock.pending()).toBe(0);
  });

  test("over the rate, other messages (links, unknown kinds) are dropped, not queued", () => {
    const { clock, handled, send } = inbox(2);

    for (let n = 0; n < 50; n++) send("other", n);
    clock.advance(10_000);
    expect(handled.map(({ n }) => n)).toEqual([0, 1]);
  });

  test("a slider dragged within the rate is handled message by message, in order", () => {
    const { clock, handled, send } = inbox(240);

    for (let n = 0; n < 120; n++) {
      send("state", n);
      clock.advance(1000 / 60);
    }

    expect(handled.map(({ n }) => n)).toEqual(Array.from({ length: 120 }, (_, n) => n));
  });

  test("flush hands over the waiting state at once; dispose drops it and its timer", () => {
    const flushed = inbox(1);

    flushed.send("state", 1);
    flushed.send("state", 2);
    flushed.box.flush();
    expect(flushed.handled.map(({ n }) => n)).toEqual([1, 2]);

    const disposed = inbox(1);

    disposed.send("state", 1);
    disposed.send("state", 2);
    disposed.box.dispose();
    disposed.clock.advance(10_000);
    expect(disposed.handled.map(({ n }) => n)).toEqual([1]);
    expect(disposed.clock.pending()).toBe(0);
  });
});

describe("message lanes", () => {
  test.each<[string, FrameLane]>([
    ['{"type":"pv:height","height":3}', "height"],
    [' { "type" : "pv:state", "state": {} }', "state"],
    ['{"type":"pv:open-link","url":"https://a"}', "other"],
    ['{"height":3,"type":"pv:height"}', "other"],
    ['{"type":"constructor"}', "other"],
    ["not json", "other"],
  ])("%s goes in the %s lane", (text, lane) => {
    expect(laneOfText(text)).toBe(lane);
  });

  test("a type inherited from Object.prototype is not a lane", () => {
    expect(laneOfType("toString")).toBe("other");
    expect(laneOfType("pv:state")).toBe("state");
  });
});

describe("coalesced heights", () => {
  test("many heights in one frame deliver once, the latest; an unchanged one not again", () => {
    const ticks: Array<() => void> = [];
    const delivered: Array<number> = [];

    const heights = coalesced<number>(
      (height) => delivered.push(height),
      (run) => {
        ticks.push(run);

        return () => ticks.splice(ticks.indexOf(run), 1);
      }
    );

    const tick = () => ticks.splice(0).forEach((run) => run());

    for (let height = 100; height < 1100; height++) heights.offer(height);
    tick();
    heights.offer(1099);
    tick();
    heights.offer(300);
    tick();
    expect(delivered).toEqual([1099, 300]);
  });

  test("cancel (unmount) drops a pending height", () => {
    const ticks: Array<() => void> = [];
    const delivered: Array<number> = [];

    const heights = coalesced<number>(
      (height) => delivered.push(height),
      (run) => {
        ticks.push(run);

        return () => ticks.splice(ticks.indexOf(run), 1);
      }
    );

    heights.offer(200);
    heights.cancel();
    ticks.splice(0).forEach((run) => run());
    expect(delivered).toEqual([]);
  });
});

describe("bounded JSON", () => {
  test("a value within the limit is its JSON", () => {
    const state = { pv: 1, value: { rate: 5.5 }, tabs: { t: 1 } };

    expect(boundedJson(state, 1024)).toBe(JSON.stringify(state));
  });

  test("a huge value stops the walk early instead of serialising it whole", () => {
    let visited = 0;

    const huge = Array.from({ length: 200_000 }, (_, n) => ({
      get n() {
        visited += 1;

        return n;
      },
    }));

    expect(boundedJson(huge, 16 * 1024)).toBeNull();
    expect(visited).toBeLessThan(5000);
  });

  test("one long string over the limit is refused", () => {
    expect(boundedJson({ value: "x".repeat(20_000) }, 16 * 1024)).toBeNull();
  });

  test("what isn't JSON is refused", () => {
    expect(boundedJson(1n, 1024)).toBeNull();
    expect(boundedJson(undefined, 1024)).toBeNull();
  });
});

describe("link confirms", () => {
  const confirms = () => {
    let now = 0;
    const links = linkConfirms(() => now);

    return {
      links,
      wait: (ms: number) => {
        now += ms;
      },
    };
  };

  test("while one confirm is open, a flood of requests shows no other", () => {
    const { links } = confirms();

    expect(links.request()).toBe(true);
    expect(Array.from({ length: 1000 }, links.request).filter(Boolean)).toEqual([]);
  });

  test("after a confirm closes the frame waits the cooldown before asking again", () => {
    const { links, wait } = confirms();

    links.request();
    links.settled(true);
    expect(links.request()).toBe(false);
    wait(LINK_CONFIRM_COOLDOWN_MS);
    expect(links.request()).toBe(true);
  });

  test("after enough declines in a row the frame can't ask again; an opened link resets it", () => {
    const { links, wait } = confirms();

    const decline = () => {
      wait(LINK_CONFIRM_COOLDOWN_MS);
      expect(links.request()).toBe(true);
      links.settled(false);
    };

    for (let n = 1; n < LINK_CONFIRM_MAX_DECLINED; n++) decline();
    wait(LINK_CONFIRM_COOLDOWN_MS);
    links.request();
    links.settled(true);

    for (let n = 0; n < LINK_CONFIRM_MAX_DECLINED; n++) decline();
    wait(60_000);
    expect(links.request()).toBe(false);
  });
});
