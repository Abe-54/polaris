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
  test("records the Findings and completes the layer, with the run's notes", async () => {
    const summary = await record(
      Effect.succeed({ findings: [finding], notes: ["2 files were too large"], ok: true })
    );

    expect(summary?.findings.map((f) => f.id)).toEqual([finding.id]);
    expect(summary?.layers.rules).toEqual(
      LayerRun.make({ status: "completed", note: "2 files were too large" })
    );
  });

  test("a clean run completes with no Findings and no note", async () => {
    const summary = await record(Effect.succeed({ findings: [], notes: [], ok: true }));

    expect(summary?.findings).toEqual([]);
    expect(summary?.layers.rules).toEqual(LayerRun.make({ status: "completed", note: null }));
  });

  test("a run that could not start fails the layer with why", async () => {
    const summary = await record(
      Effect.fail(new ServiceError({ service: "Rules", message: "not a git repository" }))
    );

    expect(summary?.layers.rules).toEqual(
      LayerRun.make({ status: "failed", note: "The rules could not run: not a git repository" })
    );
  });

  test("both scanners failing fails the layer", async () => {
    const summary = await record(
      Effect.succeed({
        findings: [],
        notes: ["Secrets were not checked", "Code patterns were not checked"],
        ok: false,
      })
    );

    expect(summary?.layers.rules.status).toBe("failed");
  });
});
