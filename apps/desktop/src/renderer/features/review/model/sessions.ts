/**
 * Every Agent Session as Review's queue and the pull request list's "Agent sessions ready"
 * group need it, across every Host; a Reviewer's own read-only sessions are left out.
 */
import type { AppState } from "../../../store/store.ts";
import { isReviewSession } from "../../sessions/model/sections.ts";
import type { SessionInfo } from "./queue.ts";

export const sessionsOf = (models: AppState["hostModels"]): ReadonlyArray<SessionInfo> =>
  Object.entries(models).flatMap(([hostKey, model]) =>
    [...model.sessions.values()].flatMap(({ session }) =>
      isReviewSession(session)
        ? []
        : [
            {
              hostKey,
              id: session.id,
              title: session.title,
              harness: session.harness,
              state: session.state,
              turnCount: session.turnCount,
              acceptedThroughIndex: session.acceptedThroughIndex ?? null,
              userTurns:
                session.currentUserTurn == null
                  ? null
                  : {
                      current: session.currentUserTurn.number,
                      acceptedThrough: session.acceptedThroughUserTurn ?? null,
                    },
              updatedAt: session.updatedAt,
              workspaceName: model.workspaces.get(session.workspaceId)?.name ?? null,
            },
          ]
    )
  );
