/**
 * Live Harness facts per Host: availability (`harness.watchAvailability`) and
 * Plan Limits (`usage.watch`), each one shared feed per Host while any view
 * needs it, and Models (`harness.models`), asked once per Host and Harness
 * until the user refreshes.
 */
import type { HarnessKind } from "@polaris/protocol";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { HostView } from "../../../shared/api.ts";
import { useApp } from "../../shell/hooks.ts";
import { polaris } from "../bridge.ts";
import { type LimitData, upsertLimit } from "./model/limits.ts";
import type { ModelData } from "./model/models.ts";
import { type AvailabilityReport, type HarnessOption, harnessOptions } from "./model/options.ts";

interface LiveState {
  readonly reports: Readonly<Record<string, AvailabilityReport>>;
  readonly limits: Readonly<Record<string, ReadonlyArray<LimitData>>>;
}

const live = createStore<LiveState>(() => ({ reports: {}, limits: {} }));

interface Held {
  refs: number;
  close: () => void;
}

const feeds = new Map<string, Held>();

/** A held feed that ended (its connection dropped before or after it opened) opens again after this. */
const REOPEN_MS = 1_000;

/**
 * Keeps a feed open while any view holds it; the last release closes it. `open` gets a
 * callback for the feed's end, and a feed that ends while still held is opened again.
 */
const hold = (key: string, open: (ended: () => void) => () => void) => {
  const existing = feeds.get(key);

  if (existing !== undefined) existing.refs++;
  else {
    const held: Held = { refs: 1, close: () => undefined };

    const start = () => {
      held.close = open(() => {
        if (feeds.get(key) !== held) return;

        setTimeout(() => {
          if (feeds.get(key) === held) start();
        }, REOPEN_MS);
      });
    };

    feeds.set(key, held);
    start();
  }

  return () => {
    const held = feeds.get(key);

    if (held === undefined || --held.refs > 0) return;
    feeds.delete(key);
    held.close();
  };
};

const setReport = (hostKey: string, report: AvailabilityReport) =>
  live.setState((s) => ({ reports: { ...s.reports, [hostKey]: report } }));

/**
 * The watch, plus a plain ask: a watch whose first attempt was interrupted before its first
 * report can hang on some connections (see FX-settings report), and the ask always answers.
 */
const openAvailability = (hostKey: string) => (ended: () => void) => {
  let open = true;

  void polaris()
    .request("harness.availability", { hostKey, refresh: false })
    .then((result) => {
      if (open && result.ok) setReport(hostKey, result.value);
    });

  const close = polaris().subscribe(
    "harness.availability",
    { hostKey },
    { items: (items) => items.forEach((report) => setReport(hostKey, report)), end: ended }
  );

  return () => {
    open = false;
    close();
  };
};

const openLimits = (hostKey: string) => (ended: () => void) =>
  polaris().subscribe(
    "plan-limits",
    { hostKey },
    {
      end: ended,
      items: (items) =>
        live.setState((s) => ({
          limits: { ...s.limits, [hostKey]: items.reduce(upsertLimit, s.limits[hostKey] ?? []) },
        })),
    }
  );

const useHostView = (hostKey: string): HostView | undefined =>
  useApp((s) => s.hosts.find((h) => h.key === hostKey));

const has = (host: HostView | undefined, capability: string) =>
  host?.status.capabilities.some((c) => c === capability) ?? false;

/** Probes the Host's Harnesses again (after a sign-in, or on request). */
export const refreshAvailability = async (hostKey: string) => {
  const result = await polaris().request("harness.availability", { hostKey, refresh: true });

  if (result.ok) setReport(hostKey, result.value);
};

export interface Availability {
  readonly options: ReadonlyArray<HarnessOption>;
  /** Still waiting for the Host's first report. */
  readonly loading: boolean;
  readonly refresh: () => void;
}

/** A Host's Harnesses, live; without the capability, its drivers (status unknown). */
export const useAvailability = (hostKey: string): Availability => {
  const host = useHostView(hostKey);
  const connected = host?.status.state === "connected";
  const canWatch = connected && has(host, "harness.availability");
  const report = useStore(live, (s) => s.reports[hostKey]);

  useEffect(
    () => (canWatch ? hold(`availability:${hostKey}`, openAvailability(hostKey)) : undefined),
    [canWatch, hostKey]
  );

  return {
    options: harnessOptions(canWatch ? (report ?? null) : null, host?.status.capabilities ?? []),
    loading: canWatch && report === undefined,
    refresh: () => void refreshAvailability(hostKey),
  };
};

const NO_REPORTS: Readonly<Record<string, AvailabilityReport>> = {};

/**
 * The raw reports (versions, sign-in argv) of several Hosts, live, for Settings → Harnesses;
 * pass only Hosts that are connected with `harness.availability`. Missing until the first report.
 */
export const useAvailabilityReports = (
  hostKeys: ReadonlyArray<string>
): Readonly<Record<string, AvailabilityReport>> => {
  const joined = hostKeys.join("\u0000");

  useEffect(() => {
    const keys = joined === "" ? [] : joined.split("\u0000");
    const releases = keys.map((k) => hold(`availability:${k}`, openAvailability(k)));

    return () => {
      for (const release of releases) release();
    };
  }, [joined]);

  return useStore(live, (s) => s.reports) ?? NO_REPORTS;
};

const NO_LIMITS: ReadonlyArray<LimitData> = [];

/** A Host's Plan Limits, live (capability `usage`); empty where the Daemon has none. */
export const usePlanLimits = (hostKey: string): ReadonlyArray<LimitData> => {
  const host = useHostView(hostKey);
  const canWatch = host?.status.state === "connected" && has(host, "usage");

  useEffect(
    () => (canWatch ? hold(`limits:${hostKey}`, openLimits(hostKey)) : undefined),
    [canWatch, hostKey]
  );

  return useStore(live, (s) => s.limits[hostKey]) ?? NO_LIMITS;
};

/** Session States in which a Harness is running a Turn, and so refreshing its Plan Limits. */
const RUNNING: ReadonlySet<string> = new Set(["starting", "working", "needs-you"]);

/**
 * Whether a session of `harness` is running on `hostKey` (on any Host when null): only then
 * does a fresh Plan Limit read "live" (`limitAge`).
 */
export const useHarnessRunning = (hostKey: string | null, harness: HarnessKind): boolean =>
  useApp((s) =>
    Object.entries(s.hostModels).some(
      ([key, model]) =>
        (hostKey === null || key === hostKey) &&
        [...model.sessions.values()].some(
          (e) => e.session.harness === harness && RUNNING.has(e.session.state)
        )
    )
  );

/** The Harnesses with a session running on any Host, e.g. for Settings → Usage's Plan Limits. */
export const useRunningHarnesses = (): ReadonlySet<string> => {
  const joined = useApp((s) =>
    [
      ...new Set(
        Object.values(s.hostModels).flatMap((model) =>
          [...model.sessions.values()].flatMap((e) =>
            RUNNING.has(e.session.state) ? [e.session.harness] : []
          )
        )
      ),
    ]
      .sort()
      .join("\u0000")
  );

  return new Set(joined === "" ? [] : joined.split("\u0000"));
};

export interface ModelsState {
  readonly models: ReadonlyArray<ModelData>;
  /** The Harness can change an Agent Session's Model between Turns (`SetModel`). */
  readonly switchesModel: boolean;
  /** The Harness can move a running command into the background (`BackgroundCommand`). */
  readonly backgroundsCommands: boolean;
  /** The Harness takes the user's shell commands (`RunShellCommand`); false from older Daemons. */
  readonly runsShellCommands: boolean;
  /** The Harness takes attachments in a steer (`Steer.attachments`); false from older Daemons. */
  readonly steersAttachments: boolean;
  readonly error: string | null;
  readonly loading: boolean;
}

const NO_MODELS: ModelsState = {
  models: [],
  switchesModel: false,
  backgroundsCommands: false,
  runsShellCommands: false,
  steersAttachments: false,
  error: null,
  loading: true,
};

const modelCache = new Map<string, Promise<ModelsState>>();

/** What each listing answered, for code that can't wait on it (a shortcut's `enabled`). */
const answered = new Map<string, ModelsState>();

/** Whether the Harness on this Host said it can move a running command into the background. */
export const harnessBackgroundsCommands = (hostKey: string, harness: HarnessKind): boolean =>
  answered.get(`${hostKey}\u0000${harness}`)?.backgroundsCommands === true;

const fetchModels = (hostKey: string, harness: HarnessKind, refresh: boolean) => {
  const key = `${hostKey}\u0000${harness}`;
  const cached = modelCache.get(key);

  if (cached !== undefined && !refresh) return cached;

  const request = polaris()
    .request("harness.models", { hostKey, harness, refresh })
    .then((result): ModelsState =>
      result.ok
        ? { ...result.value, error: null, loading: false }
        : { ...NO_MODELS, error: result.error.message, loading: false }
    );

  // A failure is asked again the next time a picker opens.
  void request.then((state) =>
    state.error === null ? void answered.set(key, state) : modelCache.delete(key)
  );
  modelCache.set(key, request);

  return request;
};

/** A Harness's Models on a Host, cached per Host and Harness; `refresh` asks the Harness again. */
export const useHarnessModels = (hostKey: string, harness: HarnessKind, enabled = true) => {
  const [state, setState] = useState<{ key: string; value: ModelsState } | null>(null);
  const [round, setRound] = useState(0);
  const key = `${hostKey}\u0000${harness}`;

  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;

    void fetchModels(hostKey, harness, round > 0).then((value) => {
      if (current) setState({ key, value });
    });

    return () => {
      current = false;
    };
  }, [enabled, hostKey, harness, key, round]);

  const value = state?.key === key ? state.value : NO_MODELS;

  return { ...value, refresh: () => setRound(round + 1) };
};
