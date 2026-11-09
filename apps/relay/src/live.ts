/**
 * Live Activities (docs/adr/0088; README: Live Activities). The relay keeps each host's latest
 * sealed slice per activity token, in memory only, and sends the merged ContentState to the
 * push service: routine updates at most once per `intervalMs` per token at priority 5, a new
 * Needs You at once with the alert. Slices are opaque; it reads only `active` and `alert`.
 */
import {
  type LivePushRequest,
  MAX_LIVE_HOSTS,
  type PushEnvironment,
  type RelayAddress,
  type WakeOutcome,
} from "@polaris/protocol/relay";

/** How often a routine update may go to one activity. */
export const LIVE_INTERVAL_MS = 5_000;

export interface LiveSlot {
  readonly peer: RelayAddress;
  readonly slice: string;
  readonly active: boolean;
}

interface Activity {
  /** `keyOf`: one device's activity, so a host can't join or evict another device's. */
  readonly key: string;
  readonly token: string;
  readonly environment: PushEnvironment;
  readonly slots: Map<RelayAddress, LiveSlot>;
  /** When the last push went, in ms; 0 before any. */
  lastSent: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface LivePut {
  readonly host: RelayAddress;
  readonly peer: RelayAddress;
  readonly token: string;
  readonly environment: PushEnvironment;
  /** Null: the host leaves this activity. */
  readonly slice: string | null;
  readonly active: boolean;
  readonly alert: boolean;
}

export interface LiveDeps {
  readonly deliver: (request: LivePushRequest) => Promise<WakeOutcome>;
  /** The activity is gone: tell `hosts` so they stop sending to it. */
  readonly gone: (
    hosts: ReadonlyArray<RelayAddress>,
    token: string,
    outcome: "unregistered"
  ) => void;
  readonly delivered: (outcome: WakeOutcome, hosts: number, alert: boolean) => void;
  /** Activities held at once, across hosts; a new one past it is ignored. */
  readonly maxActivities: number;
  /** Activities one host may hold slices in. */
  readonly maxPerHost: number;
  readonly intervalMs?: number;
  /** How long a host's socket may be gone before its slices leave (ENG-585). */
  readonly hostGoneMs: number;
  readonly now?: () => number;
}

/** The slices one push carries, by host address; past six, those with work or Needs You win. */
export const mergeSlots = (slots: ReadonlyMap<RelayAddress, LiveSlot>): ReadonlyArray<string> => {
  const byAddress = [...slots].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (byAddress.length <= MAX_LIVE_HOSTS) return byAddress.map(([, slot]) => slot.slice);

  const kept = new Set(
    [
      ...byAddress.filter(([, slot]) => slot.active),
      ...byAddress.filter(([, slot]) => !slot.active),
    ]
      .slice(0, MAX_LIVE_HOSTS)
      .map(([host]) => host)
  );

  return byAddress.filter(([host]) => kept.has(host)).map(([, slot]) => slot.slice);
};

/** An activity is its device's: a token another device's ticket names is another activity. */
const keyOf = (put: Pick<LivePut, "peer" | "environment" | "token">) =>
  `${put.peer}\0${put.environment}\0${put.token}`;

export class LiveActivities {
  private readonly activities = new Map<string, Activity>();
  private readonly keysOf = new Map<RelayAddress, Set<string>>();
  /** Hosts whose socket is gone: the timer that drops their slices. */
  private readonly away = new Map<RelayAddress, ReturnType<typeof setTimeout>>();
  private readonly intervalMs: number;
  private readonly hostGoneMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: LiveDeps) {
    this.intervalMs = deps.intervalMs ?? LIVE_INTERVAL_MS;
    this.hostGoneMs = deps.hostGoneMs;
    this.now = deps.now ?? Date.now;
  }

  /** Stores a host's slice and sends, or schedules, the merged update. */
  put(put: LivePut): void {
    if (put.slice === null) return this.leave(put.host, keyOf(put));
    const activity = this.activityFor(put);

    if (activity === null) return;
    activity.slots.set(put.host, { peer: put.peer, slice: put.slice, active: put.active });
    this.keys(put.host).add(activity.key);

    if (put.alert) this.send(activity, true);
    else this.schedule(activity);
  }

  /** Drops `host`'s slices in activities of devices it no longer lists. */
  unlisted(host: RelayAddress, listed: ReadonlySet<RelayAddress>): void {
    for (const key of Array.from(this.keysOf.get(host) ?? [])) {
      const slot = this.activities.get(key)?.slots.get(host);

      if (slot !== undefined && !listed.has(slot.peer)) this.leave(host, key);
    }
  }

  /** `host`'s socket is gone: its slices leave after `hostGoneMs` unless it comes back. */
  hostGone(host: RelayAddress): void {
    if (this.away.has(host) || !this.keysOf.has(host)) return;

    const timer = setTimeout(() => {
      this.away.delete(host);

      for (const key of Array.from(this.keysOf.get(host) ?? [])) this.leave(host, key);
    }, this.hostGoneMs);

    timer.unref?.();
    this.away.set(host, timer);
  }

  /** `host` is connected again: its slices stay. */
  hostBack(host: RelayAddress): void {
    clearTimeout(this.away.get(host));
    this.away.delete(host);
  }

  get size(): number {
    return this.activities.size;
  }

  stop(): void {
    for (const timer of this.away.values()) clearTimeout(timer);
    this.away.clear();

    for (const activity of this.activities.values()) this.cancel(activity);
    this.activities.clear();
    this.keysOf.clear();
  }

  private activityFor(put: LivePut): Activity | null {
    const key = keyOf(put);
    const existing = this.activities.get(key);

    if (existing !== undefined) {
      const known = existing.slots.has(put.host);

      return known || this.keys(put.host).size < this.deps.maxPerHost ? existing : null;
    }

    if (
      this.activities.size >= this.deps.maxActivities ||
      this.keys(put.host).size >= this.deps.maxPerHost
    )
      return null;

    const activity: Activity = {
      key,
      token: put.token,
      environment: put.environment,
      slots: new Map(),
      lastSent: 0,
      timer: null,
    };

    this.activities.set(key, activity);

    return activity;
  }

  private keys(host: RelayAddress): Set<string> {
    const keys = this.keysOf.get(host) ?? new Set<string>();
    this.keysOf.set(host, keys);

    return keys;
  }

  private leave(host: RelayAddress, key: string): void {
    const activity = this.activities.get(key);

    if (activity === undefined || !activity.slots.delete(host)) return;
    this.forgetKey(host, key);

    if (activity.slots.size === 0) this.remove(activity);
    else this.schedule(activity);
  }

  private forgetKey(host: RelayAddress, key: string): void {
    const keys = this.keysOf.get(host);
    keys?.delete(key);

    if (keys?.size === 0) this.keysOf.delete(host);
  }

  private remove(activity: Activity): void {
    this.cancel(activity);
    this.activities.delete(activity.key);

    for (const host of activity.slots.keys()) this.forgetKey(host, activity.key);
  }

  private cancel(activity: Activity): void {
    if (activity.timer !== null) clearTimeout(activity.timer);
    activity.timer = null;
  }

  private schedule(activity: Activity): void {
    if (activity.timer !== null) return;
    const wait = activity.lastSent + this.intervalMs - this.now();

    if (wait <= 0) return this.send(activity, false);
    activity.timer = setTimeout(() => {
      activity.timer = null;

      if (this.activities.get(activity.key) === activity) this.send(activity, false);
    }, wait);
    activity.timer.unref?.();
  }

  private send(activity: Activity, alert: boolean): void {
    this.cancel(activity);
    activity.lastSent = this.now();
    const hosts = activity.slots.size;

    const request: LivePushRequest = {
      token: activity.token,
      environment: activity.environment,
      live: {
        event: "update",
        timestamp: Math.floor(activity.lastSent / 1000),
        state: { v: 1, slices: [...mergeSlots(activity.slots)] },
        alert,
      },
    };

    void this.deps.deliver(request).then((outcome) => {
      this.deps.delivered(outcome, hosts, alert);

      // APNs no longer knows the token: the activity ended, so every host stops sending to it.
      if (outcome !== "unregistered" || this.activities.get(activity.key) !== activity) return;
      // Hosts that joined while this push was out hear it too.
      const current = [...activity.slots.keys()];
      this.remove(activity);
      this.deps.gone(current, activity.token, "unregistered");
    });
  }
}
