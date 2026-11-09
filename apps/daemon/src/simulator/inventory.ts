/**
 * The Host's Simulators as `simulator.watch` sends them: listed on demand, and polled only
 * while a watch is open, so an idle Daemon lists nothing. iOS comes from `simctl`, Android
 * from the hub when it runs.
 */
import { Simulator, type SimulatorState } from "@polaris/protocol";
import { Schema } from "effect";
import type { BootedStore } from "./bootedStore.ts";
import { type HubDevices, simulatorsFromHub } from "./hubDevices.ts";

/** How often an open `simulator.watch` lists the Simulators again. */
export const WATCH_POLL_MS = 10_000;

export type InventoryChange =
  | { readonly kind: "changed"; readonly simulator: Simulator }
  | { readonly kind: "removed"; readonly id: string };

export interface InventoryDeps {
  /** Which platforms are ready now; a platform that isn't is never listed. */
  readonly ready: () => Promise<{ readonly ios: boolean; readonly android: boolean }>;
  readonly listIos: () => Promise<HubDevices | null>;
  /** The hub's list while it runs, else null. */
  readonly listHub: () => Promise<HubDevices | null>;
  readonly booted: BootedStore;
  readonly pollMs: number;
  readonly log: (message: string) => void;
}

const withState = (simulator: Simulator, state: SimulatorState) =>
  new Simulator({
    id: simulator.id,
    platform: simulator.platform,
    name: simulator.name,
    osVersion: simulator.osVersion,
    state,
    bootedByPolaris: simulator.bootedByPolaris,
  });

const sameSimulator = Schema.toEquivalence(Simulator);

type Listener = (change: InventoryChange) => void;

export class Inventory {
  private known = new Map<string, Simulator>();
  private running: Promise<ReadonlyArray<Simulator>> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<Listener>();
  /** `Booting` while Polaris boots one: `simctl` still says Shutdown meanwhile. */
  private readonly booting = new Set<string>();

  constructor(private readonly deps: InventoryDeps) {}

  get simulators(): ReadonlyArray<Simulator> {
    return [...this.known.values()];
  }

  find(id: string): Simulator | null {
    return this.known.get(id) ?? null;
  }

  /** Lists again; concurrent callers share one run. */
  refresh(): Promise<ReadonlyArray<Simulator>> {
    this.running ??= this.list().finally(() => {
      this.running = null;
    });

    return this.running;
  }

  /** Shows `id` as `Booting` until `settle`. */
  markBooting(id: string): void {
    this.booting.add(id);
    const simulator = this.known.get(id);

    if (simulator !== undefined && simulator.state === "Shutdown")
      this.apply(new Map(this.known).set(id, withState(simulator, "Booting")));
  }

  settle(id: string): void {
    this.booting.delete(id);
  }

  /** Changes after the current list; polling runs while anyone subscribes. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);

    if (this.listeners.size === 1) this.schedule();

    return () => {
      this.listeners.delete(listener);

      if (this.listeners.size === 0 && this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().finally(() => {
        if (this.listeners.size > 0 && this.timer === null) this.schedule();
      });
    }, this.deps.pollMs);
  }

  private async list(): Promise<ReadonlyArray<Simulator>> {
    const ready = await this.deps.ready();

    const [ios, hub] = await Promise.all([
      ready.ios ? this.deps.listIos().catch(() => null) : Promise.resolve(null),
      ready.android ? this.deps.listHub().catch(() => null) : Promise.resolve(null),
    ]);

    const previous = [...this.known.values()];

    const keep = (platform: "ios" | "android", fresh: HubDevices | null, isReady: boolean) =>
      fresh === null && isReady ? previous.filter((s) => s.platform === platform) : [];

    const devices: HubDevices = {
      simulators: ios?.simulators ?? [],
      emulators: hub?.emulators ?? [],
    };

    // Only a shutdown seen after a boot: `simctl` may not say Booted yet when the boot returns.
    const wentDown = (d: HubDevices["simulators"][number]) =>
      !d.booted && this.known.get(d.id)?.state === "Booted";

    this.deps.booted.forgetShutDown(
      [...devices.simulators, ...devices.emulators].flatMap((d) => (wentDown(d) ? [d.id] : []))
    );
    const { simulators } = simulatorsFromHub(devices, this.deps.booted.all);
    const next = new Map<string, Simulator>();

    for (const simulator of [
      ...simulators,
      ...keep("ios", ios, ready.ios),
      ...keep("android", hub, ready.android),
    ])
      next.set(
        simulator.id,
        this.booting.has(simulator.id) && simulator.state === "Shutdown"
          ? withState(simulator, "Booting")
          : simulator
      );
    this.apply(next);

    return this.simulators;
  }

  private apply(next: Map<string, Simulator>): void {
    const changes: Array<InventoryChange> = [];

    for (const [id, simulator] of next) {
      const before = this.known.get(id);

      if (before === undefined || !sameSimulator(before, simulator))
        changes.push({ kind: "changed", simulator });
    }

    for (const id of this.known.keys()) if (!next.has(id)) changes.push({ kind: "removed", id });
    this.known = next;

    for (const change of changes) for (const listener of this.listeners) listener(change);
  }
}
