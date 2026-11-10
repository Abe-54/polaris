/**
 * The pull request list as Review shows it (Paper R3, DESIGN.md Review → Pull requests):
 * groups (Agent Sessions with Turns to accept among them), fixed lanes, the header caption
 * and the account filter. Pure, so it is tested; the notices above the list are in `notices.ts`.
 */
import { harnessHue } from "@polaris/ui";
import type { SessionId } from "@polaris/protocol";
import type { OpenPull } from "../../../../shared/api.ts";
import {
  type GitHubAccountsView,
  type PullListView,
  type PullRowView,
  type WorkspaceRef,
  hostOf,
  repoOfRow,
} from "../../../../shared/github.ts";
import { age, plural } from "../../../shell/copy.ts";
import {
  readySessions,
  type SessionInfo,
  type TurnRange,
  unacceptedTurns,
} from "../../review/model/queue.ts";
import { checkoutKey, pullKey, type RiskLane } from "./risk.ts";
import { layerText } from "./stack.ts";

export type GroupId = "requested" | "sessions" | "mine" | "other";

/** Where a Workspace lives, as the list needs it. */
export interface PlaceInfo {
  /** The Workspace's name; null when the Host hasn't said (yet). */
  readonly workspace: string | null;
  readonly hostLabel: string;
  readonly connected: boolean;
  /** "reconnecting", "offline"…: shown when the Host isn't connected. */
  readonly state: string;
}

export type PlaceOf = (ref: WorkspaceRef) => PlaceInfo | null;

export interface WorkspaceLane {
  readonly name: string;
  /** "Linux VM · checked out", "Mac Studio · +1 host", "Linux VM · reconnecting". */
  readonly where: string;
  /** The Host isn't connected: only this lane dims; the pull request comes from GitHub. */
  readonly away: boolean;
}

export interface PullRowModel {
  readonly kind: "pull";
  readonly id: string;
  readonly pull: OpenPull;
  readonly title: string;
  readonly meta: string;
  /** Null for a repository no Workspace points at. */
  readonly workspace: WorkspaceLane | null;
  readonly additions: number;
  readonly deletions: number;
  readonly risk: RiskLane;
  readonly updated: string;
  /** "2/4" when it's a layer of a stack. */
  readonly layer: string | null;
}

/** Lines added and removed. */
export interface Changes {
  readonly additions: number;
  readonly deletions: number;
}

/** An Agent Session whose last Turn ended with Turns not yet accepted (R3, R2). */
export interface SessionRowModel {
  readonly kind: "session";
  readonly id: string;
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly harness: string;
  readonly title: string;
  /** "Claude Code · turns 22–24 · 3 since your last review". */
  readonly meta: string;
  readonly workspace: WorkspaceLane | null;
  /** Its not-yet-committed Turns' lines; null until the Host says. */
  readonly changes: Changes | null;
  readonly risk: RiskLane;
  readonly updated: string;
}

export type RowModel = PullRowModel | SessionRowModel;

export interface GroupModel {
  readonly id: GroupId;
  readonly label: string;
  readonly count: number;
  readonly rows: ReadonlyArray<RowModel>;
  /** Rows behind "Show N more". */
  readonly more: number;
}

export interface AccountSegment {
  readonly id: number;
  readonly login: string;
  readonly avatarUrl: string;
}

export interface ListModel {
  readonly caption: string;
  /** Shown only with two or more accounts. */
  readonly accounts: ReadonlyArray<AccountSegment>;
  readonly groups: ReadonlyArray<GroupModel>;
  readonly total: number;
}

export interface ListInput {
  readonly list: PullListView;
  readonly accounts: GitHubAccountsView | null;
  /** Null for all accounts. */
  readonly accountId: number | null;
  readonly placeOf: PlaceOf;
  /** `checkoutKey` → the Host label of its Review Checkout, when one exists. */
  readonly checkouts: ReadonlyMap<string, string>;
  /** A Review subject's key (`pull:owner/name#n`, `session:host:id`) → its risk lane. */
  readonly riskOf: (subjectKey: string) => RiskLane;
  /** Every Agent Session, for "Agent sessions ready". */
  readonly sessions: ReadonlyArray<SessionInfo>;
  /** A ready session's changes at its Turn count, when known. */
  readonly changesOf: (hostKey: string, sessionId: string, turnCount: number) => Changes | null;
  /** A Host by key, for a session's workspace lane. */
  readonly hostOf: (hostKey: string) => Omit<PlaceInfo, "workspace"> | null;
  /** Groups the user expanded past their first rows. */
  readonly expanded: ReadonlySet<GroupId>;
  readonly now: number;
}

/** "Other open" shows this many until expanded; the other groups show everything. */
export const OTHER_LIMIT = 8;

const LABELS: Readonly<Record<GroupId, string>> = {
  requested: "Review requested",
  sessions: "Agent sessions ready",
  mine: "Mine",
  other: "Other open",
};

const repoRef = (row: PullRowView) => repoOfRow(row);

const metaOf = (row: PullRowView, group: PullGroupId) => {
  const who = group === "mine" ? row.headRefName : (row.author?.login ?? null);

  return [`#${row.number}`, row.repo, row.isDraft ? "draft" : null, who]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
};

const laneOf = (row: PullRowView, placeOf: PlaceOf, checkout: string | undefined) => {
  const places = row.workspaces.flatMap((ref) => {
    const place = placeOf(ref);

    return place === null ? [] : [place];
  });

  const primary = places.find((p) => p.connected) ?? places[0];

  if (primary === undefined) return null;

  const hosts = new Set(places.map((p) => p.hostLabel)).size;
  const others = hosts > 1 ? `+${plural(hosts - 1, "host")}` : null;
  const detail = checkout === undefined ? others : "checked out";
  const status = primary.connected ? detail : primary.state;

  return {
    name: primary.workspace ?? repoRef(row).name,
    where: [checkout ?? primary.hostLabel, status].filter((p) => p !== null).join(" · "),
    away: !primary.connected,
  };
};

type PullGroupId = Exclude<GroupId, "sessions">;

const rowOf = (row: PullRowView, group: PullGroupId, input: ListInput): PullRowModel => {
  const repo = repoRef(row);
  const { owner, name } = repo;
  const key = pullKey(owner, name, row.number);

  return {
    kind: "pull",
    id: row.id,
    pull: { repo, number: row.number, pullId: row.id },
    title: row.title,
    meta: metaOf(row, group),
    workspace: laneOf(
      row,
      input.placeOf,
      input.checkouts.get(checkoutKey(hostOf(repo), owner, name, row.number))
    ),
    additions: row.additions,
    deletions: row.deletions,
    risk: input.riskOf(`pull:${key}`),
    updated: age(row.updatedAt, input.now),
    layer: row.stack === null || row.stack === undefined ? null : layerText(row.stack),
  };
};

/** A stack's key in its repository: GitHub's number, or its trunk and bottom layer. */
const stackKey = (row: PullRowView) =>
  row.stack === null || row.stack === undefined
    ? null
    : `${row.host ?? ""}/${row.repo}:${row.stack.number ?? `${row.stack.trunk}:${row.stack.members[0]?.number ?? 0}`}`;

/** A group's rows with each stack's layers together, top layer first, where its newest stood. */
export const stacksTogether = (rows: ReadonlyArray<PullRowView>): ReadonlyArray<PullRowView> => {
  const placed = new Set<string>();

  return rows.flatMap((row) => {
    const key = stackKey(row);

    if (key === null) return [row];

    if (placed.has(key)) return [];
    placed.add(key);

    return rows
      .filter((r) => stackKey(r) === key)
      .toSorted((a, b) => (b.stack?.position ?? 0) - (a.stack?.position ?? 0));
  });
};

const turnsOf = ({ first, last }: TurnRange) =>
  first >= last ? `turn ${last}` : `turns ${first}–${last}`;

/** Accepting is an Agent Session's review: Turns since the last accept, once there was one. */
const sinceReview = ({ since }: TurnRange) =>
  since === null ? null : `${since} since your last review`;

/** The sessions "Agent sessions ready" shows, newest first, as the queue picks them. */
export const readyInfos = (sessions: ReadonlyArray<SessionInfo>): ReadonlyArray<SessionInfo> => {
  const byId = new Map(sessions.map((s) => [`${s.hostKey}:${s.id}`, s]));

  return readySessions(sessions).flatMap((ready) => {
    const info = byId.get(ready.id);

    return info === undefined ? [] : [info];
  });
};

const sessionRows = (input: ListInput): ReadonlyArray<SessionRowModel> =>
  readyInfos(input.sessions).map((info) => {
    const host = input.hostOf(info.hostKey);

    return {
      kind: "session",
      id: `${info.hostKey}:${info.id}`,
      hostKey: info.hostKey,
      sessionId: info.id,
      harness: info.harness,
      title: info.title || "Untitled session",
      meta: [
        harnessHue(info.harness).name,
        turnsOf(unacceptedTurns(info)),
        sinceReview(unacceptedTurns(info)),
      ]
        .filter((part) => part !== null)
        .join(" · "),
      changes: input.changesOf(info.hostKey, info.id, info.turnCount),
      workspace:
        host === null
          ? null
          : {
              name: info.workspaceName ?? host.hostLabel,
              where: host.connected ? host.hostLabel : `${host.hostLabel} · ${host.state}`,
              away: !host.connected,
            },
      risk: input.riskOf(`session:${info.hostKey}:${info.id}`),
      updated: age(info.updatedAt, input.now),
    };
  });

const captionOf = (rows: ReadonlyArray<PullRowView>, input: ListInput) => {
  const repos = new Set(rows.map((r) => r.repo.toLowerCase())).size;

  const hosts = new Set(
    rows.flatMap((r) => r.workspaces.flatMap((w) => input.placeOf(w)?.hostLabel ?? []))
  ).size;

  const updatedAt = input.list.updatedAt;

  return [
    `${rows.length} open in ${plural(repos, "repo")}`,
    hosts === 0 ? null : `matched to workspaces on ${plural(hosts, "host")}`,
    updatedAt === null ? "checking GitHub…" : `updated ${updatedText(updatedAt, input.now)}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

const updatedText = (at: number, now: number) => {
  const text = age(new Date(at).toISOString(), now);

  return text === "now" ? "just now" : `${text} ago`;
};

const groupOf = (
  id: GroupId,
  rows: ReadonlyArray<RowModel>,
  input: ListInput
): ReadonlyArray<GroupModel> => {
  if (rows.length === 0) return [];

  const limit = id === "other" && !input.expanded.has(id) ? OTHER_LIMIT : rows.length;

  return [
    {
      id,
      label: LABELS[id],
      count: rows.length,
      rows: rows.slice(0, limit),
      more: Math.max(0, rows.length - limit),
    },
  ];
};

export const listModel = (input: ListInput): ListModel => {
  const pick = (rows: ReadonlyArray<PullRowView>) =>
    input.accountId === null ? rows : rows.filter((r) => r.accountId === input.accountId);

  const pulls = (id: PullGroupId) =>
    stacksTogether(pick(input.list[id])).map((r) => rowOf(r, id, input));

  const all = (["requested", "mine", "other"] as const).flatMap((id) => pick(input.list[id]));

  // Agent Sessions belong to no GitHub account: only "All accounts" shows them.
  const sessions = input.accountId === null ? sessionRows(input) : [];

  const groups = [
    ...groupOf("requested", pulls("requested"), input),
    ...groupOf("sessions", sessions, input),
    ...groupOf("mine", pulls("mine"), input),
    ...groupOf("other", pulls("other"), input),
  ];

  const signedIn = (input.accounts?.accounts ?? []).filter((a) => a.state === "ok");

  return {
    caption: captionOf(all, input),
    accounts:
      signedIn.length < 2
        ? []
        : signedIn.map((a) => ({ id: a.id, login: a.login, avatarUrl: a.avatarUrl })),
    groups,
    total: all.length + sessions.length,
  };
};
