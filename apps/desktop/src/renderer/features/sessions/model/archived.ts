/**
 * The sidebar's archived section (ENG-679): a Workspace's archived sessions, newest first,
 * workers left out as everywhere else. Pure, so it is tested.
 */
import type { SessionEntry } from "../../../store/hostModel.ts";
import { isWorker, workerSessionsOf } from "../../constellation/model/workers.ts";

interface ViewLike {
  readonly constellation: {
    readonly name: string;
    readonly state: string;
    readonly leadSessionId: string;
    readonly attempts: ReadonlyArray<{ readonly sessionId: string }>;
  };
}

export interface ArchivedRow {
  readonly entry: SessionEntry;
  /** The Constellation this session leads that hasn't ended, which archiving left leaderless. */
  readonly leaderless: { readonly name: string; readonly state: string } | null;
}

const ENDED: ReadonlySet<string> = new Set(["completed", "archived"]);

export const archivedOf = (
  sessions: Iterable<SessionEntry>,
  workspaceId: string,
  views: ReadonlyArray<ViewLike>
): ReadonlyArray<ArchivedRow> => {
  const workers = workerSessionsOf(views);

  const leading = new Map(
    views.flatMap(({ constellation: c }) =>
      ENDED.has(c.state) ? [] : [[c.leadSessionId, { name: c.name, state: c.state }] as const]
    )
  );

  return [...sessions]
    .filter(
      (e) =>
        e.session.state === "archived" &&
        e.session.workspaceId === workspaceId &&
        !isWorker(e.session, workers)
    )
    .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
    .map((entry) => ({ entry, leaderless: leading.get(entry.session.id) ?? null }));
};

/** Folded by default; open on its own while a running Constellation lost its lead to it. */
export const archivedOpen = (rows: ReadonlyArray<ArchivedRow>, folded: boolean | undefined) =>
  rows.some((r) => r.leaderless !== null) ? folded !== true : folded === false;
