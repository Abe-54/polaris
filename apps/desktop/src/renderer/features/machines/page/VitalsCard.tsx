/**
 * The host page's Vitals card (Paper HS-D; DESIGN.md, Settings → Hosts redesign): one well,
 * four lanes (CPU, load, memory, disk), each a mono kicker, a 22px figure with its unit, a
 * neutral pixel chart and a caption. While the daemon restarts it holds the Starlight row.
 */
import { cn, Dither, SettingsCard, SettingsWell } from "@polaris/ui";
import type { ReactNode } from "react";
import type { ServiceManagerView } from "../../../../shared/restart.ts";
import { restartingCaption, restartingFooter } from "../restart/model.ts";
import { Meter, Sparkline } from "../stats/charts.tsx";
import {
  cpuSeries,
  cpuVital,
  diskVital,
  HISTORY,
  type HostStats,
  liveLabel,
  loadSeries,
  loadVital,
  memoryVital,
  type Vital,
  vitalsFooter,
} from "../stats/model.ts";

const MONO_ASIDE = "font-mono text-[10px] leading-3 tracking-[0.06em]";

const Lane = ({
  vital,
  chart,
  dimmed,
}: {
  readonly vital: Vital;
  readonly chart: ReactNode;
  readonly dimmed: boolean;
}) => (
  <div className="flex min-w-0 flex-1 flex-col gap-1.5" data-testid={`vital-${vital.kicker}`}>
    <span className="text-text-subtle font-mono text-[10px] leading-3 tracking-[0.06em]">
      {vital.kicker}
    </span>
    <span className={cn("flex items-baseline gap-1", dimmed && "opacity-(--opacity-dimmed)")}>
      <span
        data-testid="vital-figure"
        className="text-text-strong tabular text-[22px] leading-[26px] font-medium tracking-[-0.02em]"
      >
        {vital.figure}
      </span>
      <span className="text-caption text-text-subtle truncate">{vital.unit}</span>
    </span>
    {dimmed ? null : (
      <>
        <span className="flex h-7 items-end">{chart}</span>
        <span className="text-caption text-text-subtle truncate">{vital.caption}</span>
      </>
    )}
  </div>
);

export interface Restarting {
  readonly stoppedAt: number;
  readonly turns: number | null;
  readonly manager: ServiceManagerView | null;
}

export interface VitalsCardProps {
  readonly stats: HostStats | null;
  /** False while the host isn't connected: every figure reads "—". */
  readonly connected: boolean;
  readonly now: number;
  /** The daemon's uptime, from its hello; null when unknown. */
  readonly upMs: number | null;
  readonly restarting: Restarting | null;
}

const RestartingRow = ({ manager }: { readonly manager: ServiceManagerView | null }) => (
  <SettingsWell rows={false} data-testid="vitals-restarting">
    <div className="flex items-center gap-3 px-4 py-3">
      <Dither hue="starlight" size={16} moving />
      <div className="flex min-w-0 flex-col">
        <span className="text-body text-text-default">Restarting the daemon</span>
        <span className="text-caption text-text-subtle truncate">{restartingCaption(manager)}</span>
      </div>
    </div>
  </SettingsWell>
);

export const VitalsCard = ({ stats, connected, now, upMs, restarting }: VitalsCardProps) => {
  const shown = connected && restarting === null ? stats : null;
  const dimmed = shown === null || shown.samples.length === 0;
  const memory = memoryVital(shown);
  const disk = diskVital(shown);

  return (
    <SettingsCard
      title="Vitals"
      aside={
        <span className={MONO_ASIDE}>
          {restarting !== null || !connected ? "PAUSED" : liveLabel(stats)}
        </span>
      }
      status={
        restarting === null
          ? vitalsFooter(shown, connected ? upMs : null)
          : restartingFooter(restarting.stoppedAt, restarting.turns)
      }
    >
      {restarting === null ? null : <RestartingRow manager={restarting.manager} />}
      <SettingsWell rows={false}>
        <div className="flex gap-6 px-4 py-4" data-dimmed={dimmed ? "" : undefined}>
          <Lane
            vital={cpuVital(shown, now)}
            dimmed={dimmed}
            chart={
              <Sparkline
                values={shown === null ? [] : cpuSeries(shown)}
                count={HISTORY}
                height={28}
                label="CPU, last samples"
              />
            }
          />
          <Lane
            vital={loadVital(shown)}
            dimmed={dimmed}
            chart={
              <Sparkline
                values={shown === null ? [] : loadSeries(shown)}
                count={HISTORY}
                height={28}
                label="Load, last samples"
              />
            }
          />
          <Lane
            vital={memory}
            dimmed={dimmed}
            chart={<Meter lit={memory.cells} label={memory.caption} />}
          />
          <Lane
            vital={disk}
            dimmed={dimmed}
            chart={<Meter lit={disk.cells} label={disk.caption} />}
          />
        </div>
      </SettingsWell>
    </SettingsCard>
  );
};
