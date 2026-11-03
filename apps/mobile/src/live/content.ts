/**
 * The Live Activity's content while the app is in front (docs/adr/0088): each followed Host's
 * slice from its feed, as its Daemon would push it, so the app's update and a pushed one draw
 * the same. Pure; the native module seals the slices.
 */
import { CELESTIAL_PLANETS, harnessEntry } from "@polaris/protocol";
import {
  commandLine,
  encodeHostSlice,
  fitSlice,
  type HostSlice,
  type LiveLine,
  MAX_LIVE_CELESTIALS,
  MAX_LIVE_HOSTS,
} from "@polaris/protocol/relay";
import type { HostFeedState, SessionEntry } from "../home/feed/fold.ts";

/** One linked Host as the activity reads it. */
export interface LiveHost {
  readonly hostId: string;
  /** Its relay address: slices are ordered by it, as the Relay orders them. */
  readonly hostAddress: string;
  readonly name: string;
  readonly feed: HostFeedState;
}

export interface LiveContent {
  /** Each Host's slice JSON, ordered by relay address, at most MAX_LIVE_HOSTS. */
  readonly slices: ReadonlyArray<string>;
  /** Anything working or waiting on the user, on any Host. */
  readonly busy: boolean;
}

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const isUsers = ({ session }: SessionEntry) =>
  session.origin === null || session.origin === undefined;

const since = ({ session }: SessionEntry) =>
  seconds(session.currentUserTurn?.startedAt ?? session.updatedAt);

const cwdOf = (entry: SessionEntry | undefined) => (entry === undefined ? [] : [entry.session.cwd]);

const named = (entry: SessionEntry | undefined) => {
  if (entry === undefined) return { session: "" };
  const { title, harness } = entry.session;

  return { session: title, harness: harnessEntry(harness)?.name ?? harness };
};

/** One Host's slice: its user's sessions working, its newest step, its oldest open request. */
export const hostSlice = (host: LiveHost): HostSlice => {
  const { sessions, step, sequence } = host.feed;
  const users = [...sessions.values()].filter(isUsers);
  const working = users.filter(({ session }) => session.state === "working");
  const starts = working.map(since);
  const requests = users.flatMap((entry) => entry.pendingApprovals);
  const oldest = [...requests].sort((a, b) => seconds(a.openedAt) - seconds(b.openedAt))[0];

  const stepLine: LiveLine | null =
    step === null ? null : { ...step, ...named(sessions.get(step.sessionId)) };

  return {
    v: 1,
    hostId: host.hostId,
    host: host.name,
    seq: sequence,
    working: working.length,
    since: starts.length === 0 ? null : Math.min(...starts),
    step: stepLine,
    need:
      oldest === undefined
        ? null
        : {
            at: seconds(oldest.openedAt),
            sessionId: oldest.sessionId,
            ...named(sessions.get(oldest.sessionId)),
            line:
              oldest.kind === "command"
                ? commandLine(oldest.title, cwdOf(sessions.get(oldest.sessionId)))
                : oldest.title,
            requestId: oldest.id,
            // A secret has no Approve: like a question, the takeover opens the app.
            kind:
              oldest.kind === "question" ||
              oldest.kind === "secret" ||
              oldest.profileAttach !== undefined
                ? "question"
                : "approval",
          },
    needs: requests.length,
    celestials: [...working]
      .sort((a, b) => since(b) - since(a))
      .slice(0, MAX_LIVE_CELESTIALS)
      .map(({ session }) => `${session.harness}/${session.celestial ?? CELESTIAL_PLANETS[0]}`),
  };
};

const isBusy = (slice: HostSlice) => slice.working > 0 || slice.needs > 0;

/**
 * Every Host's slice; past MAX_LIVE_HOSTS, those with work or Needs You stay, as at the Relay.
 * `budget: "push"` cuts each to the sealed budget the iOS activity shares with APNs updates. Android's
 * notification, drawn on the device from the slice itself, uses `budget: "local"` and takes them whole.
 */
export const liveContent = (
  hosts: ReadonlyArray<LiveHost>,
  policy: { readonly budget: "push" | "local" } = { budget: "push" }
): LiveContent => {
  const slices = hosts.map((host) => ({ address: host.hostAddress, slice: hostSlice(host) }));

  const kept = [...slices]
    .sort((a, b) => Number(isBusy(b.slice)) - Number(isBusy(a.slice)))
    .slice(0, MAX_LIVE_HOSTS)
    .sort((a, b) => a.address.localeCompare(b.address));

  return {
    slices: kept.map(({ slice }) =>
      encodeHostSlice(policy.budget === "push" ? fitSlice(slice) : slice)
    ),
    busy: slices.some(({ slice }) => isBusy(slice)),
  };
};

/** How long every Host stays idle before the app ends the activity. */
export const IDLE_END_MS = 10 * 60_000;

/** `show` starts the activity, or refreshes the one already showing. */
export type LiveAction = "show" | "update" | "end" | "none";

/**
 * What the app does with the activity while in front. `idleSince` is when the last Host went
 * idle (null while busy); `running` whether an activity may be showing.
 */
export const liveAction = (
  running: boolean,
  busy: boolean,
  idleSince: number | null,
  now: number
): LiveAction => {
  if (busy) return "show";

  if (!running) return "none";

  return idleSince !== null && now - idleSince >= IDLE_END_MS ? "end" : "update";
};
