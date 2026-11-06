import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DomainEvent,
  LayerRun,
  LineRange,
  ReviewSubject,
  RiskFinding,
  RiskFindingId,
  RiskSummary,
  RiskSummaryId,
  RiskSummaryKey,
  RiskSummaryLayers,
  RiskSummaryRef,
  SessionId,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { removeTempDir, tempDir } from "../git/testing.ts";
import { Rules, ServiceError } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { recordRulesLayer } from "./index.ts";
import type { RulesOutcome } from "./run.ts";

const dirs: Array<string> = [];

afterAll(() => dirs.forEach(removeTempDir));

const summaryId = RiskSummaryId.make("sum-rules");

const finding = RiskFinding.make({
  id: RiskFindingId.make("rule-1"),
  identity: "identity-1",
  source: "rule",
  ruleId: "js-eval",
  path: "a.ts",
  lines: LineRange.make({ start: 1, end: 1, side: "new" }),
  severity: "critical",
  confidence: 0.7,
  title: "eval runs a string as code",
  reason: "eval runs a string as code.",
  suggestion: null,
  status: "open",
  resolution: null,
});

const started = RiskSummary.make({
  id: summaryId,
  key: RiskSummaryKey.make({ repo: "/repo", mergeBase: "a", head: "b", since: null }),
  workspaceId: WorkspaceId.make("w-1"),
  subject: ReviewSubject.cases.SessionTurns.make({
    sessionId: SessionId.make("s-1"),
    firstTurnId: null,
    lastTurnId: null,
  }),
  checkoutId: null,
  status: "running",
  layers: RiskSummaryLayers.make({
    rules: LayerRun.make({ status: "pending", note: null }),
    agent: LayerRun.make({ status: "pending", note: null }),
  }),
  reviewer: null,
  cost: null,
  note: null,
  findings: [],
  startedAt: "2026-10-01T00:00:00.000Z",
  endedAt: null,
});

const record = (outcome: Effect.Effect<RulesOutcome, ServiceError>) => {
  const dir = tempDir();
  dirs.push(dir);
  const rules = Layer.succeed(Rules, Rules.of({ run: () => outcome }));
  const store = EventStore.layerSqlite(join(dir, "state.sqlite"));

  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventStore;
      yield* events.commit({
        commandId: null,
        decide: () =>
          Effect.succeed([DomainEvent.cases.RiskSummaryStarted.make({ summary: started })]),
      });
      yield* recordRulesLayer(summaryId, { cwd: "/repo", base: "a", head: "b", mode: "snapshot" });

      return yield* events.review.riskSummary(RiskSummaryRef.cases.ById.make({ summaryId }));
    }).pipe(Effect.provide(Layer.mergeAll(rules, store)))
  );
};

describe("recordRulesLayer", () => {
  test.each<[string, Parameters<typeof record>[0], ReadonlyArray<typeof finding.id>, LayerRun]>([
    [
      "records the Findings and completes the layer, with the run's notes",
      Effect.succeed({ findings: [finding], notes: ["2 files were too large"], ok: true }),
      [finding.id],
      LayerRun.make({ status: "completed", note: "2 files were too large" }),
    ],
    [
      "a clean run completes with no Findings and no note",
      Effect.succeed({ findings: [], notes: [], ok: true }),
      [],
      LayerRun.make({ status: "completed", note: null }),
    ],
    [
      "a run that could not start fails the layer with why",
      Effect.fail(new ServiceError({ service: "Rules", message: "not a git repository" })),
      [],
      LayerRun.make({ status: "failed", note: "The rules could not run: not a git repository" }),
    ],
    [
      "both scanners failing fails the layer",
      Effect.succeed({
        findings: [],
        notes: ["Secrets were not checked", "Code patterns were not checked"],
        ok: false,
      }),
      [],
      LayerRun.make({
        status: "failed",
        note: "Secrets were not checked. Code patterns were not checked",
      }),
    ],
  ])("%s", async (_name, outcome, findings, layer) => {
    const summary = await record(outcome);

    expect(summary?.findings.map((f) => f.id)).toEqual([...findings]);
    expect(summary?.layers.rules).toEqual(layer);
  });
});
