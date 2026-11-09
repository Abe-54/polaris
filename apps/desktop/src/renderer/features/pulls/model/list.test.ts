import { describe, expect, test } from "bun:test";
import type {
  GitHubAccountsView,
  PullListView,
  PullRowView,
  RepoAccessView,
  WorkspaceRef,
} from "../../../../shared/github.ts";
import { SessionId } from "@polaris/protocol";
import type { SessionInfo } from "../../review/model/queue.ts";
import { listModel, type ListInput, OTHER_LIMIT, type PlaceInfo, stacksTogether } from "./list.ts";
import { laneOf, NOT_RUN } from "./risk.ts";
import { noticesOf } from "./notices.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

const ws = (hostKey: string, workspaceId = "w1"): WorkspaceRef => ({ hostKey, workspaceId });

const row = (id: string, patch: Partial<PullRowView> = {}): PullRowView => ({
  id,
  number: 88,
  title: `Pull ${id}`,
  url: "https://github.com/acme/widgets/pull/88",
  repo: "acme/widgets",
  isDraft: false,
  author: { login: "mchen", avatarUrl: "" },
  headRefName: "mchen/income",
  headRefOid: "abc",
  baseRefName: "main",
  additions: 48,
  deletions: 12,
  updatedAt: "2026-10-01T10:00:00Z",
  reviewDecision: null,
  viewerLatestReview: null,
  requestedReviewers: [],
  accountId: 1,
  workspaces: [ws("linux")],
  ...patch,
});

const list = (patch: Partial<PullListView> = {}): PullListView => ({
  requested: [],
  mine: [],
  other: [],
  repos: [],
  updatedAt: NOW - 60_000,
  polling: "focused",
  throttledUntil: null,
  error: null,
  errorKind: null,
  ...patch,
});

const PLACES = new Map<string, PlaceInfo>(
  Object.entries({
    linux: { workspace: "widgets", hostLabel: "Linux VM", connected: true, state: "connected" },
    studio: { workspace: "widgets", hostLabel: "Mac Studio", connected: true, state: "connected" },
    away: { workspace: "sightline", hostLabel: "Pi", connected: false, state: "reconnecting" },
  })
);

const input = (patch: Partial<ListInput> = {}): ListInput => ({
  list: list(),
  accounts: null,
  accountId: null,
  placeOf: (ref) => PLACES.get(ref.hostKey) ?? null,
  checkouts: new Map(),
  riskOf: () => NOT_RUN,
  sessions: [],
  hostOf: (hostKey) => PLACES.get(hostKey) ?? null,
  changesOf: () => null,
  expanded: new Set(),
  now: NOW,
  ...patch,
});

const account = (id: number, login: string) => ({
  id,
  login,
  name: null,
  avatarUrl: "",
  scopes: [],
  missingScopes: [],
  state: "ok" as const,
  signedInAt: null,
  signedOutAt: null,
});

describe("listModel", () => {
  test("groups in order, with the caption Paper R3 shows", () => {
    const model = listModel(
      input({
        list: list({
          requested: [
            row("a"),
            row("b", { repo: "dcai/warehouse", workspaces: [ws("studio"), ws("linux", "w2")] }),
          ],
          mine: [row("c", { isDraft: true })],
          other: [row("d", { workspaces: [] })],
        }),
      })
    );

    expect(model.groups.map((g) => [g.label, g.count])).toEqual([
      ["Review requested", 2],
      ["Mine", 1],
      ["Other open", 1],
    ]);
    expect(model.caption).toBe(
      "4 open in 2 repos · matched to workspaces on 2 hosts · updated 1m ago"
    );

    const [a, b] = model.groups[0]?.rows ?? [];

    expect(a?.meta).toBe("#88 · acme/widgets · mchen");
    expect(a?.workspace).toEqual({ name: "widgets", where: "Linux VM", away: false });
    expect(b?.workspace?.where).toBe("Mac Studio · +1 host");
    expect(model.groups[1]?.rows[0]?.meta).toBe("#88 · acme/widgets · draft · mchen/income");
    expect(model.groups[2]?.rows[0]?.workspace).toBeNull();
    expect(a?.updated).toBe("2h");
    expect(a?.kind === "pull" ? a.pull : null).toEqual({
      repo: { owner: "acme", name: "widgets" },
      number: 88,
      pullId: "a",
    });
  });

  test("a Host that isn't connected dims only the workspace lane; a checkout says so", () => {
    const model = listModel(
      input({
        list: list({ other: [row("x", { workspaces: [ws("away")] }), row("y", { number: 89 })] }),
        checkouts: new Map([["github.com/acme/widgets#89", "Linux VM"]]),
      })
    );

    const [x, y] = model.groups[0]?.rows ?? [];

    expect(x?.workspace).toEqual({ name: "sightline", where: "Pi · reconnecting", away: true });
    expect(y?.workspace?.where).toBe("Linux VM · checked out");
  });

  test("a GitHub Enterprise pull request keeps its host, for opening and its checkout", () => {
    const model = listModel(
      input({
        list: list({ requested: [row("g", { host: "ghe.acme.com" })] }),
        checkouts: new Map([["ghe.acme.com/acme/widgets#88", "Mac Studio"]]),
      })
    );

    const [g] = model.groups[0]?.rows ?? [];

    expect(g?.kind === "pull" ? g.pull.repo : null).toEqual({
      host: "ghe.acme.com",
      owner: "acme",
      name: "widgets",
    });
    expect(g?.workspace?.where).toBe("Mac Studio · checked out");
  });

  test("the risk lane comes from the pull request's or session's subject key", () => {
    const model = listModel(
      input({
        list: list({ requested: [row("a", { repo: "Acme/Widgets" })] }),
        riskOf: (key) =>
          key === "pull:acme/widgets#88" ? { kind: "found", severity: "high", count: 1 } : NOT_RUN,
      })
    );

    expect(model.groups[0]?.rows[0]?.risk).toEqual({ kind: "found", severity: "high", count: 1 });
  });

  test("Agent sessions ready sit after review requested, only for all accounts", () => {
    const session = (id: string, patch: Partial<SessionInfo> = {}): SessionInfo => ({
      hostKey: "studio",
      id: SessionId.make(id),
      title: `Session ${id}`,
      harness: "claude",
      state: "idle",
      turnCount: 24,
      acceptedThroughIndex: 20,
      userTurns: null,
      updatedAt: "2026-10-01T11:48:00Z",
      workspaceName: "polaris",
      ...patch,
    });

    const sessions = [
      session("s1"),
      session("s2", { state: "working" }),
      session("s3", { acceptedThroughIndex: 23 }),
      session("s4", { hostKey: "away", acceptedThroughIndex: 22 }),
    ];

    const all = listModel(
      input({ list: list({ requested: [row("a")], mine: [row("m")] }), sessions })
    );

    expect(all.groups.map((g) => g.id)).toEqual(["requested", "sessions", "mine"]);

    const rows = all.groups[1]?.rows ?? [];

    expect(rows.map((r) => r.id)).toEqual(["studio:s1", "away:s4"]);
    expect(rows[0]?.meta).toBe("Claude Code · turns 22–24 · 3 since your last review");
    expect(rows[0]?.workspace).toEqual({ name: "polaris", where: "Mac Studio", away: false });
    expect(rows[1]?.meta).toBe("Claude Code · turn 24 · 1 since your last review");
    expect(rows[1]?.workspace?.where).toBe("Pi · reconnecting");

    // The Daemon's user Turns name both ends: 24 Daemon Turns are 9 of the user's.
    const numbered = listModel(
      input({
        sessions: [session("s6", { userTurns: { current: 9, acceptedThrough: 6 } })],
      })
    );

    expect(numbered.groups[0]?.rows[0]?.meta).toBe(
      "Claude Code · turns 7–9 · 3 since your last review"
    );
    // Never accepted: no "since your last review"; changes once the Host says.

    const fresh = listModel(
      input({
        sessions: [session("s5", { acceptedThroughIndex: null, turnCount: 2 })],
        changesOf: (host, id, turns) =>
          host === "studio" && id === "s5" && turns === 2
            ? { additions: 214, deletions: 30 }
            : null,
      })
    ).groups[0]?.rows[0];

    expect(fresh?.meta).toBe("Claude Code · turns 1–2");
    expect(fresh?.kind === "session" ? fresh.changes : null).toEqual({
      additions: 214,
      deletions: 30,
    });
    expect(all.total).toBe(4);
    expect(
      listModel(input({ list: list({ mine: [row("m")] }), sessions, accountId: 1 })).groups.map(
        (g) => g.id
      )
    ).toEqual(["mine"]);
  });

  test("other open folds past its limit", () => {
    const other = Array.from({ length: OTHER_LIMIT + 3 }, (_, i) => row(`o${i}`));
    const folded = listModel(input({ list: list({ other }) }));

    expect(folded.groups[0]?.rows).toHaveLength(OTHER_LIMIT);
    expect(folded.groups[0]?.more).toBe(3);
    expect(
      listModel(input({ list: list({ other }), expanded: new Set(["other"]) })).groups[0]?.more
    ).toBe(0);
  });

  test("the account filter and its segments", () => {
    const accounts: GitHubAccountsView = {
      accounts: [account(1, "lucasdoell"), account(2, "lmd-work")],
      signIn: null,
      owners: {},
      workspaces: {},
      storageAvailable: true,
      manageUrl: "",
    };

    const both = list({ requested: [row("a"), row("b", { accountId: 2 })] });

    expect(listModel(input({ list: both, accounts })).accounts.map((a) => a.login)).toEqual([
      "lucasdoell",
      "lmd-work",
    ]);
    expect(listModel(input({ list: both, accounts, accountId: 2 })).total).toBe(1);
    expect(
      listModel(input({ list: both, accounts: { ...accounts, accounts: [account(1, "x")] } }))
        .accounts
    ).toEqual([]);
  });

  test("before the first poll", () => {
    expect(listModel(input({ list: list({ updatedAt: null }) })).caption).toBe(
      "0 open in 0 repos · checking GitHub…"
    );
  });
});

const access = (
  repo: string,
  state: RepoAccessView["state"],
  patch: Partial<RepoAccessView> = {}
): RepoAccessView => ({
  repo,
  state,
  accountId: null,
  login: null,
  permission: null,
  approvalUrl: null,
  ssoUrl: null,
  workspaces: [ws("studio"), ws("studio", "w2")],
  ...patch,
});

describe("stacks in the list", () => {
  const layer = (id: string, position: number, minutes: number) =>
    row(id, {
      number: position,
      updatedAt: new Date(NOW - minutes * 60_000).toISOString(),
      stack: {
        source: "github",
        number: 635,
        trunk: "nightly",
        position,
        size: 3,
        members: [],
      },
    });

  test("a stack's layers stay together, top first, where its newest stood; rows say their layer", () => {
    const rows = stacksTogether([row("a"), layer("l1", 1, 5), row("b"), layer("l3", 3, 90)]);

    expect(rows.map((r) => r.id)).toEqual(["a", "l3", "l1", "b"]);

    const model = listModel(input({ list: list({ requested: [layer("l1", 1, 5), row("b")] }) }));
    const [first, second] = model.groups[0]?.rows ?? [];

    expect(first?.kind === "pull" ? first.layer : null).toBe("1/3");
    expect(second?.kind === "pull" ? second.layer : "x").toBeNull();
  });
});

describe("laneOf", () => {
  const finding = (severity: "critical" | "high" | "medium" | "low", status = "open") => ({
    severity,
    status,
  });

  test("the highest open Severity and how many share it", () => {
    expect(
      laneOf({
        status: "completed",
        findings: [
          finding("low"),
          finding("high"),
          finding("high"),
          finding("critical", "dismissed"),
        ],
      })
    ).toEqual({ kind: "found", severity: "high", count: 2 });
  });

  test("never implies safe: none open, running, failed or none cached", () => {
    expect(laneOf({ status: "completed", findings: [finding("high", "resolved")] }).kind).toBe(
      "none"
    );
    expect(laneOf({ status: "running", findings: [] }).kind).toBe("running");
    expect(laneOf({ status: "failed", findings: [] }).kind).toBe("not-run");
    expect(laneOf(null).kind).toBe("not-run");
    // "Ask first" waiting, or the Reviewer switched off: Rules alone found nothing open.
    expect(
      laneOf({ status: "completed", layers: { agent: { status: "pending" } }, findings: [] }).kind
    ).toBe("rules-only");
    expect(
      laneOf({ status: "completed", layers: { agent: { status: "skipped" } }, findings: [] }).kind
    ).toBe("rules-only");
    expect(
      laneOf({ status: "completed", layers: { agent: { status: "completed" } }, findings: [] }).kind
    ).toBe("none");
  });
});

describe("noticesOf", () => {
  const hostLabelOf = (ref: WorkspaceRef) => PLACES.get(ref.hostKey)?.hostLabel ?? null;

  test("an owner nobody sees, grouped; a blocked organization repo; dismissals", () => {
    const repos = [
      access("acme-corp/api", "not-found"),
      access("acme-corp/web", "not-found", { workspaces: [] }),
      access("lockedorg/vault", "blocked", {
        approvalUrl: "https://a",
        ssoUrl: "https://s",
        workspaces: [ws("linux")],
      }),
      access("mona/dotfiles", "ok"),
      access("x/y", "no-account"),
    ];

    const notices = noticesOf({ list: list({ repos }), hostLabelOf, dismissed: new Set() });

    expect(notices.map((n) => n.title)).toEqual([
      "lockedorg hasn’t approved Polaris",
      "No GitHub account for acme-corp",
    ]);
    expect(notices[1]?.caption).toBe(
      "2 workspaces on Mac Studio point at it, so its pull requests aren’t listed"
    );
    expect(notices[0]?.caption).toContain(
      "or you sign in with SSO. 1 workspace on Linux VM points at it."
    );

    const dismissed = noticesOf({
      list: list({ repos }),
      hostLabelOf,
      dismissed: new Set(["no-account:acme-corp"]),
    });

    expect(dismissed).toHaveLength(1);
  });
});
