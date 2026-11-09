/**
 * The send log and states scenes (Paper Q2, Q3) for `#requests/<scene>`: `send-log` the send log with
 * an agent's failed Send open; `approval` an agent's Send waiting on an Origin Approval; `empty` a
 * checkout with no `.http` files; `offline` its Host offline before anything was read; `refused`
 * and `no-spans` those outcomes in the send pane.
 */
import type { TraceDetail } from "@polaris/protocol";
import type { AppState } from "../../../store/store.ts";
import { HOST, host } from "../../traces/preview/appState.ts";
import { buildTrace } from "../../traces/preview/build.ts";
import { FIXTURE_CHECKOUT, FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import type { RequestsApi } from "../data/api.ts";
import { openSend } from "../model/sendLogView.ts";
import { setLatestSend, setSidebarView } from "../model/store.ts";
import { fixtureOriginApproval, withPendingApprovals } from "./approvalFixtures.ts";
import type { FixtureOptions } from "./fixtureApi.ts";
import { fixtureSend, fixtureSends } from "./sendLogFixtures.ts";

const at = { hostKey: HOST, sessionId: FIXTURE_SESSION };

export interface StatesScene {
  readonly options: FixtureOptions;
  readonly state: (state: AppState) => AppState;
  readonly api: (api: RequestsApi) => RequestsApi;
  readonly play: () => void;
  /** Traces the send pane answers for, beside its own fixtures. */
  readonly traces?: ReadonlyArray<TraceDetail>;
}

/** A trace whose server sent nothing back: only Polaris's own "send · polaris" span. */
const LONE_TRACE = "3a90e1f2b7c4d5e6f708192a3b4cc41b";

const loneTrace = (startedAt: string) =>
  buildTrace(
    {
      id: LONE_TRACE,
      startedAt,
      turn: null,
      launchedTurn: null,
      spans: [
        {
          id: "a3a90e1f2b7c4d5e",
          parent: null,
          name: "send",
          service: "polaris",
          kind: "client",
          at: 0,
          ms: 46,
          attributes: {
            "http.request.method": "GET",
            "url.full": "http://localhost:4000/invoices/overdue?limit=50",
            "http.response.status_code": 200,
          },
        },
      ],
    },
    FIXTURE_CHECKOUT
  );

const same = <A>(a: A) => a;

export const statesScene = (scene: string): StatesScene | null => {
  const sends = fixtureSends(Date.now());

  switch (scene) {
    case "send-log":
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
    case "refused": {
      const refused = sends.find((s) => s.outcome === "refused");

      return {
        options: { sends },
        state: same,
        api: same,
        play: () => {
          if (refused !== undefined) setLatestSend(at, refused);
        },
      };
    }

    case "no-spans": {
      const lone = fixtureSend(
        {
          id: LONE_TRACE,
          minutesAgo: 1,
          method: "GET",
          url: "http://localhost:4000/invoices/overdue?limit=50",
          outcome: "ok",
          status: 200,
          durationMs: 46,
        },
        Date.now()
      );

      return {
        options: { sends: [lone, ...sends] },
        state: same,
        api: same,
        traces: [loneTrace(lone.startedAt)],
        play: () => setLatestSend(at, lone),
      };
    }

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
