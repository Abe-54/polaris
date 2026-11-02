/**
 * Watches every accepted session's pull request through the GitHub client (its "sessions"
 * group) and archives the session once the pull request merges or closes (ENG-224).
 */
import { SessionId } from "@polaris/protocol";
import { useEffect, useMemo, useRef } from "react";
import { Commands } from "../../../commands.ts";
import { useApp } from "../../../shell/hooks.ts";
import { polaris } from "../../bridge.ts";
import { dispatch } from "../../session/dispatch.ts";
import { settingsStore } from "../../settings/store.ts";
import { type LinkedSession, linkedSessions, toArchive } from "../model/linked.ts";

/** GitHub's node id per pull request, read once per launch. */
const pullIds = new Map<string, string>();

const pullIdOf = async (linked: LinkedSession): Promise<string | null> => {
  const key = `${linked.pull.repo.owner}/${linked.pull.repo.name}#${linked.pull.number}`;
  const known = pullIds.get(key);

  if (known !== undefined) return known;
  const detail = await polaris().request("github.pull.detail", { pull: linked.pull });

  if (!detail.ok) return null;
  pullIds.set(key, detail.value.id);

  return detail.value.id;
};

export const LinkedPullsPublisher = () => {
  // Host models change with Host events, not with a Turn's streaming deltas.
  const hostModels = useApp((s) => s.hostModels);
  const signature = useMemo(() => JSON.stringify(linkedSessions(hostModels)), [hostModels]);
  // SAFETY: `signature` is `linkedSessions`' result, serialized above.
  const linked = useMemo(() => JSON.parse(signature) as ReadonlyArray<LinkedSession>, [signature]);
  const current = useRef(linked);
  const asked = useRef(new Set<string>());

  current.current = linked;

  useEffect(() => {
    let live = true;

    void Promise.all(linked.map(async (l) => ({ l, pullId: await pullIdOf(l) }))).then(
      (resolved) => {
        if (!live) return;

        const checkouts = resolved.flatMap(({ l, pullId }) =>
          pullId === null ? [] : [{ key: l.key, pull: l.pull, pullId }]
        );

        void polaris().request("github.checkouts.watch", { checkouts, group: "sessions" });
      }
    );

    return () => {
      live = false;
    };
  }, [linked]);

  useEffect(() => {
    return polaris().subscribe(
      "github.checkouts",
      {},
      {
        items: (items) => {
          const states = items.at(-1) ?? [];

          for (const l of toArchive(states, current.current, asked.current)) {
            asked.current.add(l.key);
            void dispatch(
              l.hostKey,
              Commands.ArchiveSession({
                sessionId: SessionId.make(l.sessionId),
                deleteMergedBranch: settingsStore.getState().sessions.deleteMergedBranch,
              })
            );
          }
        },
      }
    );
  }, []);

  return null;
};
