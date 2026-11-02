import { expect, test } from "bun:test";
import { workerPhase, type WorkerPhaseInput } from "./workerPhase.ts";

const NOW = Date.parse("2026-10-02T22:46:00.000Z");

const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const base: WorkerPhaseInput = {
  setup: { status: "completed", startedAt: ago(23), endedAt: ago(22) },
  slot: { kind: "held", since: ago(12) },
  firstTurn: false,
  turnInFlight: false,
  startedAt: ago(22),
  now: NOW,
};

const WAITING = {
  tasks: [{ kind: "command" as const, description: "bun test" }],
  on: null,
  since: ago(4),
  until: NOW + 60_000,
};

test.each<[string, Partial<WorkerPhaseInput>, ReturnType<typeof workerPhase>]>([
  // ENG-263's incident: setup done 22m ago, a slot held 12m, no Turn ever.
  ["stalled on a held slot", {}, { kind: "stalled", since: ago(12), setupDone: true }],
  [
    "starting just after a restart reacquired the slot",
    { slot: { kind: "held", since: ago(0.2) } },
    { kind: "starting", since: ago(0.2), setupDone: true, afterTurn: false },
  ],
  [
    "starting behind an older Turn of a reused Session",
    { turnInFlight: true },
    { kind: "starting", since: ago(12), setupDone: true, afterTurn: true },
  ],
  [
    "never stalled without a held slot",
    { slot: null, setup: null },
    { kind: "starting", since: ago(22), setupDone: false, afterTurn: false },
  ],
  [
    "waiting for a slot",
    { slot: { kind: "queued", since: ago(3) } },
    { kind: "waiting-for-slot", since: ago(3) },
  ],
  [
    "a deferred setup running after the Attempt started",
    { setup: { status: "running", startedAt: ago(1), endedAt: null } },
    { kind: "setup-running", since: ago(1) },
  ],
  [
    "a deferred setup that failed",
    { setup: { status: "failed", startedAt: ago(1), endedAt: ago(0.5) } },
    { kind: "setup-failed" },
  ],
  ["working", { firstTurn: true, turnInFlight: true }, { kind: "working" }],
  ["idle between Turns", { firstTurn: true }, { kind: "idle" }],
  ["an older Daemon", { firstTurn: null }, { kind: "unknown" }],
  [
    "waiting on a background command while the wait holds",
    { firstTurn: true, waiting: WAITING },
    { kind: "waiting-on-background", waiting: WAITING },
  ],
  [
    "idle once the wait has run out",
    { firstTurn: true, waiting: { ...WAITING, until: NOW } },
    { kind: "idle" },
  ],
  [
    "working when the Harness's own Turn starts",
    { firstTurn: true, turnInFlight: true, waiting: WAITING },
    { kind: "working" },
  ],
])("%s", (_name, patch, expected) => {
  expect(workerPhase({ ...base, ...patch })).toEqual(expected);
});
