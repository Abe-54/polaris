import { TaskId } from "@polaris/protocol";
import { expect, test } from "bun:test";
import type { ConstellationSource } from "../model.ts";
import { taskDetail } from "./detail.ts";
import { attempt, claim, deps, NOW, projection, source, task } from "./fixtures.testing.ts";
import { bandLetter, starChartOf } from "./stars.ts";

/** MX-W's shape: two bands, a cross-band dependency, two tasks sharing a wave, a gate. */
const mxw = () =>
  source(
    [
      task("t1", { group: "Contracts" }),
      task("t2", { group: "Contracts", ...deps("t1") }),
      task("t3", { group: "Contracts", ...deps("t1") }),
      task("t4", { group: "Screens", ...deps("t2") }),
      task("t5", { group: "Screens" }),
      task("g1", { kind: "gate", ...deps("t3", "t4") }),
    ],
    [
      projection("t1", "done"),
      projection("t2", "done"),
      projection("t3", "working"),
      projection("t4", "waiting"),
      projection("t5", "failed"),
      projection("g1", "waiting"),
    ]
  );

const byId = (s: ConstellationSource) => new Map(starChartOf(s).tasks.map((t) => [t.id, t]));

test("bands follow groups in first-seen order, ungrouped tasks share one band", () => {
  const { bands } = starChartOf(mxw());

  expect(bands.map((b) => [b.letter, b.name])).toEqual([
    ["A", "Contracts"],
    ["B", "Screens"],
    ["C", "tasks"],
  ]);
});

test("a task's wave is one past its deepest dependency, across bands", () => {
  const stars = byId(mxw());

  expect(["t1", "t2", "t3", "t4", "t5", "g1"].map((id) => stars.get(id)?.wave)).toEqual([
    1, 2, 2, 3, 1, 4,
  ]);
});

test("labels count within a band by wave, so two tasks in one wave stay distinct", () => {
  const stars = byId(mxw());

  expect(["t1", "t2", "t3", "t5", "t4", "g1"].map((id) => stars.get(id)?.label)).toEqual([
    "A1",
    "A2",
    "A3",
    "B1",
    "B2",
    "C1",
  ]);
});

test("parents, canceled and lost tasks leave the chart; a claim handed to the user is review", () => {
  const s = source(
    [
      task("p", { group: "Home" }),
      task("c1", { group: "Home", parent: TaskId.make("p") }),
      task("c2", { group: "Home", parent: TaskId.make("p") }),
      task("x", { group: "Home" }),
      task("h", { group: "Home" }),
    ],
    [
      projection("p", "working"),
      projection("c1", "done"),
      projection("c2", "lost"),
      projection("x", "canceled"),
      projection("h", "review", "h-a1"),
    ],
    [attempt("h", 1, { state: "review", claim, handedUpAt: "2026-10-27T11:58:00Z" })]
  );

  const { tasks } = starChartOf(s);

  expect(tasks.map((t) => [t.id, t.state])).toEqual([
    ["c1", "done"],
    ["h", "review"],
  ]);
});

test("a dependency cycle doesn't hang the chart", () => {
  const s = source(
    [task("a", deps("b")), task("b", deps("a"))],
    [projection("a", "waiting"), projection("b", "waiting")]
  );

  expect(
    starChartOf(s)
      .tasks.map((t) => t.id)
      .sort()
  ).toEqual(["a", "b"]);
});

test("band letters run past Z", () => {
  expect([0, 25, 26, 27].map(bandLetter)).toEqual(["A", "Z", "AA", "AB"]);
});

test("each star carries its plan dependencies, for the chart's edges", () => {
  const stars = byId(mxw());

  expect(stars.get("g1")?.dependsOn).toEqual(["t3", "t4"]);
});

test("MX-Z: a claim in review on a second attempt after a send-back", () => {
  const s = source(
    [task("b3", { group: "Hosts" })],
    [projection("b3", "review", "b3-a2")],
    [
      attempt("b3", 1, { state: "rejected", rejectionReason: "Reconnecting hosts float up." }),
      attempt("b3", 2, { state: "review", claim, claimedAt: "2026-10-27T11:54:00Z" }),
    ]
  );

  const star = starChartOf(s).tasks[0];

  if (star === undefined) throw new Error("no star");

  expect(taskDetail(s, star, () => "mac-studio", NOW)).toMatchObject({
    kicker: "Task A1 · wave 1",
    status: { value: "Review", detail: "claim waiting 6m" },
    attempt: { value: "2", detail: "1 rejected" },
    claim: { value: "Ready", detail: "3f9c2e1 · 1 check" },
    worker: { detail: "mac-studio · 18m" },
    branch: "lucas/b3-2",
    sentBack: 'Attempt 1 was sent back: "Reconnecting hosts float up."',
    session: { hostId: "mac", sessionId: "b3-worker-2" },
    reviewable: true,
  });
});

test("MX-Z: a waiting task has no worker to open and no claim to review", () => {
  const s = mxw();
  const star = byId(s).get("t4");

  if (star === undefined) throw new Error("no star");

  expect(taskDetail(s, star, () => "mac", NOW)).toMatchObject({
    attempt: { value: "None yet", detail: null },
    claim: { value: "None yet" },
    session: null,
    reviewable: false,
    sentBack: null,
  });
});
