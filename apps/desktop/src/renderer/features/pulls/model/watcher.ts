/**
 * Keeps the GitHub client's watched repositories (`github.watch`) in step with every git
 * Workspace on every Host, hidden ones included (ENG-185). Each Workspace's remotes are
 * read once its Host is connected and again on `recheck` (ENG-723); the last ones read are
 * kept on this Mac, so a Host that is away still has its pull requests matched.
 */
import type { WorkspaceRef } from "../../../../shared/github.ts";
import { readRemotes, type ReadText } from "./remotes.ts";

export interface Candidate {
  readonly hostKey: string;
  readonly workspaceId: string;
  readonly path: string;
  /** Its Host is connected: the remotes can be read now. */
  readonly readable: boolean;
}

export interface WatchEntry {
  readonly workspace: WorkspaceRef;
  readonly remotes: ReadonlyArray<string>;
}

interface Known {
  readonly path: string;
  readonly remotes: ReadonlyArray<string>;
}

export interface WatcherInput {
  /** Reads a text file on a Host; null when missing or unreadable. */
  readonly read: (hostKey: string) => ReadText;
  readonly watch: (entries: ReadonlyArray<WatchEntry>) => void;
  readonly load: () => Readonly<Record<string, Known>>;
  readonly save: (known: Readonly<Record<string, Known>>) => void;
}

export interface Watcher {
  readonly update: (candidates: ReadonlyArray<Candidate>) => Promise<void>;
  /** Reads every connected Workspace's remotes again, as one added since may match pull requests. */
  readonly recheck: () => Promise<void>;
  /** The remotes last read from the Host's Workspaces. */
  readonly remotesOn: (hostKey: string) => ReadonlyArray<string>;
}

const keyOf = (c: { readonly hostKey: string; readonly workspaceId: string }) =>
  `${c.hostKey}/${c.workspaceId}`;

export const createWatcher = ({ read, watch, load, save }: WatcherInput): Watcher => {
  const known = new Map(Object.entries(load()));
  /** Read since the last recheck (or being read): never twice. */
  const fresh = new Set<string>();
  let sent: string | null = null;
  let latest: ReadonlyArray<Candidate> = [];

  const publish = () => {
    const entries = latest.flatMap((c): ReadonlyArray<WatchEntry> => {
      const entry = known.get(keyOf(c));

      return entry === undefined || entry.path !== c.path || entry.remotes.length === 0
        ? []
        : [
            {
              workspace: { hostKey: c.hostKey, workspaceId: c.workspaceId },
              remotes: entry.remotes,
            },
          ];
    });

    const text = JSON.stringify(entries);

    if (text === sent) return;

    sent = text;
    watch(entries);
  };

  const refresh = async (c: Candidate) => {
    const key = keyOf(c);

    fresh.add(key);

    try {
      known.set(key, { path: c.path, remotes: await readRemotes(c.path, read(c.hostKey)) });
      save(Object.fromEntries(known));
    } catch {
      // A failed read keeps what was known; the next launch tries again.
    }
  };

  const update = async (candidates: ReadonlyArray<Candidate>) => {
    latest = candidates;
    publish();

    const stale = candidates.filter((c) => c.readable && !fresh.has(keyOf(c)));

    if (stale.length === 0) return;

    await Promise.all(stale.map(refresh));
    publish();
  };

  return {
    update,
    recheck: () => {
      fresh.clear();

      return update(latest);
    },
    remotesOn: (hostKey) =>
      latest
        .filter((c) => c.hostKey === hostKey)
        .flatMap((c) => known.get(keyOf(c))?.remotes ?? []),
  };
};
