import { expect, test } from "bun:test";
import { Constellation, ReviewAction, Task } from "@polaris/protocol";
import { Struct } from "effect";
import {
  A,
  B,
  C,
  CID,
  apply,
  claimed,
  ctx,
  draft,
  planned,
} from "../engine/constellation.testing.ts";
import { staleNotices } from "./regenerate.ts";
import { areaWarnings, statusOutline } from "./status.ts";

const working = (areaA: ReadonlyArray<string>, areaB: ReadonlyArray<string>) => {
  const record = planned();

  const area = new Map([
    [A, areaA],
    [B, areaB],
  ]);

  const graph = Constellation.make(
    Struct.assign(record.graph, {
      tasks: record.graph.tasks.map((t) =>
        Task.make(Struct.assign(t, { area: area.get(t.id) ?? t.area, deps: [] }))
      ),
      attempts: [draft(A, "a1"), draft(B, "b1")],
    })
  );

  return areaWarnings({ ...record, graph });
};

test.each([
  ["two package roots", ["apps/site/**"], ["apps/desktop"]],
  ["a named manifest and the lockfile", ["apps/site/package.json"], ["bun.lock"]],
  [
    "the notices and the licence exceptions",
    ["THIRD_PARTY_NOTICES.md"],
    ["scripts/license-exceptions.json"],
  ],
])(
  "parallel Tasks whose areas may change dependencies get the shared-files warning: %s",
  (_, a, b) => {
    expect(working(a, b)).toEqual([
      "A and B may both change dependencies: Accept's merge regenerates bun.lock and flags THIRD_PARTY_NOTICES.md as stale, but scripts/license-exceptions.json can conflict",
    ]);
  }
);

test.each([
  ["source folders inside packages", ["apps/daemon/src/constellation"], ["apps/site/app/**"]],
  ["one package root against a source folder", ["apps/site"], ["packages/ui/src/**"]],
])("disjoint areas that can't both change dependencies get no warning: %s", (_, a, b) => {
  expect(working(a, b)).toEqual([]);
});

test("overlapping areas keep the area warning alone", () => {
  expect(working(["apps/site/**"], ["apps/site/app/**"])).toEqual(["A and B may share an area"]);
});

test("an Accept records its merge's stale-notices finding on the Task, shown in the Lead's status", () => {
  const record = claimed();
  const attempt = record.graph.attempts.at(-1)!;

  const accepted = apply(
    record,
    C.Review.make({
      constellationId: CID,
      attemptId: attempt.id,
      revision: attempt.revision,
      action: ReviewAction.cases.Accept.make({ mergedHead: "head", receipts: [] }),
    }),
    ctx({ mergeFindings: [staleNotices] })
  );

  expect(accepted.graph.attempts.at(-1)!.acceptFindings).toEqual([staleNotices]);
  expect(statusOutline(accepted)).toContain(
    "  Finding NOTICES-STALE: Notices may be stale: run `bun run licenses` on the lead branch"
  );
});
