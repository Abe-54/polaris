import { describe, expect, test } from "bun:test";
import { type Candidate, createWatcher, type WatchEntry } from "./watcher.ts";

const CONFIG = '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n';

const setup = (saved: Record<string, { path: string; remotes: ReadonlyArray<string> }> = {}) => {
  const sent: Array<ReadonlyArray<WatchEntry>> = [];
  const reads: Array<string> = [];
  let stored = saved;
  let config = CONFIG;

  const watcher = createWatcher({
    read: (hostKey) => async (path) => {
      reads.push(`${hostKey}:${path}`);

      return path === "/code/widgets/.git/config" ? config : null;
    },
    watch: (entries) => sent.push(entries),
    load: () => stored,
    save: (known) => {
      stored = known;
    },
  });

  const setConfig = (text: string) => {
    config = text;
  };

  return { watcher, sent, reads, stored: () => stored, setConfig };
};

const candidate = (patch: Partial<Candidate> = {}): Candidate => ({
  hostKey: "local",
  workspaceId: "w1",
  path: "/code/widgets",
  readable: true,
  ...patch,
});

describe("createWatcher", () => {
  test("reads a connected Workspace's remotes once and watches them", async () => {
    const { watcher, sent, reads, stored } = setup();

    await watcher.update([candidate(), candidate({ workspaceId: "w2", path: "/code/plain" })]);
    await watcher.update([candidate(), candidate({ workspaceId: "w2", path: "/code/plain" })]);

    expect(sent.at(-1)).toEqual([
      {
        workspace: { hostKey: "local", workspaceId: "w1" },
        remotes: ["git@github.com:acme/widgets.git"],
      },
    ]);
    expect(reads.filter((r) => r === "local:/code/widgets/.git/config")).toHaveLength(1);
    expect(Object.keys(stored())).toEqual(["local/w1", "local/w2"]);
  });

  test("a Host that is away keeps the remotes read before", async () => {
    const { watcher, sent, reads } = setup({
      "pi/w1": { path: "/code/widgets", remotes: ["https://github.com/acme/widgets"] },
    });

    await watcher.update([candidate({ hostKey: "pi", readable: false })]);

    expect(reads).toEqual([]);
    expect(sent).toEqual([
      [
        {
          workspace: { hostKey: "pi", workspaceId: "w1" },
          remotes: ["https://github.com/acme/widgets"],
        },
      ],
    ]);
  });

  test("a Workspace that moved doesn't use its old remotes; one that went is unwatched", async () => {
    const { watcher, sent } = setup({
      "pi/w1": { path: "/old", remotes: ["https://github.com/acme/widgets"] },
    });

    await watcher.update([candidate({ hostKey: "pi", readable: false })]);
    expect(sent).toEqual([[]]);

    await watcher.update([candidate()]);
    await watcher.update([]);
    expect(sent.at(-1)).toEqual([]);
  });

  test("a remote added after the first read is watched once rechecked (ENG-723)", async () => {
    const { watcher, sent, setConfig } = setup();

    setConfig("[core]\n\tbare = false\n");
    await watcher.update([candidate()]);
    setConfig(CONFIG);
    await watcher.update([candidate()]);
    expect(sent.at(-1)).toEqual([]);

    await watcher.recheck();
    expect(sent.at(-1)).toEqual([
      {
        workspace: { hostKey: "local", workspaceId: "w1" },
        remotes: ["git@github.com:acme/widgets.git"],
      },
    ]);
  });
});
