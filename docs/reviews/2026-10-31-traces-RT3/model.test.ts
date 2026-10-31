/**
 * RT3 repros on Traces' pure models. Each test names a finding in ../2026-10-31-traces-RT3.md and
 * fails on b29792874; it should pass once that finding is fixed.
 */
import { expect, test } from "bun:test";
import { FIXTURE_SOURCES } from "../../../apps/desktop/src/renderer/features/data/preview/fixtures.ts";
import { formatDuration } from "../../../apps/desktop/src/renderer/features/traces/model/format.ts";
import { setupState } from "../../../apps/desktop/src/renderer/features/traces/model/setup.ts";
import { stackFrames } from "../../../apps/desktop/src/renderer/features/traces/model/span/code.ts";
import { spanDataSource } from "../../../apps/desktop/src/renderer/features/traces/model/span/dataSource.ts";
import {
  durationLabel,
  spanTree,
  traceTimes,
  waterfallRows,
} from "../../../apps/desktop/src/renderer/features/traces/model/waterfall/index.ts";
import {
  ERROR_TRACE,
  FIXTURE_DETAILS,
} from "../../../apps/desktop/src/renderer/features/traces/preview/fixtures.ts";

test("finding 4: an Offline Host doesn't read as Reconnecting", () => {
  const state = setupState({ status: "loading" }, { label: "lucas-rpi", state: "offline" });

  expect(state?.kind).not.toBe("reconnecting");
});

test("finding 7: Open in Data never picks a Remote Data Source for a span that names no server", () => {
  // A local MySQL in a container, instrumented without server.address: only engine and database.
  const source = spanDataSource({ "db.system": "mysql", "db.namespace": "analytics" }, FIXTURE_SOURCES);

  expect(source?.locality ?? null).not.toBe("remote");
});

test("finding 10: a relative frame that climbs out of the checkout isn't the checkout's own", () => {
  const [frame] = stackFrames(
    "Error: card declined\n    at charge (../billing/src/charge.ts:10:5)",
    "/Users/lucas/code/ledger"
  );

  expect(frame?.inProject).toBe(false);
});

test("finding 12: the waterfall and the span panel write one duration the same way", () => {
  for (const ms of [0.4, 65_000, 3_600_000]) expect(formatDuration(ms)).toBe(durationLabel(ms));
});

const withParents = (patch: ReadonlyMap<string, string>) => {
  const detail = FIXTURE_DETAILS.find((d) => d.summary.id === ERROR_TRACE.id);

  if (detail === undefined) throw new Error("No error trace fixture");

  return {
    ...detail,
    spans: detail.spans.map((s) => ({ ...s, parentId: patch.get(s.id) ?? s.parentId })),
  };
};

const shown = (detail: ReturnType<typeof withParents>) =>
  waterfallRows(spanTree(traceTimes(detail)), { collapsed: new Set(), focus: null }).flatMap((r) =>
    r.node.spans.map((s) => s.span.id)
  );

test("finding 13: a span naming itself as parent still shows in the waterfall", () => {
  const detail = withParents(new Map([["63a8cae2f4b6d803", "63a8cae2f4b6d803"]]));

  expect(shown(detail).toSorted()).toEqual(detail.spans.map((s) => s.id).toSorted());
});

test("finding 13: two spans naming each other as parent still show in the waterfall", () => {
  const detail = withParents(
    new Map([
      ["63a8cae2f4b6d803", "74b9dbf3a5c7e914"],
      ["74b9dbf3a5c7e914", "63a8cae2f4b6d803"],
    ])
  );

  expect(shown(detail).toSorted()).toEqual(detail.spans.map((s) => s.id).toSorted());
});
