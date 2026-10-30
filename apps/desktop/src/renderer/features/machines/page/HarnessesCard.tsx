/**
 * The host page's Harnesses card (Paper HS-D): each Harness's Celestial at 32px with its
 * name and version, "3 of 5 ready", the signed-in plans in the footer, and one action that
 * opens Settings → Harnesses and its setup guides. A Harness that needs sign-in says so and runs its own sign-in.
 */
import { Celestial, cn, SettingsButton, SettingsCard, SettingsWell } from "@polaris/ui";
import { useState } from "react";
import type { MachineView } from "../../../../shared/api.ts";
import { slots } from "../../../app/slots.tsx";
import { harnessGroups, type RowAction } from "../../settings/model/harnesses.ts";
import { useHostProbes } from "../../settings/ui/hostProbes.ts";
import { useShellActions } from "../../../shell/hooks.ts";
import { harnessBody } from "./parts.tsx";

const Placeholder = () => (
  <span aria-hidden className="border-text-faint size-6 rounded-full border border-dashed" />
);

interface Tile {
  readonly kind: string;
  readonly name: string;
  readonly version: string | null;
  readonly ready: boolean;
  readonly text: string;
  readonly action: RowAction | null;
}

const TileView = ({ tile, onSignIn }: { readonly tile: Tile; readonly onSignIn: () => void }) => (
  <div
    className="flex min-w-16 flex-1 basis-0 flex-col items-center gap-2"
    data-testid={`harness-${tile.kind}`}
    title={tile.text}
  >
    <span className="flex size-8 items-center justify-center">
      {tile.ready ? (
        <Celestial body={harnessBody(tile.kind)} harness={tile.kind} size={32} />
      ) : (
        <Placeholder />
      )}
    </span>
    <span
      className={cn(
        "w-full text-center text-[11px] leading-[14px] text-balance",
        tile.ready ? "text-text-default" : "text-text-subtle"
      )}
    >
      {tile.name}
    </span>
    {tile.action?.kind === "sign-in" ? (
      <SettingsButton variant="ghost" className="h-6 px-2" onClick={onSignIn}>
        Sign in
      </SettingsButton>
    ) : (
      <span className="text-text-subtle font-mono text-[10px] leading-3">
        {tile.version ?? "—"}
      </span>
    )}
  </div>
);

/** "CLAUDE MAX · CHATGPT": how the ready Harnesses are signed in, from their own status. */
const plansOf = (
  machine: MachineView,
  report: ReadonlyArray<{ readonly signInKind?: string | null }>
) =>
  report.flatMap((h) => (h.signInKind == null ? [] : [h.signInKind.toUpperCase()])).join(" · ") ||
  (machine.status?.state === "connected" ? "NOT SIGNED IN" : "");

export const HarnessesCard = ({ machine }: { readonly machine: MachineView }) => {
  const { hosts, refresh } = useHostProbes();
  const { openSettings } = useShellActions();
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const host = hosts.find((h) => h.hostKey === machine.key);

  if (host === undefined) return null;

  const tiles: ReadonlyArray<Tile> = harnessGroups([host]).flatMap((group) =>
    group.rows.map((row) => ({
      kind: group.kind,
      name: group.name,
      version: row.version,
      ready: row.ready,
      text: row.text,
      action: row.action,
    }))
  );

  const ready = tiles.filter((t) => t.ready).length;
  const guides = tiles.filter((t) => t.action?.kind === "setup-guide");
  const report = host.probe.kind === "reported" ? host.probe.report.harnesses : [];
  const signing = tiles.find((t) => t.kind === signingIn)?.action;

  return (
    <SettingsCard
      title="Harnesses"
      data-testid="harnesses-card"
      aside={`${ready} of ${tiles.length} ready`}
      status={plansOf(machine, report)}
      action={
        guides.length === 0 ? undefined : (
          <SettingsButton onClick={() => openSettings("harnesses")}>
            Set up {guides.length} more
          </SettingsButton>
        )
      }
    >
      <SettingsWell rows={false}>
        <div className="flex flex-wrap justify-between gap-x-2 gap-y-3 px-4 pt-[18px] pb-3.5">
          {tiles.map((tile) => (
            <TileView key={tile.kind} tile={tile} onSignIn={() => setSigningIn(tile.kind)} />
          ))}
        </div>
        {signing?.kind === "sign-in" ? (
          <div className="px-3 pb-3">
            <slots.HarnessTerminal
              hostKey={machine.key}
              argv={signing.argv}
              onExit={() => refresh(machine.key)}
              onClose={() => setSigningIn(null)}
            />
          </div>
        ) : null}
      </SettingsWell>
    </SettingsCard>
  );
};
