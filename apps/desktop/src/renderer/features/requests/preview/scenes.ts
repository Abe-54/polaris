/**
 * The send log and states scenes (Paper Q2, Q3) for `#requests/<scene>`: `q2` the send log with an
 * agent's failed Send open; `approval` an agent's Send waiting on an Origin Approval; `empty` a
 * checkout with no `.http` files; `offline` its Host offline before anything was read.
 */
import type { AppState } from "../../../store/store.ts";
import { HOST, host } from "../../traces/preview/appState.ts";
import { FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import type { RequestsApi } from "../data/api.ts";
import { openSend } from "../model/sendLogView.ts";
import { setSidebarView } from "../model/store.ts";
import { fixtureOriginApproval, withPendingApprovals } from "./approvalFixtures.ts";
import type { FixtureOptions } from "./fixtureApi.ts";
import { fixtureSends } from "./sendLogFixtures.ts";

const at = { hostKey: HOST, sessionId: FIXTURE_SESSION };

export interface StatesScene {
  readonly options: FixtureOptions;
  readonly state: (state: AppState) => AppState;
  readonly api: (api: RequestsApi) => RequestsApi;
  readonly play: () => void;
}

const same = <A>(a: A) => a;

export const statesScene = (scene: string): StatesScene | null => {
  const sends = fixtureSends(Date.now());

  switch (scene) {
    case "q2":
      return {
        options: { sends },
        state: same,
        api: same,
        play: () => {
          setSidebarView(at, "send-log");
          const failed = sends.find((s) => s.status === 500);

          if (failed !== undefined) openSend(at, failed, new Set());
        },
      };
    case "approval":
      return {
        options: { sends },
        state: (state) =>
          withPendingApprovals(state, HOST, FIXTURE_SESSION, [
            fixtureOriginApproval(FIXTURE_SESSION, "r-staging-post"),
          ]),
        api: same,
        play: () => undefined,
      };
    case "empty":
      return { options: { files: [] }, state: same, api: same, play: () => undefined };
    case "offline":
      return {
        options: {},
        state: (state) => ({
          ...state,
          hosts: [{ ...host, status: { ...host.status, state: "offline" } }],
        }),
        // An offline Host's watch answers nothing.
        api: (api) => ({
          ...api,
          watch: () => () => undefined,
          watchSendLog: () => () => undefined,
        }),
        play: () => undefined,
      };
    default:
      return null;
  }
};
