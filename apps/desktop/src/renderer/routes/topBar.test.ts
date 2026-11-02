import { describe, expect, test } from "bun:test";
import { hostModel, hostView, workspaces } from "./fixtures.testing.ts";
import { WorkspaceId } from "@polaris/protocol";
import {
  barHosts,
  barWorkspaces,
  hiddenWorkspaces,
  keyedWorkspaces,
  edgeFade,
  revealOffset,
  shortcutLabel,
  shownWorkspaces,
  summarize,
  topBarMode,
} from "./topBar.ts";

describe("top bar mode (ENG-177)", () => {
  test("Workspace chips up to 10, the machine bar from 11", () => {
    expect(topBarMode({ workspaces: 10, hosts: 3, previous: "workspaces" })).toBe("workspaces");
    expect(topBarMode({ workspaces: 11, hosts: 3, previous: "workspaces" })).toBe("machines");
  });

  test("hysteresis: the machine bar stays until 9, so it never flips at 10/11", () => {
    expect(topBarMode({ workspaces: 10, hosts: 3, previous: "machines" })).toBe("machines");
    expect(topBarMode({ workspaces: 9, hosts: 3, previous: "machines" })).toBe("workspaces");
  });

  test("a single machine in machine mode hides the bar; with few Workspaces it keeps its chips", () => {
    expect(topBarMode({ workspaces: 12, hosts: 1, previous: "workspaces" })).toBe("hidden");
    expect(topBarMode({ workspaces: 10, hosts: 1, previous: "hidden" })).toBe("hidden");
    expect(topBarMode({ workspaces: 3, hosts: 1, previous: "hidden" })).toBe("workspaces");
  });

  test("⌃1…⌃9 then ⌃0 for the tenth, nothing after", () => {
    expect([0, 8, 9, 10].map((i) => shortcutLabel(i, "mac"))).toEqual([
      "⌃1",
      "⌃9",
      "⌃0",
      undefined,
    ]);
    expect([0, 9].map((i) => shortcutLabel(i, "windows"))).toEqual(["Ctrl+1", "Ctrl+0"]);
  });
});

describe("bar contents", () => {
  test("every shown Workspace on every Host, remote Hosts first and this Mac last; hidden ones left out", () => {
    const bar = barHosts({
      hosts: [hostView("local"), hostView("studio")],
      models: {
        local: hostModel([{ id: "a" }, { id: "b", hidden: true }]),
        studio: hostModel(workspaces("s", 2)),
      },
    });

    expect(barWorkspaces(bar).map((w) => `${w.hostKey}/${w.workspace.name}`)).toEqual([
      "studio/s0",
      "studio/s1",
      "local/a",
    ]);
  });

  test("a chip shows its loudest session: needs you over failed over working", () => {
    const model = hostModel([
      {
        id: "a",
        sessions: [
          { id: "1", state: "idle" },
          { id: "2", state: "working" },
          { id: "3", state: "needs-you" },
          { id: "4", state: "failed" },
          { id: "5", state: "archived" },
        ],
      },
    ]);

    const summary = summarize(
      [...model.sessions.values()].filter((e) => e.session.state !== "archived")
    );

    expect(summary.state).toBe("needs-you");
    expect(summary.needsYou).toBe(1);
    expect(summary.sessions).toBe(4);
    expect(summarize([]).state).toBeNull();
  });

  test("a session dismissed from Needs You on this Mac doesn't count on its chip", () => {
    const bar = barHosts({
      hosts: [hostView("local")],
      models: {
        local: hostModel([
          {
            id: "a",
            sessions: [
              { id: "1", state: "needs-you" },
              { id: "2", state: "working" },
            ],
          },
        ]),
      },
      quiet: new Set(["local\u00001"]),
    });

    const chip = barWorkspaces(bar)[0]?.summary;

    expect(chip?.needsYou).toBe(0);
    expect(chip?.state).toBe("working");
    expect(bar[0]?.summary.needsYou).toBe(0);
  });
});

describe("collapsed Hosts (ENG-733)", () => {
  const hosts = [hostView("local"), hostView("studio")];

  const models = {
    local: hostModel([{ id: "a" }, { id: "b" }]),
    studio: hostModel([{ id: "s", sessions: [{ id: "n1", state: "needs-you" }] }, { id: "t" }]),
  };

  test("a collapsed Host's chips take no ⌃N, so ⌃1 lands on the first visible one", () => {
    const bar = barHosts({ hosts, models, collapsed: ["studio"] });

    expect(keyedWorkspaces(bar).map((w) => w.workspace.name)).toEqual(["a", "b"]);
  });

  test("collapsing keeps the Host's chips listed and what needs you counted", () => {
    const [studio] = barHosts({ hosts, models, collapsed: ["studio"] });

    expect([studio?.collapsed, studio?.workspaces.length, studio?.summary.needsYou]).toEqual([
      true,
      2,
      1,
    ]);
    expect(barWorkspaces(barHosts({ hosts, models, collapsed: ["studio"] }))).toHaveLength(4);
  });
});

describe("hidden Workspaces", () => {
  const hosts = [hostView("local")];

  const models = {
    local: hostModel([
      { id: "a" },
      { id: "quiet", hidden: true, sessions: [{ id: "q1", state: "working" }] },
      { id: "asks", hidden: true, sessions: [{ id: "n1", state: "needs-you" }] },
      { id: "b" },
    ]),
  };

  const listed = (bar: ReturnType<typeof barHosts>) =>
    bar.flatMap((h) => h.workspaces).map((w) => `${w.workspace.name}${w.hidden ? "*" : ""}`);

  test("a hidden one is listed after the shown ones only while it is open or needs you", () => {
    expect(listed(barHosts({ hosts, models }))).toEqual(["a", "b", "asks*"]);

    const open = { hostKey: "local", workspaceId: WorkspaceId.make("quiet") };

    expect(listed(barHosts({ hosts, models, open }))).toEqual(["a", "b", "quiet*", "asks*"]);
  });

  test("a needs-you session dismissed on this Mac doesn't bring its hidden Workspace back", () => {
    const quiet = new Set(["local\u0000n1"]);

    expect(listed(barHosts({ hosts, models, quiet }))).toEqual(["a", "b"]);
  });

  test("hidden chips take no ⌃N and don't count towards the machine bar", () => {
    const bar = barHosts({ hosts, models });

    expect(barWorkspaces(bar).map((w) => w.workspace.name)).toEqual(["a", "b"]);
  });

  test("the Host still counts what needs you in its hidden Workspaces", () => {
    expect(barHosts({ hosts, models })[0]?.summary.needsYou).toBe(1);
  });

  test("shown and hidden lists split every Workspace, oldest first", () => {
    expect(shownWorkspaces(models.local).map((w) => w.name)).toEqual(["a", "b"]);
    expect(hiddenWorkspaces(models.local).map((w) => w.name)).toEqual(["quiet", "asks"]);
  });
});

describe("revealing the open chip (ENG-499)", () => {
  const view = { start: 100, size: 400 };

  test("a chip past the right edge scrolls in with its padding", () => {
    expect(revealOffset(view, { start: 560, size: 120 }, 16)).toBe(296);
  });

  test("a chip before the left edge scrolls back to it, never below zero", () => {
    expect(revealOffset(view, { start: 40, size: 120 }, 16)).toBe(24);
    expect(revealOffset(view, { start: 4, size: 120 }, 16)).toBe(0);
  });

  test("a chip already in view leaves the bar where it is", () => {
    expect(revealOffset(view, { start: 200, size: 120 }, 16)).toBe(100);
  });
});

describe("the bar's edge fade (ENG-499)", () => {
  test("no fade when every chip fits", () => {
    expect(edgeFade({ offset: 0, view: 800, content: 800 })).toBe("none");
  });

  test("only the side with chips past it fades", () => {
    expect(edgeFade({ offset: 0, view: 800, content: 1400 })).toBe("end");
    expect(edgeFade({ offset: 600, view: 800, content: 1400 })).toBe("start");
    expect(edgeFade({ offset: 300, view: 800, content: 1400 })).toBe("both");
  });

  test("a subpixel remainder at the end doesn't fade", () => {
    expect(edgeFade({ offset: 599.5, view: 800, content: 1400 })).toBe("start");
  });
});
