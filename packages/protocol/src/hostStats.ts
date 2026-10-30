/**
 * Host stats (ENG-565): the Host's CPU, load, memory and disk, live for a
 * Client that watches them. The Daemon samples only while at least one
 * Client is subscribed, and keeps the last samples for a sparkline.
 * Capability `host.stats`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Unsupported } from "./errors.ts";
import { Timestamp } from "./ids.ts";

/** How many samples the Daemon keeps, and sends a new subscriber in `History`. */
export const HOST_STATS_HISTORY = 60;

const bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A volume's space, as a user can write to it: used is total minus what is still available. */
export class HostDiskUsage extends Schema.Class<HostDiskUsage>("HostDiskUsage")({
  /** The path the volume was read at: the Daemon home. */
  path: Schema.String,
  usedBytes: bytes,
  totalBytes: bytes,
}) {}

export class HostStatsSample extends Schema.Class<HostStatsSample>("HostStatsSample")({
  at: Timestamp,
  /**
   * The busy share of all cores since the previous sample (or the baseline read when
   * sampling starts), 0 to 100; null when there was none, as older Daemons' first sample.
   */
  cpuPercent: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  /** The 1, 5 and 15 minute load averages; null where the OS has none (Windows). */
  loadAverage: Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])),
  /**
   * Memory in use, page cache excluded: total minus MemAvailable on Linux; app,
   * wired and compressed memory on macOS (as Activity Monitor); total minus free on Windows.
   */
  memoryUsedBytes: bytes,
  memoryTotalBytes: bytes,
  /** The volume holding the Daemon home; null when it couldn't be read. */
  disk: Schema.NullOr(HostDiskUsage),
}) {}

export const HostStatsItem = Schema.TaggedUnion({
  /**
   * First on every subscription: the Host's core count, the sampling interval,
   * and the samples held, oldest first (up to HOST_STATS_HISTORY; older ones may
   * predate a pause in sampling, so read their `at`).
   */
  History: {
    cores: Schema.Int,
    intervalMs: Schema.Int,
    samples: Schema.Array(HostStatsSample),
  },
  /** A new sample, every `intervalMs` while any Client watches. */
  Sample: { sample: HostStatsSample },
});

export type HostStatsItem = typeof HostStatsItem.Type;

/** `History`, then a `Sample` per interval until the Client unsubscribes (capability `host.stats`). */
export const WatchHostStats = Rpc.make("host.stats.watch", {
  payload: {},
  success: HostStatsItem,
  error: Unsupported,
  stream: true,
});

export class HostStatsRpcs extends RpcGroup.make(WatchHostStats) {}
