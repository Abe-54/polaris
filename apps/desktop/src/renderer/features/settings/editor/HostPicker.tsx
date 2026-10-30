/** The Languages card's host picker (SR-02): the Host's colour, its name and a chevron; only connected Hosts can be picked. */
import {
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@polaris/ui";
import type { HostView } from "../../../../shared/api.ts";
import { stateWords } from "../../../shell/hostCopy.ts";
import { ColourSquare } from "../../machines/page/parts.tsx";

export const pickable = (host: HostView) =>
  host.status.state === "connected" && host.status.host !== null;

/** The Host's own colour (identity); a neutral fill when it has none or can't be picked. */
const Swatch = ({ host }: { readonly host: HostView | undefined }) => (
  <ColourSquare colour={host !== undefined && pickable(host) ? host.colour : null} size={8} />
);

export const HostPicker = ({
  hosts,
  value,
  onChange,
}: {
  readonly hosts: ReadonlyArray<HostView>;
  readonly value: string | null;
  readonly onChange: (hostKey: string) => void;
}) => {
  const current = hosts.find((h) => h.key === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Host: ${current?.label ?? "none"}`}
        className="bg-raised-control text-caption text-text-default hover:bg-fill-hover flex h-[26px] shrink-0 cursor-default items-center gap-1.5 rounded-[8px] border border-[light-dark(#00000014,#ffffff14)] px-2.5"
      >
        <Swatch host={current} />
        {current?.label ?? "No host"}
        <ChevronDownIcon size={10} className="text-text-subtle" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onChange}>
          {hosts.map((host) => (
            <DropdownMenuRadioItem key={host.key} value={host.key} disabled={!pickable(host)}>
              <span className="flex-1">{host.label}</span>
              {!pickable(host) && (
                <span className="text-caption text-text-subtle">
                  {stateWords(host.status.state) ?? "not connected"}
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
