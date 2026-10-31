/**
 * The status bar along the panel's foot, as Data's (Paper T1): the Host, then at its end whether
 * Polaris is receiving this checkout's traces (model/receiver.ts).
 */
import type { TracesSnapshot } from "@polaris/protocol";
import { useApp } from "../../../shell/hooks.ts";
import { receiverLine } from "../model/receiver.ts";
import type { TracesSlotProps } from "./slots.ts";

export interface TracesStatusBarProps extends TracesSlotProps {
  /** The probe watch's latest snapshot; null until it answers. */
  readonly receiver: TracesSnapshot | null;
}

export const TracesStatusBar = ({ hostKey, receiver }: TracesStatusBarProps) => {
  const label = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.label);
  const line = receiver === null ? null : receiverLine(receiver);

  return (
    <div
      className="border-hairline text-caption text-text-subtle flex h-7 shrink-0 items-center gap-2 border-t px-4"
      data-testid="traces-status"
    >
      <span className="bg-text-subtle size-1.5 shrink-0 rounded-full" />
      <span className="shrink-0">{label}</span>
      {line === null ? null : (
        <span
          className="ml-auto min-w-0 truncate font-mono"
          title={line.detail ?? line.text}
          data-testid="traces-receiver"
        >
          {line.text}
        </span>
      )}
    </div>
  );
};
