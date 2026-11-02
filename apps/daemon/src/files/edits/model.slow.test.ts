import { expect } from "bun:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  FileEditTrace,
  replayFileEditTrace,
} from "../../../../../packages/spec/scripts/replay-file-edits.ts";
import { fixture } from "./testing.ts";
import { InjectedCrash } from "./index.ts";
import { identity, loadJournal } from "./journal.ts";
import { currentVersion, sameVersion } from "../version.ts";
import type { Fault } from "./moves.ts";
import { posixTest } from "../../platform/testing.ts";

const test = posixTest("Quint's Rust evaluator ships no Windows build");

const phases = {
  pending: "Pending",
  forward: "Forward",
  applied: "Applied",
  backward: "Backward",
  restored: "Restored",
} as const;

/** Two Quint replays: past bun's 5 s default beside other test files. */
const QUINT_REPLAY_MS = 30_000;

test(
  "actual crash/recovery checkpoints replay against Quint; corrupted owned observation is rejected",
  async () => {
    const f = await fixture();

    try {
      const r = await f.request([{ kind: "rename", oldUri: f.uri("a"), newUri: f.uri("c") }]);
      const trace: typeof FileEditTrace.Type = { version: 1, source: "runtime", events: [] };
      const events: (typeof FileEditTrace.Type)["events"][number][] = [];
      const directory = join(f.home, "journal", identity(f.owner, "operation"));

      const token = async (path: string) => {
        const version = await currentVersion(path);

        if (!version) return "Missing";

        return sameVersion(version, r.proposal.snapshots[0]!.diskVersion) ? "Owned" : "External";
      };

      const observe = async (event: (typeof FileEditTrace.Type)["events"][number]["event"]) => {
        const journal = (await loadJournal(directory))!;
        events.push({
          event,
          phase: phases[journal.moves[0]!.state],
          source: await token(join(f.root, "a")),
          target: await token(join(f.root, "c")),
        });
      };

      const fault: Fault = async (point) => {
        if (point === "prepared") await observe("Prepare");

        if (point === "intent") await observe("Intent");

        if (point === "mutation") {
          await observe("Move");
          throw new InjectedCrash("restart");
        }
      };

      const failed = await f
        .coordinator(fault)
        .accept(f.owner, r.proposal, r.acceptance, r.drafts)
        .catch((cause: unknown) => cause);

      expect(failed).toBeInstanceOf(InjectedCrash);
      await observe("Crash");
      await f.coordinator().accept(f.owner, r.proposal, r.acceptance, r.drafts);
      await observe("Retry");
      const known = (await f.coordinator().get(f.owner, "operation"))!;

      const recovery = f.coordinator(async (point) => {
        if (point === "restore-intent") await observe("UndoIntent");

        if (point === "restore-mutation") await observe("Restore");
      });

      expect(
        (await recovery.recover(f.owner, "operation", known.receiptRevision, "recover")).state
      ).toBe("restored");
      await observe("PersistRestored");
      const recorded = { ...trace, events };
      const accepted = await replayFileEditTrace(recorded);
      expect(accepted.output).toContain("passing");
      expect(accepted.exitCode).toBe(0);

      const mutant = {
        ...recorded,
        events: events.map((event, index) =>
          index === 2 ? { ...event, target: "External" as const } : event
        ),
      };

      expect((await replayFileEditTrace(mutant)).exitCode).toBe(1);

      if (process.env.X1_TRACE_OUTPUT)
        await writeFile(process.env.X1_TRACE_OUTPUT, JSON.stringify(recorded, null, 2));
      expect(await readFile(join(f.root, "a"), "utf8")).toBe("alpha\r\n");
    } finally {
      await f.cleanup();
    }
  },
  QUINT_REPLAY_MS
);
