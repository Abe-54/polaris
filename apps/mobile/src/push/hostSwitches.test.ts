import { describe, expect, test } from "bun:test";
import { createHostSwitches } from "./hostSwitches.ts";

const storage = (stored: string | null) => {
  const saved: Array<string> = [];

  let resolve: (value: string | null) => void = () => {};

  const load = new Promise<string | null>((r) => (resolve = r));

  return {
    saved,
    loaded: async () => {
      resolve(stored);
      await load;
      await Promise.resolve();
    },
    storage: { load: () => load, save: async (value: string) => void saved.push(value) },
  };
};

describe("this iPhone's switch per host", () => {
  test("each host is on until stored off, and one host's switch leaves the others", async () => {
    const s = storage(JSON.stringify(["studio"]));
    const switches = createHostSwitches(s.storage);

    expect(switches.get("studio")).toBe(true);
    await s.loaded();
    expect([switches.get("studio"), switches.get("rpi")]).toEqual([false, true]);
  });

  test("a change before the load wins for that host; the stored rest still loads", async () => {
    const s = storage(JSON.stringify(["studio", "rpi"]));
    const switches = createHostSwitches(s.storage);

    switches.set("studio", false);
    switches.set("studio", true);
    await s.loaded();

    expect([switches.get("studio"), switches.get("rpi")]).toEqual([true, false]);
  });

  test("turning a host off is saved and changes the key, so registrations go again", () => {
    const s = storage(null);
    const switches = createHostSwitches(s.storage);
    const before = switches.key();

    switches.set("rpi", false);

    expect(s.saved).toEqual([JSON.stringify(["rpi"])]);
    expect(switches.key()).not.toBe(before);
  });

  test("a damaged stored value leaves every host on", async () => {
    const s = storage("{not json");
    const switches = createHostSwitches(s.storage);

    await s.loaded();
    expect(switches.get("studio")).toBe(true);
  });
});
