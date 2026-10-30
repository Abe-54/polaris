/**
 * Settings → Hosts (DESIGN.md, Settings → Hosts redesign; Paper HS-D2, HS-D): the list of
 * hosts, each a collapsed row that opens the host's own page in Settings' panel, and "Add a
 * host", the page's one primary button, which opens the add-machine flow under the list.
 */
import { PlusIcon, SettingsButton } from "@polaris/ui";
import { useEffect, useState } from "react";
import type { MachineView } from "../../../shared/api.ts";
import { AddMachine } from "./AddMachine.tsx";
import { useMachines, useNow, useWslDistros } from "./hooks.tsx";
import { HostListRow } from "./list/HostListRow.tsx";
import { HostPage } from "./page/HostPage.tsx";
import { setKeepDaemonsUpToDate } from "./updates/actions.ts";
import { KeepUpToDate } from "./updates/Controls.tsx";
import { useUpgradeClock } from "./updates/UpgradeStatus.tsx";
import { addHint, hostsIntro } from "./wsl.ts";

/** This Mac first, then the remote Hosts in the order they were added. */
const thisMacFirst = (machines: ReadonlyArray<MachineView>) => [
  ...machines.filter((m) => m.alias === null),
  ...machines.filter((m) => m.alias !== null),
];

export interface HostsSettingsPageProps {
  /** Open the add-machine flow at once (the first-run "connect a host" row). */
  readonly adding?: boolean;
}

export const HostsSettingsPage = ({ adding = false }: HostsSettingsPageProps) => {
  const machines = useMachines();
  const { wsl, again } = useWslDistros();
  // Off Windows the answer is `unsupported` and the page reads as it always has.
  const onWindows = wsl !== null && wsl.status !== "unsupported";
  const [adder, setAdder] = useState(adding);
  const [opened, setOpened] = useState<string | null>(null);

  // "Connect a host" can open this page again while it is showing.
  useEffect(() => {
    if (adding) {
      setAdder(true);
      setOpened(null);
    }
  }, [adding]);

  const expiryClock = useUpgradeClock();

  const now = Math.max(
    expiryClock,
    useNow(machines?.some((m) => m.status?.state === "reconnecting") ?? false)
  );

  const page = machines?.find((m) => m.key === opened) ?? null;

  if (page !== null)
    return <HostPage key={page.key} machine={page} now={now} onBack={() => setOpened(null)} />;

  const keep = machines?.find((m) => m.daemon !== null)?.daemon?.keepDaemonsUpToDate ?? null;
  const taken = new Set((machines ?? []).flatMap((m) => (m.alias === null ? [] : [m.alias])));

  return (
    <div
      data-testid="hosts-settings"
      className="gap-panel mx-auto flex w-[680px] max-w-full flex-col py-10"
    >
      <div className="flex flex-col gap-1.5">
        <h1 className="text-title text-text-strong">Hosts</h1>
        <p className="text-body text-text-subtle">{hostsIntro(onWindows)}</p>
      </div>
      <ul className="flex flex-col gap-1.5" aria-label="Hosts">
        {thisMacFirst(machines ?? []).map((machine) => (
          <HostListRow
            key={machine.key}
            machine={machine}
            now={now}
            onOpen={() => setOpened(machine.key)}
          />
        ))}
      </ul>
      {adder ? (
        <AddMachine
          taken={taken}
          wsl={wsl}
          onLookAgain={again}
          onCancel={() => setAdder(false)}
          onAdded={(key) => {
            setAdder(false);
            setOpened(key);
          }}
        />
      ) : (
        <div className="flex items-center gap-3">
          <SettingsButton variant="primary" onClick={() => setAdder(true)}>
            <PlusIcon size={12} />
            Add a host
          </SettingsButton>
          <span className="text-caption text-text-subtle">{addHint(onWindows)}</span>
        </div>
      )}
      {keep === null ? null : (
        <div className="border-hairline rounded-card overflow-clip border">
          <KeepUpToDate checked={keep} onChange={setKeepDaemonsUpToDate} />
        </div>
      )}
    </div>
  );
};
