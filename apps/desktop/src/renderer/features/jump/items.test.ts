import { describe, expect, test } from "bun:test";
import { hostModel, hostView } from "../../routes/fixtures.testing.ts";
import { barHosts, shortcutLabel } from "../../routes/topBar.ts";
import { jumpGroups } from "./groups.ts";
import { hostItems, sessionItems, workspaceItems, worktreeItems } from "./items.ts";

const models = {
  local: hostModel([
    { id: "polaris" },
    { id: "sightline", hidden: true, sessions: [{ id: "s1", state: "idle" }] },
  ]),
};

const data = { bar: barHosts({ hosts: [hostView("local")], models }), models, machineBar: false };

describe("jump menu Workspaces", () => {
  test("hidden ones are listed after the chips, marked hidden, with no ⌃N", () => {
    expect(workspaceItems(data).map((i) => [i.title, i.meta])).toEqual([
      ["polaris", shortcutLabel(0) ?? ""],
      ["sightline", "hidden"],
    ]);
  });

  test("a collapsed Host's Workspaces stay listed without ⌃N, matching the bar", () => {
    const twoHosts = { ...models, studio: hostModel([{ id: "ledger" }]) };
    const hosts = [hostView("local"), hostView("studio")];

    const collapsed = {
      bar: barHosts({ hosts, models: twoHosts, collapsed: ["studio"] }),
      models: twoHosts,
      machineBar: false,
    };

    expect(workspaceItems(collapsed).map((i) => [i.title, i.meta])).toEqual([
      ["ledger", ""],
      ["polaris", shortcutLabel(0) ?? ""],
      ["sightline", "hidden"],
    ]);
  });

  test("a hidden one is found by name, or by the word hidden", () => {
    const sources = {
      sessions: sessionItems(data),
      workspaces: workspaceItems(data),
      worktrees: worktreeItems(data),
      hosts: hostItems(data),
    };

    const found = (query: string) =>
      jumpGroups({ query, sources, recent: [] })
        .find((g) => g.heading === "Workspaces")
        ?.items.map((i) => i.title);

    expect(found("sight")).toEqual(["sightline"]);
    expect(found("hidden")).toEqual(["sightline"]);
  });

  test("a machine's count is of its shown Workspaces", () => {
    expect(hostItems(data)[0]?.detail).toBe("1 workspace");
  });
});

describe("jump menu Sessions", () => {
  test("a Constellation worker is left to its Lead unless it needs you", () => {
    const withWorkers = {
      local: hostModel([
        {
          id: "polaris",
          sessions: [
            { id: "mine", state: "idle" },
            { id: "worker", state: "working", worker: true },
            { id: "asking", state: "needs-you", worker: true },
          ],
        },
      ]),
    };

    const items = sessionItems({
      bar: barHosts({ hosts: [hostView("local")], models: withWorkers }),
      models: withWorkers,
      machineBar: false,
    });

    expect(items.map((i) => i.title).toSorted()).toEqual(["asking", "mine"]);
  });
});
