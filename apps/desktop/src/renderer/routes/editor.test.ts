import { describe, expect, test } from "bun:test";
import {
  ReviewCheckout,
  ReviewCheckoutId,
  ReviewSubject,
  Workspace,
  WorkspaceId,
  Worktree,
  WorktreeId,
} from "@polaris/protocol";
import type { HostModel } from "../store/hostModel.ts";
import {
  editorRequest,
  editorRoute,
  openInEditor,
  parseLocation,
  resolvePath,
  spelledAs,
  workspaceFor,
} from "./editor.ts";
import { hostModel } from "./fixtures.testing.ts";

const withWorktree = (model: HostModel, workspace: string, path: string): HostModel => ({
  ...model,
  worktrees: new Map([
    [
      "wt",
      new Worktree({
        id: WorktreeId.make("wt"),
        workspaceId: WorkspaceId.make(workspace),
        path,
        branch: "feature",
        head: "abc",
        createdBySessionId: null,
        isMain: false,
      }),
    ],
  ]),
});

const model = withWorktree(
  hostModel([{ id: "polaris" }, { id: "polaris/apps" }, { id: "sightline" }]),
  "sightline",
  "/code/sightline.worktrees/feature"
);

const app = { hostModels: { local: model } };

describe("resolvePath", () => {
  test.each<[string, string, string | null, string]>([
    [
      "joins a relative path to its root and folds dots",
      "src/./a/../b.ts",
      "/code/polaris/",
      "/code/polaris/src/b.ts",
    ],
    ["keeps an absolute path", "/etc/hosts", "/code", "/etc/hosts"],
    ["stays relative with no root", "src/a.ts", null, "src/a.ts"],
  ])("%s", (_case, path, root, resolved) => {
    expect(resolvePath(path, root)).toBe(resolved);
  });
});

describe("workspaceFor", () => {
  test("picks the deepest Workspace holding the path", () => {
    expect(workspaceFor(model, "/code/polaris/apps/x.ts")).toBe(WorkspaceId.make("polaris/apps"));
    expect(workspaceFor(model, "/code/polaris/README.md")).toBe(WorkspaceId.make("polaris"));
  });

  test("a Worktree's file belongs to its Workspace", () => {
    expect(workspaceFor(model, "/code/sightline.worktrees/feature/a.ts")).toBe(
      WorkspaceId.make("sightline")
    );
  });

  test("a sibling with a shared prefix is not inside", () => {
    expect(workspaceFor(model, "/code/polaris-old/a.ts")).toBeNull();
  });
});

describe("editorRequest", () => {
  test("resolves the path and keeps 1-based positions", () => {
    expect(
      editorRequest(app, { hostKey: "local", path: "src/a.ts", root: "/code/polaris", line: 12 })
    ).toEqual({
      hostKey: "local",
      workspaceId: WorkspaceId.make("polaris"),
      path: "/code/polaris/src/a.ts",
      line: 12,
      column: null,
      folder: false,
    });
  });

  test("drops a line below 1", () => {
    expect(editorRequest(app, { hostKey: "local", path: "/code/polaris/a", line: 0 })?.line).toBe(
      null
    );
  });

  test("null outside every Workspace, or on an unknown Host", () => {
    expect(editorRequest(app, { hostKey: "local", path: "/tmp/a" })).toBeNull();
    expect(editorRequest(app, { hostKey: "pi", path: "/code/polaris/a" })).toBeNull();
  });

  test("a given Workspace narrows the search but never stands in for containment", () => {
    const sightline = WorkspaceId.make("sightline");

    expect(
      editorRequest(app, { hostKey: "local", path: "/tmp/a", workspaceId: sightline })
    ).toBeNull();
    expect(
      editorRequest(app, {
        hostKey: "local",
        path: "/Users/me/.codex/auth.json",
        root: "/code/sightline",
        workspaceId: sightline,
      })
    ).toBeNull();
    expect(
      editorRequest(app, {
        hostKey: "local",
        path: "../../Users/me/.codex/auth.json",
        root: "/code/sightline",
        workspaceId: sightline,
      })
    ).toBeNull();
    expect(
      editorRequest(app, { hostKey: "local", path: "/code/polaris/a.ts", workspaceId: sightline })
    ).toBeNull();
  });

  test("a Review Checkout outside the Workspace folder opens in its Workspace", () => {
    const checkout = new ReviewCheckout({
      id: ReviewCheckoutId.make("c1"),
      workspaceId: WorkspaceId.make("sightline"),
      subject: ReviewSubject.cases.PullRequest.make({
        pullRequest: { repo: { host: "github.com", owner: "acme", name: "x" }, number: 42 },
        baseRef: "main",
      }),
      path: "/code/sightline.worktrees/.review/pr-42",
      state: "ready",
      blocked: null,
      head: "abc",
      mergeBase: "b1",
      latestHead: "abc",
      latestBase: "b0",
      reviewedHead: null,
      reviewedMergeBase: null,
      openedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });

    const withCheckout = { ...model, reviewCheckouts: new Map([["c1", checkout]]) };

    expect(
      editorRequest(
        { hostModels: { local: withCheckout } },
        {
          hostKey: "local",
          path: "src/a.ts",
          root: checkout.path,
          workspaceId: WorkspaceId.make("sightline"),
        }
      )
    ).toMatchObject({
      workspaceId: WorkspaceId.make("sightline"),
      path: "/code/sightline.worktrees/.review/pr-42/src/a.ts",
    });
  });
});

describe("openInEditor", () => {
  const recorder = () => {
    const calls: Array<string> = [];

    return {
      calls,
      actions: {
        selectWorkspace: (t: { readonly workspaceId: string }) => calls.push(`ws:${t.workspaceId}`),
        setMode: (m: string) => calls.push(`mode:${m}`),
      },
    };
  };

  test("selects the Workspace, then Edit, with a fresh seq each time", () => {
    const { calls, actions } = recorder();
    const context = { app, actions, selected: { hostKey: "local", workspaceId: "sightline" } };

    expect(openInEditor(context, { hostKey: "local", path: "/code/polaris/a.ts", line: 3 })).toBe(
      true
    );
    const first = editorRoute.getState().request?.seq ?? 0;

    openInEditor(context, { hostKey: "local", path: "/code/polaris/a.ts", line: 3 });
    expect(editorRoute.getState().request?.seq).toBe(first + 1);
    expect(calls).toEqual(["ws:polaris", "mode:edit", "ws:polaris", "mode:edit"]);
  });

  test("keeps the selection when the Workspace is already selected", () => {
    const { calls, actions } = recorder();
    const context = { app, actions, selected: { hostKey: "local", workspaceId: "polaris" } };

    openInEditor(context, { hostKey: "local", path: "/code/polaris/a.ts" });
    expect(calls).toEqual(["mode:edit"]);
  });

  test("does nothing outside every Workspace", () => {
    const { calls, actions } = recorder();
    const context = { app, actions, selected: { hostKey: null, workspaceId: null } };

    expect(openInEditor(context, { hostKey: "local", path: "/tmp/a" })).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("symlinked roots", () => {
  const linked = hostModel([{ id: "smoke" }]);

  const tmp = {
    ...linked,
    workspaces: new Map(
      [...linked.workspaces].map(([k, w]) => [
        k,
        new Workspace({
          id: w.id,
          path: "/var/folders/T/smoke",
          name: w.name,
          isGitRepo: w.isGitRepo,
          worktreeRoot: w.worktreeRoot,
          hidden: w.hidden,
          registeredAt: w.registeredAt,
        }),
      ])
    ),
  };

  test("a real path opens spelled as the Workspace spells it", () => {
    expect(spelledAs("/var/folders/T/smoke", "/private/var/folders/T/smoke/README.md")).toBe(
      "/var/folders/T/smoke/README.md"
    );
    expect(spelledAs("/private/tmp/x", "/tmp/x/a")).toBe("/private/tmp/x/a");
    expect(spelledAs("/code/x", "/private/var/a")).toBe("/private/var/a");
  });

  test("the main Worktree's realpath spelling doesn't win over the Workspace's", () => {
    const withMain: HostModel = {
      ...tmp,
      worktrees: new Map([
        [
          "main",
          new Worktree({
            id: WorktreeId.make("main"),
            workspaceId: WorkspaceId.make("smoke"),
            path: "/private/var/folders/T/smoke",
            branch: "main",
            head: "abc",
            createdBySessionId: null,
            isMain: true,
          }),
        ],
      ]),
    };

    expect(
      editorRequest(
        { hostModels: { local: withMain } },
        { hostKey: "local", path: "README.md", root: "/private/var/folders/T/smoke" }
      )?.path
    ).toBe("/var/folders/T/smoke/README.md");
  });

  test("the request carries the Workspace's spelling", () => {
    expect(
      editorRequest(
        { hostModels: { local: tmp } },
        { hostKey: "local", path: "/private/var/folders/T/smoke/README.md" }
      )
    ).toMatchObject({
      workspaceId: WorkspaceId.make("smoke"),
      path: "/var/folders/T/smoke/README.md",
    });
  });
});

describe("parseLocation", () => {
  test("path, line and column", () => {
    expect(parseLocation("src/a.ts:12:4")).toEqual({ path: "src/a.ts", line: 12, column: 4 });
    expect(parseLocation("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12, column: null });
    expect(parseLocation("src/a.ts")).toEqual({ path: "src/a.ts", line: null, column: null });
  });
});
