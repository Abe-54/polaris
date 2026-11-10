import { EditPredictionRequest } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { hardeningCases, hardeningRequest } from "../hardening.testing.ts";
import { editWindow } from "../window.ts";
import { reachFocuses, type ReachInput } from "./index.ts";

const sweepWindow = (c: (typeof hardeningCases)[number], focus: number | null = null) =>
  editWindow(EditPredictionRequest.make({ ...hardeningRequest(c, "sweep-next-edit"), focus }));

const reaches = (c: (typeof hardeningCases)[number], focus: number | undefined) => {
  if (focus === undefined) return false;
  const w = sweepWindow(c, focus);

  return c.expected.every((e) => e.from >= w.from && e.to <= w.to);
};

// Dev cases whose target lies outside the cursor window and whose first probe reaches it
// (docs/research/next-edit-spike.md, "Reach: jumps and imports"). §4's rule reaches 8.
const REACHED = {
  rename: ["rn04", "hrn02", "hrn04", "hrn06", "hrn07", "hrn08"],
  refactor: ["hrf05"],
  "dead-code": ["dd01", "dd02", "dd04", "dd05", "hdd02", "hdd03", "hdd05", "hdd07", "hdd08"],
};

describe("the first jump probe reaches the next edit", () => {
  for (const [category, ids] of Object.entries(REACHED))
    test.each(ids)(`${category} %s`, (id) => {
      const c = hardeningCases.find((x) => x.id === id);

      if (!c) throw new Error(`Missing case ${id}`);
      const window = sweepWindow(c);
      expect(reaches(c, c.cursor)).toBe(false);
      expect(reaches(c, reachFocuses({ ...c, window })[0])).toBe(true);
    });
});

const input = (buffer: string, history: ReachInput["history"], cursor: number): ReachInput => ({
  buffer,
  path: "a.ts",
  cursor,
  window: { from: cursor - 1, to: cursor + 1 },
  history,
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `const filler${i} = ${i};`);

describe("reachFocuses", () => {
  test("probes the declaration the last edit left without uses before nearer common names", () => {
    const buffer = ["const mac = isMac();", ...lines(30), "shellSafe(keys, platform());"].join(
      "\n"
    );

    const cursor = buffer.indexOf("platform()");

    const focuses = reachFocuses(
      input(
        buffer,
        [
          {
            path: "a.ts",
            line: 31,
            before: "shellSafe(keys, mac);",
            after: "shellSafe(keys, platform());",
          },
        ],
        cursor
      )
    );

    expect(focuses[0]).toBe(buffer.indexOf("mac"));
  });

  test("the old name of a rename leads to its nearest remaining use", () => {
    const buffer = [
      ...lines(3),
      "export const openFeed = () => 1;",
      ...lines(25),
      "makeFeed();",
      ...lines(25),
      "makeFeed();",
    ].join("\n");

    const cursor = buffer.indexOf("openFeed");

    const history = [
      {
        path: "a.ts",
        line: 3,
        before: "export const makeFeed = () => 1;",
        after: "export const openFeed = () => 1;",
      },
    ];

    expect(reachFocuses(input(buffer, history, cursor))).toEqual([
      buffer.indexOf("makeFeed"),
      buffer.lastIndexOf("makeFeed"),
    ]);
  });

  test("a line the history moved leads to the copy left behind", () => {
    const buffer = [
      "function a() {",
      "  const uuid = crypto.randomUUID();",
      ...lines(30),
      "  const uuid = crypto.randomUUID();",
      "}",
    ].join("\n");

    const cursor = buffer.lastIndexOf("const uuid");

    const history = [
      { path: "a.ts", line: 32, before: "", after: "  const uuid = crypto.randomUUID();" },
    ];

    const [focus] = reachFocuses(input(buffer, history, cursor));
    expect(buffer.slice(0, focus).split("\n")).toHaveLength(2);
  });

  test("an argument added to a call leads to the callee's definition", () => {
    const buffer = [
      "const complete = (a: number, coordinator: C) => a;",
      ...lines(30),
      "complete(",
      "  1,",
      "  coordinator,",
      "  settleMs",
      ");",
    ].join("\n");

    const cursor = buffer.indexOf("settleMs") + 8;

    const history = [
      { path: "a.ts", line: 33, before: "  coordinator", after: "  coordinator,\n  settleMs" },
    ];

    expect(reachFocuses(input(buffer, history, cursor), { signals: ["callee"] })).toEqual([
      buffer.indexOf("complete"),
    ]);
  });

  test("ignores other files' history, prose in comments, and occurrences inside the window", () => {
    const buffer = ["// oldName is documented here", ...lines(30), "newName();", "oldName();"].join(
      "\n"
    );

    const cursor = buffer.indexOf("newName");

    const at = (from: number, to: number): ReachInput => ({
      ...input(buffer, [], cursor),
      window: { from, to },
    });

    const other = [{ path: "b.ts", line: 31, before: "oldName();", after: "newName();" }];
    const comment = [{ path: "a.ts", line: 31, before: "// oldName", after: "// newName" }];
    const own = [{ path: "a.ts", line: 31, before: "oldName();", after: "newName();" }];
    expect(reachFocuses({ ...at(cursor, cursor + 1), history: other })).toEqual([]);
    expect(reachFocuses({ ...at(cursor, cursor + 1), history: comment })).toEqual([]);
    expect(reachFocuses({ ...at(cursor, buffer.length), history: own })).toEqual([
      buffer.indexOf("oldName"),
    ]);
  });

  test("never returns two focuses whose windows overlap", () => {
    const buffer = [...lines(5), "oldName();", "oldName();", ...lines(30), "newName();"].join("\n");
    const cursor = buffer.indexOf("newName");
    const history = [{ path: "a.ts", line: 37, before: "oldName();", after: "newName();" }];
    expect(reachFocuses(input(buffer, history, cursor))).toEqual([buffer.lastIndexOf("oldName")]);
  });

  test("an out-of-range cursor yields no probe", () => {
    const buffer = [...lines(5), "oldName();", ...lines(30), "newName();"].join("\n");
    const history = [{ path: "a.ts", line: 36, before: "oldName();", after: "newName();" }];
    expect(reachFocuses(input(buffer, history, buffer.length + 5))).toEqual([]);
    expect(reachFocuses(input(buffer, history, -1))).toEqual([]);
  });
});
