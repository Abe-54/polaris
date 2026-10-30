import type { ReactNode } from "react";

import { Tile } from "../tile";
import { SettingsWell } from "./card";

/** An empty list inline in its well: one caption line ("No hidden workspaces"). */
export function SettingsEmpty({ children }: { readonly children: ReactNode }) {
  return (
    <SettingsWell
      data-slot="settings-empty"
      className="px-panel py-[calc(var(--spacing-panel)-2px)]"
    >
      <p className="text-caption text-text-subtle">{children}</p>
    </SettingsWell>
  );
}

export interface SettingsEmptyTileProps {
  /** A 20px pixel icon for the Starlight tile. */
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly caption: ReactNode;
  /** One SettingsButton that fills the emptiness ("Link a device"). */
  readonly action?: ReactNode;
}

/** An empty card's well when the page has nothing yet: tile, sentence, caption, one action. */
export function SettingsEmptyTile({ icon, title, caption, action }: SettingsEmptyTileProps) {
  return (
    <SettingsWell
      data-slot="settings-empty-tile"
      rows={false}
      className="px-panel flex-row items-center gap-3.5 py-[calc(var(--spacing-panel)+2px)]"
    >
      <Tile hue="starlight" size={40} borderless>
        {icon}
      </Tile>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body text-text-default truncate font-medium">{title}</span>
        <span className="text-caption text-text-subtle truncate">{caption}</span>
      </div>
      {action}
    </SettingsWell>
  );
}
