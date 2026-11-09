/**
 * The hub's lifecycle (ADR 0099): started on demand, restarted with backoff after a crash or a
 * wedge, and stopped once nothing holds it and no agent called for `idleMs`. Stopping the hub
 * is the only way to stop serve-sim's capture, so this is the Simulator's idle mechanism.
 */
import { Option, Schema } from "effect";
import type { HubEndpoint, HubProcess } from "./hubProcess.ts";

/** No attach open and no agent call for 5 minutes stops the hub. */
export const HUB_IDLE_MS = 5 * 60_000;

/** The hub's own shutdown deadline: SIGKILL only after this. */
export const HUB_STOP_GRACE_MS = 60_000;

/** How often an attached hub is checked for wedged input. */
export const HUB_WEDGE_CHECK_MS = 30_000;

export interface HubTiming {
  readonly idleMs: number;
  readonly stopGraceMs: number;
  readonly wedgeCheckMs: number;
  /** Waits before each restart after a crash; the last repeats. */
  readonly backoffMs: ReadonlyArray<number>;
  /** A hub that ran this long resets the backoff. */
  readonly healthyMs: number;
}

export const DEFAULT_HUB_TIMING: HubTiming = {
  idleMs: HUB_IDLE_MS,
  stopGraceMs: HUB_STOP_GRACE_MS,
  wedgeCheckMs: HUB_WEDGE_CHECK_MS,
  backoffMs: [1_000, 2_000, 5_000, 15_000, 30_000],
  healthyMs: 60_000,
};

const IdleOverride = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));

/**
 * The default timing, with `POLARIS_SIMULATOR_IDLE_MS` as the idle time when it is a positive
 * integer: end-to-end runs watch the idle stop without waiting 5 minutes.
 */
export const hubTimingFromEnv = (env: Readonly<Record<string, string | undefined>>): HubTiming => {
  const idleMs = Option.getOrNull(
    Schema.decodeUnknownOption(IdleOverride)(env.POLARIS_SIMULATOR_IDLE_MS)
  );

  return idleMs === null ? DEFAULT_HUB_TIMING : { ...DEFAULT_HUB_TIMING, idleMs };
};

export interface SupervisorDeps {
  readonly spawn: () => Promise<HubProcess>;
  /** False when the hub's input is wedged; only asked while something holds the hub. */
  readonly probe: (endpoint: HubEndpoint) => Promise<boolean>;
  /** Runs before an idle stop, while the hub still answers. */
  readonly beforeIdleStop: (endpoint: HubEndpoint) => Promise<void>;
  /** Simulators Polaris booted may still run: an idle with no hub starts one to stop them. */
  readonly ownsBooted: () => boolean;
  readonly log: (message: string) => void;
  readonly timing: HubTiming;
}

type Listener = (endpoint: HubEndpoint) => void;

export class HubSupervisor {
  private hub: HubProcess | null = null;
  private starting: Promise<HubProcess> | null = null;
  /** Start, stop and restart run one at a time, in order. */
  private chain: Promise<unknown> = Promise.resolve();
  private holds = 0;
  private lastActivity = 0;
  private attempt = 0;
  private closed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private wedgeTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly deps: SupervisorDeps) {}

  /** The running hub's endpoint, or null. */
  get current(): HubEndpoint | null {
    return this.hub?.endpoint ?? null;
  }

  get pid(): number | null {
    return this.hub?.pid ?? null;
  }

  /** The running hub, started if needed; counts as activity. */
  ensure(): Promise<HubEndpoint> {
    this.touch();

    if (this.hub !== null) return Promise.resolve(this.hub.endpoint);

    return this.serial(() => this.startNow()).then((hub) => hub.endpoint);
  }

  /** Keeps the hub up until the returned release runs; the hub starts if needed. */
  async hold(): Promise<{ endpoint: HubEndpoint; release: () => void }> {
    this.holds += 1;
    this.clearIdle();
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      this.touch();
    };

    try {
      const endpoint = await this.ensure();

      if (this.wedgeTimer === null && this.hub !== null) this.armWedge();

      return { endpoint, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** An agent call: the idle clock restarts from now. */
  touch(): void {
    this.lastActivity = Date.now();

    // With no hub too: an agent may have booted a Simulator nothing else will shut down.
    if (this.holds === 0) this.armIdle();
  }

  /** Called with the new endpoint after every start or restart. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  /** Stops the hub and starts a new one: clears wedged input. */
  restart(): Promise<HubEndpoint> {
    this.touch();

    return this.serial(async () => {
      await this.stopNow();

      return this.startNow();
    }).then((hub) => hub.endpoint);
  }

  /** The Daemon is stopping: stop the hub, start nothing more. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearIdle();
    this.clearTimer("restartTimer");
    await this.serial(() => this.stopNow());
  }

  private serial<A>(task: () => Promise<A>): Promise<A> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);

    return next;
  }

  private get wanted(): boolean {
    return (
      !this.closed && (this.holds > 0 || Date.now() - this.lastActivity < this.deps.timing.idleMs)
    );
  }

  private async startNow(): Promise<HubProcess> {
    if (this.hub !== null) return this.hub;

    if (this.closed) throw new Error("the Daemon is stopping");
    this.clearTimer("restartTimer");
    this.starting ??= this.deps.spawn();

    try {
      const hub = await this.starting;
      this.adopt(hub);

      return hub;
    } finally {
      this.starting = null;
    }
  }

  private adopt(hub: HubProcess): void {
    this.hub = hub;
    const startedAt = Date.now();
    void hub.exited.then((code) => this.exited(hub, code, startedAt));

    if (this.holds > 0) this.armWedge();
    else this.armIdle();

    for (const listener of this.listeners) listener(hub.endpoint);
  }

  private async stopNow(): Promise<void> {
    const hub = this.hub;

    if (hub === null) return;
    this.hub = null;
    this.clearIdle();
    this.clearTimer("wedgeTimer");
    await hub.stop(this.deps.timing.stopGraceMs);
  }

  /** An exit nobody asked for is a crash: restart with backoff while the hub is wanted. */
  private exited(hub: HubProcess, code: number | null, startedAt: number): void {
    if (this.hub !== hub) return;
    this.hub = null;
    this.clearIdle();
    this.clearTimer("wedgeTimer");
    this.deps.log(`the Simulator hub exited unexpectedly (code ${code})`);
    void hub.stop(0);

    if (Date.now() - startedAt >= this.deps.timing.healthyMs) this.attempt = 0;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (!this.wanted || this.restartTimer !== null) return;
    const { backoffMs } = this.deps.timing;
    const wait = backoffMs[Math.min(this.attempt, backoffMs.length - 1)] ?? 1_000;
    this.attempt += 1;

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;

      if (!this.wanted || this.hub !== null) return;
      this.serial(() => this.startNow()).catch((error) => {
        this.deps.log(`restarting the Simulator hub failed: ${String(error)}`);
        this.scheduleRestart();
      });
    }, wait);
  }

  private armIdle(): void {
    this.clearIdle();
    const due = Math.max(0, this.lastActivity + this.deps.timing.idleMs - Date.now());

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;

      if (this.holds > 0) return;

      if (Date.now() - this.lastActivity < this.deps.timing.idleMs) {
        this.armIdle();

        return;
      }

      void this.idleStop();
    }, due);
  }

  private idleStop(): Promise<void> {
    return this.serial(async () => {
      if (this.holds > 0 || this.closed) return;

      if (this.hub === null && !this.deps.ownsBooted()) return;

      const hub =
        this.hub ??
        (await this.startNow().catch((error) => {
          this.deps.log(`starting the Simulator hub to stop Polaris's Simulators failed: ${error}`);

          return null;
        }));

      if (hub === null) return;
      await this.deps.beforeIdleStop(hub.endpoint).catch((error) => {
        this.deps.log(`shutting down Polaris's Simulators failed: ${String(error)}`);
      });

      if (this.holds > 0) return;
      await this.stopNow();
      this.attempt = 0;
    });
  }

  private armWedge(): void {
    this.clearTimer("wedgeTimer");

    this.wedgeTimer = setTimeout(() => {
      this.wedgeTimer = null;
      void this.checkWedge();
    }, this.deps.timing.wedgeCheckMs);
  }

  private async checkWedge(): Promise<void> {
    const hub = this.hub;

    if (hub === null) return;

    if (this.holds > 0 && !(await this.deps.probe(hub.endpoint)) && this.hub === hub) {
      this.deps.log("the Simulator hub's input is wedged: restarting it");
      await this.restart().catch((error) => {
        this.deps.log(`restarting a wedged Simulator hub failed: ${String(error)}`);
        this.scheduleRestart();
      });

      return;
    }

    if (this.hub === hub && this.holds > 0) this.armWedge();
  }

  private clearIdle(): void {
    this.clearTimer("idleTimer");
  }

  private clearTimer(name: "idleTimer" | "wedgeTimer" | "restartTimer"): void {
    const timer = this[name];

    if (timer !== null) clearTimeout(timer);
    this[name] = null;
  }
}
