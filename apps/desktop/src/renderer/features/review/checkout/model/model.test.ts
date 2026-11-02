import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReviewCheckout,
  ReviewCheckoutBlock,
  ReviewCheckoutBlocker,
  ReviewCheckoutId,
  SessionId,
  WorkspaceId,
} from "@polaris/protocol";
import type { ReviewSubject } from "@polaris/protocol";
import { Data } from "effect";
import type { CheckoutStateView } from "../../../../../shared/github.ts";
import {
  blockView,
  chipAction,
  type ChipInput,
  chipView,
  elapsed,
  fetchingText,
  inSentence,
  newCommitsText,
  removedText,
} from "./chip.ts";
import { cloneCommand, clonePath, cloneTransport, cloneUrls, shellQuote } from "./clone.ts";
import { loginShellArgv, runCommandOf, runningFact } from "./run.ts";
import { hostChoices, orderPlaces, type PlaceHost, placeToOpen } from "./hosts.ts";
import { CLOSED_GRACE_MS, decide, actionKey, watchKey, watchList } from "./watch.ts";

const Subjects = Data.taggedEnum<ReviewSubject>();

const checkout = (patch: Partial<ReviewCheckout> = {}) =>
  new ReviewCheckout({
    id: ReviewCheckoutId.make("c1"),
    workspaceId: WorkspaceId.make("w1"),
    subject: Subjects.PullRequest({
      pullRequest: { repo: { host: "github.com", owner: "Acme", name: "widgets" }, number: 42 },
      baseRef: "main",
    }),
    path: "/repo.worktrees/.review/pr-42",
    state: "ready",
    blocked: null,
    head: "4f2c1a9e0000",
    mergeBase: "b1",
    latestHead: "4f2c1a9e0000",
    latestBase: "b0",
    reviewedHead: null,
    reviewedMergeBase: null,
    openedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  });

const blocked = (during: "fetch" | "update" | "remove", blocker: ReviewCheckoutBlocker) =>
  checkout({ state: "blocked", blocked: new ReviewCheckoutBlock({ during, blocker }) });

const input = (patch: Partial<ChipInput> = {}): ChipInput => ({
  checkout: checkout(),
  host: { label: "Linux VM", state: "connected", since: 0 },
  places: 2,
  firstConnected: "Mac Studio",
  firstPlace: "Linux VM",
  removed: null,
  now: 0,
  command: null,
  run: null,
  newCommits: null,
  fetchingCommits: null,
  clone: null,
  ...patch,
});

describe("chipView", () => {
  test("follows the checkout's state on a connected Host", () => {
    expect(chipView(input({ checkout: checkout({ state: "fetching", head: null }) }))).toEqual({
      kind: "checking-out",
      host: "Linux VM",
      commits: null,
    });
    expect(
      chipView(input({ checkout: checkout({ state: "fetching", head: null }), fetchingCommits: 3 }))
    ).toMatchObject({ kind: "checking-out", commits: 3 });
    expect(chipView(input())).toEqual({
      kind: "ready",
      host: "Linux VM",
      at: "4f2c1a9",
      command: null,
    });
    expect(
      chipView(input({ checkout: checkout({ state: "stale", latestHead: "9e07b3c" }) }))
    ).toEqual({
      kind: "new-commits",
      host: "Linux VM",
      at: "4f2c1a9",
      latest: "9e07b3c",
      count: null,
      rewritten: false,
    });
    expect(
      chipView(input({ checkout: checkout({ state: "fetching", latestHead: "9e07b3c11" }) }))
    ).toEqual({
      kind: "updating",
      host: "Linux VM",
      to: "9e07b3c",
    });
    expect(chipView(input({ checkout: checkout({ state: "removing" }) })).kind).toBe("removing");
  });

  test("a Host away wins over the recorded state", () => {
    const reconnecting = chipView(
      input({ host: { label: "Linux VM", state: "reconnecting", since: 1000 }, now: 41_000 })
    );

    expect(reconnecting).toEqual({
      kind: "reconnecting",
      host: "Linux VM",
      at: "4f2c1a9",
      seconds: 40,
    });

    const offline = chipView(input({ host: { label: "Linux VM", state: "offline", since: 0 } }));

    expect(offline).toEqual({ kind: "offline", host: "Linux VM", next: "Mac Studio" });
    expect(chipAction(offline)).toEqual({ kind: "move", label: "Check out on Mac Studio" });
    expect(
      chipAction(
        chipView(
          input({ host: { label: "Linux VM", state: "offline", since: 0 }, firstConnected: null })
        )
      )
    ).toBeNull();
  });

  test("without a checkout: removed, waiting, or no Workspace has the repo", () => {
    expect(
      chipView(input({ checkout: null, removed: { host: "Linux VM", reason: "merged" } }))
    ).toEqual({
      kind: "removed",
      host: "Linux VM",
      reason: "merged",
    });
    expect(chipView(input({ checkout: null, firstConnected: null }))).toEqual({
      kind: "waiting",
      host: "Linux VM",
    });
    expect(chipView(input({ checkout: null, places: 0 }))).toEqual({ kind: "none" });
  });

  test("new commits offer Update; nothing else does", () => {
    expect(chipAction(chipView(input({ checkout: checkout({ state: "stale" }) })))).toEqual({
      kind: "update",
      label: "Update",
    });
    expect(chipAction(chipView(input()))).toBeNull();
  });
});

describe("blockView: each blocker has its one fix", () => {
  const view = (c: ReviewCheckout) => {
    const chip = chipView(input({ checkout: c }));

    if (chip.kind !== "blocked") throw new Error(`expected blocked, got ${chip.kind}`);

    return chip.block;
  };

  test("edits: discard before an update or a removal, after asking", () => {
    const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
    const update = view(blocked("update", ReviewCheckoutBlocker.cases.Dirty.make({ paths })));

    expect(update.fix.kind).toBe("discard-update");
    expect(update.confirm).toBe("Discard 6 changed files?");
    expect(update.evidence).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "and 2 more"]);

    const remove = view(
      blocked("remove", ReviewCheckoutBlocker.cases.Dirty.make({ paths: ["a.ts"] }))
    );

    expect(remove.fix.kind).toBe("discard-remove");
    expect(remove.confirm).toBe("Discard 1 changed file?");
  });

  test("local commits open a terminal; nothing is discarded", () => {
    const block = view(
      blocked("update", ReviewCheckoutBlocker.cases.LocalCommits.make({ count: 2 }))
    );

    expect(block).toMatchObject({ title: "2 local commits in the checkout", confirm: null });
    expect(block.fix.kind).toBe("open-terminal");
  });

  test("in use: the session, else the terminal", () => {
    const session = view(
      blocked(
        "remove",
        ReviewCheckoutBlocker.cases.InUse.make({ sessionIds: [SessionId.make("s1")], terminals: 1 })
      )
    );

    expect(session.fix).toEqual({
      kind: "show-session",
      label: "Show session",
      sessionId: SessionId.make("s1"),
    });

    const terminal = view(
      blocked("remove", ReviewCheckoutBlocker.cases.InUse.make({ sessionIds: [], terminals: 2 }))
    );

    expect(terminal.fix.kind).toBe("show-terminal");
  });

  test("a shallow clone fetches full history, only when asked", () => {
    const block = view(blocked("fetch", ReviewCheckoutBlocker.cases.ShallowClone.make({})));

    expect(block.title).toBe("This workspace is a shallow clone");
    expect(block.fix.kind).toBe("fetch-full");
  });

  test("a failed fetch retries; a missing ssh agent says so", () => {
    const denied = blockView(
      new ReviewCheckoutBlock({
        during: "fetch",
        blocker: ReviewCheckoutBlocker.cases.FetchFailed.make({
          message: "git fetch: Permission denied (publickey)",
        }),
      }),
      "Linux VM"
    );

    expect(denied).toMatchObject({
      title: "Couldn’t check out on Linux VM",
      evidence: ["git fetch: Permission denied (publickey)"],
      fix: { kind: "retry" },
    });

    const agent = blockView(
      new ReviewCheckoutBlock({
        during: "fetch",
        blocker: ReviewCheckoutBlocker.cases.FetchFailed.make({
          message:
            "ssh could not authenticate on this Host (the Daemon has no SSH agent: SSH_AUTH_SOCK is not set): denied",
        }),
      }),
      "Linux VM"
    );

    expect(agent.title).toBe("No ssh agent on Linux VM");
    expect(agent.fix.kind).toBe("retry");
  });
});

test("removedText and elapsed", () => {
  expect(removedText("merged", "Linux VM")).toBe("Merged · checkout removed from Linux VM");
  expect(removedText("user", "Linux VM")).toBe("Checkout removed from Linux VM");
  expect([elapsed(40), elapsed(130), elapsed(7300)]).toEqual(["40s", "2m", "2h"]);
});

describe("hosts", () => {
  const places = [
    { hostKey: "studio", workspaceId: "w1" },
    { hostKey: "vm", workspaceId: "w2" },
    { hostKey: "local", workspaceId: "w3" },
    { hostKey: "vm", workspaceId: "w4" },
  ];

  const hosts: ReadonlyArray<PlaceHost> = [
    { key: "studio", label: "Mac Studio", local: false, state: "connected", latencyMs: 4 },
    { key: "vm", label: "Linux VM", local: false, state: "connected", latencyMs: 18.4 },
    { key: "local", label: "MacBook Pro", local: true, state: "offline", latencyMs: null },
  ];

  test("the last used Host comes first, then the list's order", () => {
    expect(orderPlaces(places, "vm").map((p) => p.workspaceId)).toEqual(["w2", "w4", "w1", "w3"]);
    expect(orderPlaces(places, null)).toBe(places);
  });

  test("a pull request opens on the last used Host when connected, else the first connected", () => {
    const connected = (key: string) => key !== "local";

    expect(placeToOpen(places, "vm", connected)?.hostKey).toBe("vm");
    expect(placeToOpen(places, "local", connected)?.hostKey).toBe("studio");
    expect(placeToOpen(places, null, () => false)).toBeNull();
  });

  test("one row per Host, with what it holds and how far it is", () => {
    const names = new Map([
      ["w1", "nj-homes-choice"],
      ["w2", "nj-homes"],
      ["w3", "nj-homes"],
    ]);

    const rows = hostChoices({
      places,
      hosts,
      workspaceName: (p) => names.get(p.workspaceId) ?? null,
      lastHostKey: "vm",
      currentHostKey: "vm",
    });

    expect(rows).toEqual([
      expect.objectContaining({
        label: "Linux VM",
        caption: "last used · nj-homes",
        trailing: "18 ms",
        current: true,
      }),
      expect.objectContaining({
        label: "Mac Studio",
        caption: "nj-homes-choice",
        trailing: "4 ms",
        current: false,
      }),
      expect.objectContaining({
        label: "MacBook Pro",
        caption: "this Mac · nj-homes",
        trailing: "offline",
        enabled: false,
      }),
    ]);
  });
});

describe("watch", () => {
  const held = [{ hostKey: "vm", checkout: checkout() }];
  const key = watchKey("vm", checkout());

  const view = (patch: Partial<CheckoutStateView>): CheckoutStateView => ({
    key,
    pullId: "PR_42",
    state: "open",
    headRefOid: "4f2c1a9e0000",
    closedAt: null,
    ...patch,
  });

  test("watches pull request checkouts whose node id is known", () => {
    expect(watchList(held, { "acme/widgets#42": "PR_42" })).toEqual([
      { key, pull: { repo: { owner: "Acme", name: "widgets" }, number: 42 }, pullId: "PR_42" },
    ]);
    expect(watchList(held, {})).toEqual([]);
  });

  test("a new head is reported once", () => {
    const [action] = decide([view({ headRefOid: "9e07b3" })], held, new Map(), 0);

    expect(action).toMatchObject({ kind: "report", head: "9e07b3", base: "b0" });
    expect(
      decide([view({ headRefOid: "9e07b3" })], held, new Map([[key, actionKey(action!)]]), 0)
    ).toEqual([]);
    expect(decide([view({})], held, new Map(), 0)).toEqual([]);
  });

  test("merged removes at once; closed waits for the grace period", () => {
    expect(decide([view({ state: "merged" })], held, new Map(), 0)).toEqual([
      expect.objectContaining({ kind: "remove", reason: "merged" }),
    ]);

    const closedAt = "2026-10-01T00:00:00.000Z";
    const at = Date.parse(closedAt);

    expect(decide([view({ state: "closed", closedAt })], held, new Map(), at + 1000)).toEqual([]);
    expect(
      decide([view({ state: "closed", closedAt })], held, new Map(), at + CLOSED_GRACE_MS)
    ).toEqual([expect.objectContaining({ kind: "remove", reason: "closed" })]);
  });

  test("a checkout being removed, or an unknown one, gets nothing", () => {
    const removing = [{ hostKey: "vm", checkout: checkout({ state: "removing" }) }];

    expect(decide([view({ state: "merged" })], removing, new Map(), 0)).toEqual([]);
    expect(decide([view({ key: "other", state: "merged" })], held, new Map(), 0)).toEqual([]);
  });
});

describe("Run", () => {
  test("ready offers Run when the checkout has something to run; running offers Stop", () => {
    const ready = chipView(input({ command: "bun run dev" }));

    expect(chipAction(ready)).toEqual({ kind: "run", label: "Run" });

    const running = chipView(
      input({ command: "bun run dev", run: { command: "bun run dev", startedAt: 0 }, now: 125_000 })
    );

    expect(running).toEqual({
      kind: "running",
      host: "Linux VM",
      command: "bun run dev",
      seconds: 125,
    });
    expect(chipAction(running)).toEqual({ kind: "stop", label: "Stop" });
    expect(runningFact("bun run dev", 125)).toBe("bun run dev · 2m");
  });

  test("new commits win over a run: the chip offers Update", () => {
    const view = chipView(
      input({
        checkout: checkout({ state: "stale" }),
        run: { command: "bun run dev", startedAt: 0 },
        newCommits: { total: 2, rewritten: false },
      })
    );

    expect(view).toMatchObject({ kind: "new-commits", count: 2 });
    expect(chipAction(view)?.kind).toBe("update");
  });

  test("the command is the dev script, else start, with the lockfile's package manager", () => {
    const both = JSON.stringify({ scripts: { dev: "vite", start: "node ." } });

    expect(runCommandOf(both, new Set(["bun.lock"]))).toBe("bun run dev");
    expect(
      runCommandOf(JSON.stringify({ scripts: { start: "node ." } }), new Set(["pnpm-lock.yaml"]))
    ).toBe("pnpm run start");
    expect(runCommandOf(both, new Set())).toBe("npm run dev");
    expect(runCommandOf(JSON.stringify({ scripts: { test: "x" } }), new Set())).toBeNull();
    expect(runCommandOf("not json", new Set())).toBeNull();
    expect(runCommandOf(null, new Set())).toBeNull();
  });

  test("it runs through the user's login shell", () => {
    expect(loginShellArgv("bun run dev")).toEqual([
      "/bin/sh",
      "-c",
      'exec "${SHELL:-/bin/sh}" -lc "$0"',
      "bun run dev",
    ]);
  });
});

test("a first checkout counts the commits it fetches once GitHub has", () => {
  expect([fetchingText(null), fetchingText(1), fetchingText(3)]).toEqual([
    "fetching",
    "fetching 1 commit",
    "fetching 3 commits",
  ]);
});

test("new commits read with their count, or as a force-push", () => {
  expect(newCommitsText(null, false)).toBe("new commits");
  expect(newCommitsText(1, false)).toBe("1 new commit");
  expect(newCommitsText(2, false)).toBe("2 new commits");
  expect(newCommitsText(3, true)).toBe("force-pushed");
});

describe("Clone on…", () => {
  test("no Workspace has the repo: the chip offers Clone on…; a clone shows until matched", () => {
    const none = chipView(input({ checkout: null, places: 0 }));

    expect(chipAction(none)).toEqual({ kind: "clone", label: "Clone on…" });

    const clone = { host: "Linux VM", status: "cloning" as const, message: null };

    expect(chipView(input({ checkout: null, places: 0, clone }))).toEqual({
      kind: "cloning",
      host: "Linux VM",
    });
    expect(
      chipView(input({ checkout: null, places: 0, clone: { ...clone, status: "added" } })).kind
    ).toBe("cloning");

    const failed = chipView(
      input({
        checkout: null,
        places: 0,
        clone: { ...clone, status: "failed", message: "exit 128" },
      })
    );

    expect(failed).toEqual({ kind: "clone-failed", host: "Linux VM", message: "exit 128" });
    expect(chipAction(failed)).toEqual({ kind: "retry-clone", label: "Retry" });
  });

  test("into ~/code, quoted for sh", () => {
    expect(clonePath("/home/lucas/", "widgets", 1)).toBe("/home/lucas/code/widgets");
    expect(clonePath("/home/lucas", "widgets", 2)).toBe("/home/lucas/code/widgets-2");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  test.each([
    ["an ssh remote on the code host", ["git@github.com:acme/api.git"], "ssh"],
    ["an ssh:// remote on the code host", ["ssh://git@GitHub.com/acme/api"], "ssh"],
    ["only https remotes (ENG-724)", ["https://github.com/luxdotdev/polaris.git"], "https"],
    ["https with a user", ["https://lucas@github.com/acme/api.git"], "https"],
    ["ssh only to another host", ["git@gitlab.com:acme/api.git"], "https"],
    ["no remotes", [], "https"],
  ] as const)("clones over the transport the Host already uses: %s", (_, remotes, transport) => {
    expect(cloneTransport(remotes, "github.com")).toBe(transport);
  });

  test("a clone the first transport can't reach falls back to the other (ENG-724)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clone-"));
    const path = join(dir, "code", "widgets");

    // A git whose ssh is refused, as with a key for another account.
    writeFileSync(
      join(dir, "git"),
      '#!/bin/sh\ncase "$2" in git@*) exit 128;; esac\nmkdir -p "$3" && echo "$2" > "$3/from"\n'
    );
    chmodSync(join(dir, "git"), 0o755);

    const command = cloneCommand(cloneUrls("github.com", "acme", "widgets", "ssh"), path);
    const proc = Bun.spawn(["sh", "-c", command], { env: { PATH: `${dir}:/bin:/usr/bin` } });

    expect(await proc.exited).toBe(0);
    expect(readFileSync(join(path, "from"), "utf8").trim()).toBe(
      "https://github.com/acme/widgets.git"
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

test("the local Host's default name is lowercased inside a sentence", () => {
  expect([inSentence("This Mac"), inSentence("Linux VM")]).toEqual(["this Mac", "Linux VM"]);

  const ready = chipView(input({ host: { label: "This Mac", state: "connected", since: 0 } }));

  expect(ready).toMatchObject({ kind: "ready", host: "This Mac" });
  expect(removedText("merged", "This Mac")).toBe("Merged · checkout removed from this Mac");
  expect(
    blockView(
      new ReviewCheckoutBlock({
        during: "remove",
        blocker: ReviewCheckoutBlocker.cases.Dirty.make({ paths: ["a.ts"] }),
      }),
      "This Mac"
    ).title
  ).toBe("Edits in the checkout on this Mac");
});
