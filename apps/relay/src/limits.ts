/** Abuse limits: token buckets for rates and a per-address gate on connections. */

/** Refills `perSecond` tokens a second up to `burst`; `take` fails without spending when short. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = performance.now.bind(performance)
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** `now` lets a caller with two buckets read the clock once. */
  take(count = 1, now = this.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;

    if (this.tokens < count) return false;
    this.tokens -= count;

    return true;
  }
}

export interface GateLimits {
  readonly maxConnections: number;
  readonly maxConnectionsPerIp: number;
  /** New connections a second from one address, with a burst of `connectBurstPerIp`. */
  readonly connectsPerSecondPerIp: number;
  readonly connectBurstPerIp: number;
}

export type GateRefusal = "relay-full" | "too-many-connections" | "connecting-too-fast";

interface IpState {
  open: number;
  readonly bucket: TokenBucket;
}

/**
 * Admits connections. Network addresses live here only while a connection is
 * open or its bucket is still refilling; they are never logged.
 */
export class ConnectionGate {
  private open = 0;
  private readonly ips = new Map<string, IpState>();

  constructor(
    private readonly limits: GateLimits,
    private readonly now: () => number = performance.now.bind(performance)
  ) {}

  admit(ip: string): GateRefusal | null {
    if (this.open >= this.limits.maxConnections) return "relay-full";

    const state = this.ips.get(ip) ?? {
      open: 0,
      bucket: new TokenBucket(
        this.limits.connectsPerSecondPerIp,
        this.limits.connectBurstPerIp,
        this.now
      ),
    };

    this.ips.set(ip, state);

    if (state.open >= this.limits.maxConnectionsPerIp) return "too-many-connections";

    if (!state.bucket.take()) return "connecting-too-fast";
    state.open++;
    this.open++;

    return null;
  }

  release(ip: string): void {
    const state = this.ips.get(ip);

    if (state === undefined) return;
    state.open--;
    this.open--;
  }

  /** Forgets addresses with nothing open, so the map does not grow with every visitor. */
  sweep(): void {
    for (const [ip, state] of this.ips) if (state.open === 0) this.ips.delete(ip);
  }

  get connections(): number {
    return this.open;
  }
}

/**
 * Wake budgets per host relay address, so reconnecting doesn't refill them. An entry goes
 * once it has been idle long enough to have refilled, when it would be new again anyway.
 */
export class WakeLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; last: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly now: () => number = performance.now.bind(performance)
  ) {}

  take(address: string): boolean {
    const entry = this.buckets.get(address) ?? {
      bucket: new TokenBucket(this.perMinute / 60, this.burst, this.now),
      last: 0,
    };

    entry.last = this.now();
    this.buckets.set(address, entry);

    return entry.bucket.take();
  }

  sweep(): void {
    const refillMs = (this.burst / this.perMinute) * 60_000;
    const now = this.now();

    for (const [address, entry] of this.buckets)
      if (now - entry.last > refillMs) this.buckets.delete(address);
  }

  get size(): number {
    return this.buckets.size;
  }
}
