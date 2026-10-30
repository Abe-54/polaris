/**
 * One host in Settings → Hosts (Paper HS-D2): colour square, name and its mono line, an 80px
 * CPU sparkline in the host's colour (rule/host-hue-sparkline), the CPU % in a 34px lane, the
 * Connection State in a 160px lane, and a chevron. Clicking opens the host's page.
 */
import { cn } from "@polaris/ui";
import type { MachineView } from "../../../../shared/api.ts";
import { ChevronGlyph, ColourSquare, StateDot } from "../page/parts.tsx";
import { hostName, listLine, pill } from "../page/state.ts";
import { Sparkline } from "../stats/charts.tsx";
import { useHostStats } from "../stats/hooks.ts";
import { cpuFigure, cpuSeries, LIST_SAMPLES } from "../stats/model.ts";

export interface HostListRowProps {
  readonly machine: MachineView;
  readonly now: number;
  readonly onOpen: () => void;
}

export const HostListRow = ({ machine, now, onOpen }: HostListRowProps) => {
  const state = pill(machine, now);
  const connected = state.state === "connected";
  const stats = useHostStats(machine.key, connected);
  // Offline keeps an empty track; Reconnecting keeps the samples it had, and reads "—".
  const values = state.state === "offline" || stats === null ? [] : cpuSeries(stats);
  const name = hostName(machine);

  return (
    <li data-testid={`machine-${machine.key}`} data-state={state.state}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${name}, ${state.label}`}
        className={cn(
          "bg-raised hover:bg-fill-hover flex h-[60px] w-full cursor-default items-center gap-3.5 rounded-[12px] pr-3 pl-4 text-left shadow-[inset_0_0_0_1px_var(--color-hairline)]",
          state.state === "reconnecting" && "opacity-(--opacity-dimmed)"
        )}
      >
        <ColourSquare colour={machine.colour} size={10} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body text-text-default truncate font-medium">{name}</span>
          <span className="text-text-subtle truncate font-mono text-[11px] leading-4">
            {listLine(machine)}
          </span>
        </span>
        <Sparkline
          values={values}
          count={LIST_SAMPLES}
          height={16}
          colour={machine.colour}
          label={`CPU on ${name}`}
        />
        <span className="text-text-subtle tabular w-[34px] shrink-0 text-right font-mono text-[11px] leading-4">
          {connected ? cpuFigure(stats) : "—"}
        </span>
        <span
          className="flex w-40 shrink-0 items-center gap-1.5"
          data-testid={`connection-state-${machine.key}`}
        >
          <StateDot state={state.state} />
          <span
            className={cn(
              "text-caption truncate tabular",
              state.state === "needs-attention" ? "text-text-strong" : "text-text-subtle"
            )}
          >
            {state.label}
          </span>
        </span>
        <ChevronGlyph />
      </button>
    </li>
  );
};
