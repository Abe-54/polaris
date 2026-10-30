import { describe, expect, test } from "bun:test";
import type { BrowserTabId } from "../../shared/browserContract.ts";
import { tabLoads } from "./loads.ts";

// SAFETY: a test id; the brand only marks where it came from.
const TAB = "tab-1" as BrowserTabId;

/** A partition setup the test settles by hand, one per load. */
const deferred = () => Promise.withResolvers<void>();

const setup = () => {
  const setups: Array<ReturnType<typeof deferred>> = [];
  const log: Array<string> = [];

  const loads = tabLoads({
    ready: () => {
      const next = deferred();

      setups.push(next);

      return next.promise;
    },
    open: (_tabId, url) => log.push(`open ${url}`),
    fail: (_tabId, url) => log.push(`failed ${url}`),
  });

  return { loads, setups, log };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a tab's loads", () => {
  test("the first load waits for the partition's setup", async () => {
    const { loads, setups, log } = setup();

    loads.load(TAB, "http://localhost:3000/");
    await tick();
    const before = [...log];

    setups[0]!.resolve();
    await tick();

    expect([before, log]).toEqual([[], ["open http://localhost:3000/"]]);
  });

  test("a failed setup loads nothing, and a reload sets up again and loads", async () => {
    const { loads, setups, log } = setup();

    loads.load(TAB, "http://localhost:3000/");
    setups[0]!.reject(new Error("setProxy failed"));
    await tick();
    const retry = loads.failedUrl(TAB);

    loads.load(TAB, retry ?? "");
    setups[1]!.resolve();
    await tick();

    expect(log).toEqual(["failed http://localhost:3000/", "open http://localhost:3000/"]);
    expect(loads.failedUrl(TAB)).toBe(null);
  });

  test("a later load wins over one still waiting", async () => {
    const { loads, setups, log } = setup();

    loads.load(TAB, "http://localhost:3000/");
    loads.load(TAB, "http://localhost:5173/");
    setups[1]!.resolve();
    setups[0]!.resolve();
    await tick();

    expect(log).toEqual(["open http://localhost:5173/"]);
  });

  test("back, forward and reload wait for setup too, and a failed setup runs none of them", async () => {
    const { loads, setups, log } = setup();

    loads.step(TAB, "http://localhost:3000/", () => log.push("back"));
    await tick();
    const before = [...log];

    setups[0]!.reject(new Error("setProxy failed"));
    await tick();

    expect(before).toEqual([]);
    expect(log).toEqual(["failed http://localhost:3000/"]);
    expect(loads.failedUrl(TAB)).toBe("http://localhost:3000/");
  });

  test("retired routing drops a load still waiting and shows the failure", async () => {
    const { loads, setups, log } = setup();

    loads.load(TAB, "http://localhost:3000/");
    loads.retire(TAB, "http://localhost:3000/", new Error("rpi was removed"));
    setups[0]!.resolve();
    await tick();

    expect(log).toEqual(["failed http://localhost:3000/"]);
  });
});
