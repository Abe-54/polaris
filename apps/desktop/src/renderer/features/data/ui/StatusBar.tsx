/** The status bar along the panel's foot, as the Editor's: the Host for now. */
import { useApp } from "../../../shell/hooks.ts";
import type { DataSlotProps } from "./slots.ts";

export const DataStatusBar = ({ hostKey }: DataSlotProps) => {
  const label = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.label);

  return (
    <div className="border-hairline text-caption text-text-subtle flex h-[34px] shrink-0 items-center gap-2 border-t px-3.5">
      <span className="bg-text-subtle size-1.5 shrink-0 rounded-full" />
      {label}
    </div>
  );
};
