import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { removeTempDir, tempDir, write } from "../git/testing.ts";
import { nativeWatchesLive } from "./fsevents.ts";
import { watchRoot } from "./search/watch.ts";
import { subscribeDirectoryChanges } from "./watch.ts";

const roots: Array<string> = [];

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();

  for (const root of roots.splice(0)) removeTempDir(root);
});

const directory = (prefix: string) => {
  const path = tempDir(prefix);
  roots.push(path);

  return path;
};

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }

  return false;
};

// Bun on macOS rebuilds its one FSEvents stream whenever any watch opens or closes (ENG-370).
test.skipIf(process.platform !== "darwin")(
  "live watches recover a change made while another watch opens or closes",
  async () => {
    const busy = directory("polaris-busy-");
    stops.push(await watchRoot(busy, () => undefined));

    const tree = directory("polaris-live-tree-");
    let treeSeen: Array<string> = [];
    stops.push(await watchRoot(tree, (_event, path) => treeSeen.push(path)));

    const tab = directory("polaris-live-tab-");
    let tabSeen = 0;
    stops.push(subscribeDirectoryChanges(tab, () => tabSeen++));
    // Lets the probe for the tab watch finish, so its rescan lands before the first round.
    await nativeWatchesLive();

    let other: (() => void) | null = null;
    const missed: Array<string> = [];

    // Without the rescan, a few of these creations in each live watch are never reported.
    for (let i = 0; i < 30; i++) {
      for (let k = 0; k < 1000; k++) write(busy, `${k}.ts`, String(i));

      if (other === null) other = subscribeDirectoryChanges(directory("polaris-other-"), () => {});
      else {
        other();
        other = null;
      }

      treeSeen = [];
      tabSeen = 0;
      write(tree, `created-${i}.ts`, "");
      write(tab, `created-${i}.ts`, "");
      const created = join(tree, `created-${i}.ts`);

      if (!(await waitFor(() => treeSeen.includes(created) || treeSeen.includes(tree))))
        missed.push(`tree ${i}`);

      if (!(await waitFor(() => tabSeen > 0))) missed.push(`tab ${i}`);
    }

    other?.();
    expect(missed).toEqual([]);
  },
  240_000
);
