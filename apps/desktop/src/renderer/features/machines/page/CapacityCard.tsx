/**
 * The host page's Capacity card (Paper HS-D): "Workers at once" as the header's stepper, the
 * workers working as one slot cell each, the resources as mono chips, and "Resources…", which
 * opens the resources list and its add form under the grid.
 */
import { cn, SettingsButton, SettingsCard, SettingsStepper, SettingsWell } from "@polaris/ui";
import {
  capInForce,
  type HostResourcesSnapshot,
  isAutomatic,
  validCapacity,
} from "../../settings/model/resources.ts";
import { useHostResources } from "../../settings/resources.ts";

/** "AUTOMATIC WOULD BE 4 · 4 RESOURCES FREE". */
export const capacityFooter = (snapshot: HostResourcesSnapshot): string => {
  const held = new Set(snapshot.resourceLeases.map((l) => l.resource));
  const free = snapshot.resources.filter((r) => !held.has(r.name)).length;
  const auto = `AUTOMATIC WOULD BE ${snapshot.workerCap.default}`;

  return snapshot.resources.length === 0
    ? `${auto} · NO RESOURCES`
    : `${auto} · ${free} ${free === 1 ? "RESOURCE" : "RESOURCES"} FREE`;
};

const Slots = ({ working, cap }: { readonly working: number; readonly cap: number }) => (
  <div className="flex gap-0.5" aria-hidden>
    {Array.from({ length: cap }, (_, i) => (
      <span
        key={i}
        className={cn(
          "h-2.5 flex-1 rounded-[1px]",
          i < working ? "bg-text-strong" : "bg-[light-dark(#00000014,#ffffff14)]"
        )}
      />
    ))}
  </div>
);

export interface CapacityCardProps {
  readonly hostKey: string;
  readonly resourcesOpen: boolean;
  readonly onResources: () => void;
}

export const CapacityCard = ({ hostKey, resourcesOpen, onResources }: CapacityCardProps) => {
  const { state, run } = useHostResources(hostKey);

  if (state.kind !== "loaded") return null;
  const { snapshot } = state;
  const cap = capInForce(snapshot.workerCap);
  const working = snapshot.workerCap.working;

  return (
    <SettingsCard
      title="Capacity"
      data-testid="capacity-card"
      aside={
        <SettingsStepper
          label="Workers at once"
          value={cap}
          min={Math.max(1, working)}
          max={64}
          onChange={(next) => {
            if (validCapacity(next))
              void run("Couldn't change the worker cap", (c) => c.setCap(hostKey, next));
          }}
        />
      }
      status={capacityFooter(snapshot)}
      action={
        <SettingsButton aria-expanded={resourcesOpen} onClick={onResources}>
          Resources…
        </SettingsButton>
      }
    >
      <SettingsWell rows={false}>
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <span className="flex items-baseline gap-1.5">
            <span className="text-text-strong tabular text-[22px] leading-[26px]">{working}</span>
            <span className="text-body text-text-subtle min-w-0 flex-1">
              of {cap} {cap === 1 ? "worker" : "workers"} working
              {snapshot.workerCap.waiting > 0 ? ` · ${snapshot.workerCap.waiting} waiting` : ""}
            </span>
            {isAutomatic(snapshot.workerCap) ? null : (
              <SettingsButton
                variant="quiet"
                onClick={() =>
                  void run("Couldn't change the worker cap", (c) => c.setCap(hostKey, null))
                }
              >
                Automatic ({snapshot.workerCap.default})
              </SettingsButton>
            )}
          </span>
          <Slots working={Math.min(working, cap)} cap={cap} />
          {snapshot.resources.length === 0 ? null : (
            <div className="flex flex-wrap gap-1.5">
              {snapshot.resources.map((r) => (
                <span
                  key={r.name}
                  className="border-hairline text-text-default rounded-[4px] border px-1.5 font-mono text-[11px] leading-[18px]"
                >
                  {r.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </SettingsWell>
    </SettingsCard>
  );
};
