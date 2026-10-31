/**
 * RT3's repros on Traces' pure models: each names its finding in
 * docs/reviews/2026-10-31-traces-RT3.md, and failed before TF3's fix.
 */
import { expect, test } from "bun:test";
import { DataSource } from "@polaris/protocol";
import { FIXTURE_SOURCES } from "../../data/preview/fixtures.ts";
import { formatDuration } from "../model/format.ts";
import { traceReference } from "../model/reference.ts";
import { setupState } from "../model/setup.ts";
import { turnKicker } from "../model/sidebar.ts";
import { stackFrames } from "../model/span/code.ts";
import { spanDataSource } from "../model/span/dataSource.ts";
import { durationLabel, spanTree, traceTimes, waterfallRows } from "../model/waterfall/index.ts";
import { ERROR_TRACE, FIXTURE_DETAILS } from "../preview/fixtures.ts";

test("finding 4: an Offline Host doesn't read as Reconnecting", () => {
  const state = setupState({ status: "loading" }, { label: "lucas-rpi", state: "offline" });

  expect(state?.kind).not.toBe("reconnecting");
});

test("finding 7: Open in Data never picks a Remote Data Source for a span that names no server", () => {
  // A local MySQL in a container, instrumented without server.address: only engine and database.
  const source = spanDataSource(
    { "db.system": "mysql", "db.namespace": "analytics" },
    FIXTURE_SOURCES
  );

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

test("finding 4: each away state has its own setup state; only Reconnecting promises to return", () => {
  const loading = { status: "loading" } as const;

  expect(setupState(loading, { label: "lucas-rpi", state: "offline" })).toEqual({
    kind: "offline",
    host: "lucas-rpi",
  });
  expect(setupState(loading, { label: "lucas-rpi", state: "needs-attention" })).toEqual({
    kind: "needsAttention",
    host: "lucas-rpi",
  });
  expect(setupState(loading, { label: "lucas-rpi", state: "reconnecting" })?.kind).toBe(
    "reconnecting"
  );
});

test("finding 7: two Local Data Sources that both fit offer neither", () => {
  const twinOf = (id: string, port: number) =>
    new DataSource({
      id,
      name: "app",
      engine: "postgres",
      version: "16.4",
      locality: "local",
      host: "localhost",
      port,
      database: "ledger_overdue",
      user: "ledger",
      foundIn: { kind: "env", file: ".env.local", key: "DATABASE_URL" },
      access: "read",
      writes: "ask",
      label: { text: "LOCAL", colour: "none" },
      reachable: true,
    });

  const local = twinOf("src-app", 5432);
  const twin = twinOf("src-app-docker", 5433);
  const attributes = { "db.system": "postgresql", "db.namespace": "ledger_overdue" };

  expect(spanDataSource(attributes, [local])?.id).toBe(local.id);
  expect(spanDataSource(attributes, [local, twin])).toBeNull();
});

test("finding 10: a Windows path is never the checkout's own; a relative one inside it is", () => {
  const [win, inside] = stackFrames(
    "Error: x\n    at a (C:\\Users\\lucas\\ledger\\src\\a.ts:1:1)\n    at b (./src/./totals/../overdue.ts:61:9)",
    "/Users/lucas/code/ledger"
  ).toSorted((x, y) => Number(x.inProject) - Number(y.inProject));

  expect(win?.inProject).toBe(false);
  expect(inside?.inProject).toBe(true);
  expect(inside?.location.path).toBe("src/overdue.ts");
});

test("finding 8: another session's Turn names that session, in the kicker and in ⌘L", () => {
  const detail = FIXTURE_DETAILS.find((d) => d.summary.turn?.number === 12);

  if (detail === undefined) throw new Error("No Turn 12 fixture");
  expect(turnKicker(detail.summary.turn, 12, "Fix the importer")).toBe(
    "TURN 12 · Fix the importer"
  );
  expect(traceReference(detail.summary, null, "Fix the importer")).toContain(
    "turn 12 of Fix the importer"
  );
});
