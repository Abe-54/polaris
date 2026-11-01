/**
 * What a Traces preview shows beyond its scene, from `#traces/<scene>?view=<view>`: a span open in
 * the panel (a database span, the failing test), the receiver still being read, or the Host away
 * (reconnecting, offline, needing attention).
 */
import type { TracesApi } from "../data/api.ts";
import { selectProfile } from "../model/profile/store.ts";
import type { TracesSessionKey } from "../model/session.ts";
import { selectSpan, selectTrace } from "../model/store.ts";
import { fixturePid } from "./build.ts";
import { BIG_TRACE, ERROR_TRACE } from "./fixtures.ts";
import { fixtureProfilesApi, LARGE_PROFILE, LEDGER_PROFILE } from "./profiles.ts";

const SPANS = {
  /** UPDATE invoices: Open in Data, overdue.ts:61, a log. */
  "span-db": { trace: BIG_TRACE.id, span: "a91f5d6e7b8c03c2" },
  /** The failing test's root: an exception, two logs, a link. */
  "span-error": { trace: ERROR_TRACE.id, span: "3c5d7e9f1a2b4c6d" },
  /** The timed-out rate lookup: an error status and its logs. */
  "span-timeout": { trace: ERROR_TRACE.id, span: "85cae0a4b6d8fa25" },
} as const;

/** Profile views: ledger-api's recording over the overdue run, or the 50,000-node one alone. */
const PROFILES = {
  profile: { trace: BIG_TRACE.id, span: "b30e4d1a7c2f9e05", profile: LEDGER_PROFILE },
  "profile-large": { trace: null, span: null, profile: LARGE_PROFILE },
  /** The Profiles tab, where restarting is refused: Polaris didn't start the process. */
  "restart-refused": { trace: BIG_TRACE.id, span: null, profile: null },
} as const;

/** Views whose watch never answers: the first read, or a Host away. */
const STATES = {
  loading: true,
  reconnecting: true,
  offline: true,
  "needs-attention": true,
} as const;

type StateView = keyof typeof STATES;

export const isStateView = (name: string): name is StateView => Object.hasOwn(STATES, name);

export type PreviewView = keyof typeof SPANS | keyof typeof PROFILES | StateView | null;

const isSpanView = (name: string): name is keyof typeof SPANS => Object.hasOwn(SPANS, name);

const isProfileView = (name: string): name is keyof typeof PROFILES =>
  Object.hasOwn(PROFILES, name);

/** The scene's name (before `?`) and its view. */
export const previewOf = (hash: string) => {
  const [name = "", query = ""] = hash.replace(/^#traces\//, "").split("?");
  const view = new URLSearchParams(query).get("view") ?? "";

  const shown: PreviewView =
    isSpanView(view) || isProfileView(view) || isStateView(view) ? view : null;

  return { name, view: shown };
};

/** Opens the view's trace, span and Profile before the first render. */
export const openViewSpan = (at: TracesSessionKey, view: PreviewView) => {
  if (view !== null && isSpanView(view)) {
    selectTrace(at, SPANS[view].trace);
    selectSpan(at, SPANS[view].span);
  }

  if (view === null || !isProfileView(view)) return;
  const { trace, span, profile } = PROFILES[view];

  selectTrace(at, trace);
  selectSpan(at, span);
  selectProfile(at, profile);
};

/** The view's Profiles: the large one when it is shown; ledger-api is Polaris's unless refused. */
export const viewProfilesApi = (view: PreviewView) =>
  fixtureProfilesApi({
    large: view === "profile-large",
    owned: view === "restart-refused" ? [] : [Number(fixturePid("ledger-api"))],
  });

/** A watch that never answers, as before the Daemon's first snapshot. */
export const silent = (api: TracesApi): TracesApi => ({ ...api, watch: () => () => undefined });
