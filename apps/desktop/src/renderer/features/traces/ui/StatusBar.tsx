/** The status bar along the panel's foot, as Data's: the Host for now. */
import { useApp } from "../../../shell/hooks.ts";
import type { TracesSlotProps } from "./slots.ts";

export const TracesStatusBar = ({ hostKey }: TracesSlotProps) => {
  const label = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.label);

  return (
    <div className="border-hairline text-caption text-text-subtle flex h-7 shrink-0 items-center gap-2 border-t px-4">
      <span className="bg-text-subtle size-1.5 shrink-0 rounded-full" />
      {label}
    </div>
  );
};
