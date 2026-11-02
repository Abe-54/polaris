import { expect } from "bun:test";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TreeEditTrace,
  replayTreeEditTrace,
} from "../../../../../../packages/spec/scripts/replay-tree-edits.ts";
import { fixture } from "./testing.ts";
import { InjectedCrash } from "./index.ts";
import { identity, loadJournal } from "./journal.ts";
import { resourceIdentity, sameIdentity, sameTree, snapshotTree } from "./snapshot.ts";
import { posixTest } from "../../../platform/testing.ts";

/** Tree edits identify entries by inode and check the journal's mode; Windows offers neither. */
const test = posixTest(
  "Windows bug: NTFS file IDs exceed a safe integer for LanguageResourceIdentity.inode (ENG-296), and the journal privacy check reads POSIX modes (ENG-314)"
);

/** Two Quint replays per test, ~3 s alone: past bun's 5 s default beside other test files. */
const QUINT_REPLAY_MS = 30_000;

const phases = {
  pending: "Pending",
  forward: "Forward",
  applied: "Applied",
  backward: "Backward",
  restored: "Restored",
} as const;

for (const intervention of [false, true])
  test(
    `actual directory crash/recovery ownership trace intervention=${intervention}`,
    async () => {
      const f = await fixture();

      try {
        const r = await f.request(
          [{ kind: "rename", oldUri: f.uri("source"), newUri: f.uri("final") }],
          ["source", "final"]
        );

        const owned = r.proposal.resourceSnapshots[0]!.tree!;
        const directory = join(f.home, "journal", `tree-${identity(f.owner, "operation")}`);
        const events: (typeof TreeEditTrace.Type)["events"][number][] = [];

        const rootToken = async (name: string) => {
          const stat = await lstat(join(f.root, name)).catch(() => null);

          if (!stat) return "Missing";

          return stat.isDirectory() &&
            sameIdentity(owned.entries[0]!.identity, resourceIdentity(stat))
            ? "Owned"
            : "External";
        };

        const childToken = async (name: string, suffix: string) => {
          const tree = await snapshotTree(f.root, join(f.root, name, suffix));

          if (!tree) return "Missing";
          const expected = owned.entries.find((entry) => entry.relativePath === suffix)!;

          return sameTree(tree, { format: 1, entries: [{ ...expected, relativePath: "" }] })
            ? "Owned"
            : "External";
        };

        const observe = async (event: (typeof TreeEditTrace.Type)["events"][number]["event"]) => {
          const journal = (await loadJournal(directory))!;
          events.push({
            event,
            phase: phases[journal.moves[0]!.state],
            source: await rootToken("source"),
            target: await rootToken("final"),
            childSource: await childToken("source", "nested/file"),
            childTarget: await childToken("final", "nested/file"),
            otherSource: await childToken("source", "unicode-λ"),
            otherTarget: await childToken("final", "unicode-λ"),
          });
        };

        const c = f.coordinator({
          fault: async (point) => {
            if (point === "prepared") await observe("Prepare");

            if (point === "intent") await observe("Intent");

            if (point === "mutation") {
              await observe("Move");

              if (!intervention) throw new InjectedCrash();
            }

            if (point === "receipt") await observe("PersistApplied");
          },
        });

        const result = await c
          .accept(f.owner, r.proposal, r.acceptance, r.drafts)
          .catch((cause: unknown) => cause);

        if (!intervention) {
          expect(result).toBeInstanceOf(InjectedCrash);
          await observe("Crash");
          await f.coordinator().accept(f.owner, r.proposal, r.acceptance, r.drafts);
          await observe("Retry");
        } else {
          await writeFile(join(f.root, "final/nested/file"), "external");
          await observe("ExternalDescendant");
        }

        const current = (await f.coordinator().get(f.owner, "operation"))!;

        const recovery = f.coordinator({
          fault: async (point) => {
            if (point === "restore-intent") await observe("UndoIntent");

            if (point === "restore-mutation") await observe("Restore");
          },
        });

        const outcome = await recovery.recover(
          f.owner,
          "operation",
          current.receiptRevision,
          "recover"
        );

        expect(outcome.state).toBe(intervention ? "recovery-required" : "restored");
        await observe(intervention ? "UndoIntent" : "PersistRestored");
        const recorded = TreeEditTrace.make({ version: 2, source: "runtime", events });
        expect((await replayTreeEditTrace(recorded)).exitCode).toBe(0);

        const corrupted = {
          ...recorded,
          events: events.map((event, index) =>
            index === 2 ? { ...event, otherTarget: "External" as const } : event
          ),
        };

        expect((await replayTreeEditTrace(corrupted)).exitCode).toBe(1);

        if (process.env.X2_TRACE_OUTPUT)
          await writeFile(
            `${process.env.X2_TRACE_OUTPUT}-${intervention ? "intervention" : "recovery"}.json`,
            JSON.stringify(recorded, null, 2)
          );
      } finally {
        await f.cleanup();
      }
    },
    QUINT_REPLAY_MS
  );
