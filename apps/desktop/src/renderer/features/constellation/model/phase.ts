/**
 * A working Attempt's worker phase (setting up, waiting for a slot, starting, stalled, working,
 * idle) from the tab's folded facts, through the protocol's shared `workerPhase`.
 */
import { workerPhase, type WorkerPhase } from "@polaris/protocol";
import type { WorkerFacts } from "./facts.ts";
import type { SetupFact } from "./setup.ts";
import type { AttemptData } from "./types.ts";

export const phaseOf = (
  attempt: Pick<AttemptData, "startedAt">,
  worker: WorkerFacts,
  setup: SetupFact | null,
  now: number
): WorkerPhase => {
  const slot = worker.activity?.kind === "slot" ? worker.activity : null;

  return workerPhase({
    setup:
      setup === null
        ? null
        : { status: setup.run.status, startedAt: setup.run.startedAt, endedAt: setup.run.endedAt },
    slot:
      slot !== null
        ? { kind: "queued", since: slot.since }
        : worker.slotHeldSince === null
          ? null
          : { kind: "held", since: worker.slotHeldSince },
    firstTurn: worker.firstTurn,
    turnInFlight: worker.activeTurn,
    startedAt: attempt.startedAt,
    now,
    waiting: worker.waiting,
  });
};
