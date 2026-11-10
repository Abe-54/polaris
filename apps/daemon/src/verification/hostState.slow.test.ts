import { test, expect } from "bun:test";
import { Predicate, Schema } from "effect";
import { LanguageHostState, LanguageInstallProgress } from "@polaris/protocol";
import { Tool } from "../languages/catalog/index.ts";
import { createHostToolStates } from "../languages/install/hostState.ts";
import { artifactFixture, hostId, platform } from "../languages/install/fixture.testing.ts";
import {
  HostStateStep,
  HostStateTrace,
  replayHostState,
} from "../../../../packages/spec/scripts/host-state/index.ts";
import { posixTest } from "../platform/testing.ts";

type Phase = "NotDownloaded" | "Downloading" | "Installed" | "Failed";

interface ModelRun {
  states: ReturnType<typeof createHostToolStates>;
  model: Phase[];
  watch: AsyncIterableIterator<LanguageHostState> | undefined;
  pending: boolean;
  emit: (step: number) => void;
  close: () => void;
}

function projectedPhase(phase: LanguageInstallProgress["phase"]): Phase {
  switch (phase) {
    case "completed":
      return "Installed";
    case "failed":
    case "cancelled":
      return "Failed";
    default:
      return "Downloading";
  }
}

function createModelRun(random: () => number, reached: Set<string>): ModelRun {
  const tools = [0, 1].map((id) =>
    Schema.decodeUnknownSync(Tool)({ ...artifactFixture().tool, id: `tool-${id}` })
  );

  const latest = new Map<string, LanguageInstallProgress>();
  const listeners = new Set<(progress: LanguageInstallProgress) => void>();
  const lifetime = new AbortController();

  const states = createHostToolStates({
    hostId,
    platform,
    tools,
    lifetime: lifetime.signal,
    installer: {
      current: async () => null,
      recoveryFacts: async () => [],
      progress: (id) => latest.get(id) ?? null,
      subscribe: (listener) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
    },
  });

  const model: Phase[] = ["NotDownloaded", "NotDownloaded"];

  const run: ModelRun = {
    states,
    model,
    watch: undefined,
    pending: false,
    emit: (step) => {
      const tool = random() % 2;
      const phases = ["downloading", "completed", "failed", "cancelled"] as const;

      const update = LanguageInstallProgress.make({
        hostId,
        toolId: `tool-${tool}`,
        jobId: "model-job",
        version: "1.0.0",
        sequence: step,
        phase: phases[random() % 4]!,
        downloadedBytes: step,
        totalBytes: null,
        message: "Synthetic model progress",
        activeVersion: "1.0.0",
      });

      reached.add(`${update.toolId}:${update.phase}`);
      latest.set(update.toolId, update);
      model[tool] = projectedPhase(update.phase);

      for (const listener of listeners) listener(update);

      if (run.watch !== undefined) run.pending = true;
    },
    close: () => {
      lifetime.abort();
      expect(listeners.size).toBe(0);
    },
  };

  return run;
}

async function advance(run: ModelRun, choice: number, step: number) {
  if (choice === 0 && run.watch === undefined) {
    run.watch = await run.states.watch(
      { toolIds: [], refresh: false },
      new AbortController().signal
    );
    run.pending = true;
  } else if (choice === 1 && run.watch !== undefined) {
    await run.watch.return?.();
    run.watch = undefined;
    run.pending = false;
  } else if (choice === 2 && run.watch !== undefined && run.pending) {
    const observed = Schema.decodeUnknownSync(LanguageHostState)((await run.watch.next()).value);
    expect(observed.tools.map((tool) => tool.state._tag)).toEqual(run.model);
    run.pending = false;
  } else run.emit(step);
  expect(run.states.stats().subscribers).toBe(run.watch === undefined ? 0 : 1);
}

test("Host snapshot model agrees with 2000 installer/feed steps, closes and coalescing", async () => {
  let seed = 12345;

  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

    // An LCG's low bits cycle with a short period; the high bits drive every choice.
    return seed >>> 16;
  };

  const reached = new Set<string>();

  for (let iteration = 0; iteration < 50; iteration++) {
    const run = createModelRun(random, reached);

    for (let step = 0; step < 40; step++) await advance(run, random() % 5, step);
    run.close();
  }

  // Both tools reach every installer phase (ENG-785: the low bits reached 4 of 8).
  expect(reached.size).toBe(8);
});

posixTest(
  "the installer requires a private, owned directory, which it checks by POSIX mode (ENG-314)"
)(
  "observed real installer feed replays against Quint without durable history",
  async () => {
    const { fixture } = await import("../languages/install/fixture.testing.ts");
    const f = await fixture();
    const lifetime = new AbortController();

    const tools = [
      Schema.decodeUnknownSync(Tool)(f.source.tool),
      Schema.decodeUnknownSync(Tool)({ ...f.source.tool, id: "unused-tool" }),
    ];

    const states = createHostToolStates({
      hostId,
      platform,
      tools,
      installer: f.installer,
      lifetime: lifetime.signal,
    });

    const steps: (typeof HostStateStep.Type)[] = [HostStateStep.cases.Subscribe.make({})];

    const consume = async (watch: AsyncIterableIterator<LanguageHostState>) => {
      const observed = Schema.decodeUnknownSync(LanguageHostState)((await watch.next()).value);

      steps.push(
        HostStateStep.cases.Consume.make({ phases: observed.tools.map((tool) => tool.state._tag) })
      );
    };

    try {
      const watch = await states.watch(
        { toolIds: [], refresh: true },
        new AbortController().signal
      );

      await consume(watch);

      const stop = f.installer.subscribe((update) => {
        const phase = projectedPhase(update.phase);

        steps.push(HostStateStep.cases.SetState.make({ tool: 0, phase }));
      });

      const job = f.installer.install(f.request);
      await job.result;
      await consume(watch);
      await watch.return?.();
      stop();
      steps.push(HostStateStep.cases.Close.make({}));
      const trace = HostStateTrace.make({ version: 1, source: "host-installer-feed", steps });
      const receipt = await replayHostState(trace);

      // The real installer's feed reached Installed, and Quint replayed that snapshot.
      expect(steps).toContainEqual(
        HostStateStep.cases.SetState.make({ tool: 0, phase: "Installed" })
      );
      expect(steps.findLast(Predicate.isTagged("Consume"))).toEqual(
        HostStateStep.cases.Consume.make({ phases: ["Installed", "NotDownloaded"] })
      );
      expect(receipt.output).toContain("ok recordedHostFeedTest");
      expect(states.stats().subscribers).toBe(0);

      if (process.env.POLARIS_HOST_STATE_TRACE !== undefined)
        await Bun.write(process.env.POLARIS_HOST_STATE_TRACE, JSON.stringify(trace, null, 2));
    } finally {
      lifetime.abort();
      await f.close();
    }
  },
  30000
);
