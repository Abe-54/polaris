/**
 * Settings → Sessions' "Archive dormant sessions" card: when each Host archives its dormant
 * sessions (ENG-384), saved on the Host, which archives them on its own; shown at once,
 * reloaded if the Host refuses. Then whether archive deletes merged branches.
 */
import {
  SettingsCard,
  SettingsHostRow,
  type SettingsOption,
  SettingsSelect,
  SettingsToggleRow,
  SettingsWell,
} from "@polaris/ui";
import { useCallback, useEffect, useState } from "react";
import type { HostView } from "../../../../shared/api.ts";
import { polaris } from "../../bridge.ts";
import { useApp } from "../../../shell/hooks.ts";
import { showRefusal } from "../../session/dispatch.ts";
import { hasCapability } from "../../session/hooks.ts";
import { setSessionPrefs, useSettings } from "../store.ts";

const CHOICES = [1, 3, 7, 14, 30];

const NEVER = "never";

const label = (days: number) => (days === 1 ? "After 1 day" : `After ${days} days`);

/** A host without a colour of its own takes a neutral square. */
export const hostColour = (host: Pick<HostView, "colour">) =>
  host.colour ?? "var(--color-text-subtle)";

const HostAutoArchive = ({ host }: { readonly host: HostView }) => {
  const connected = host.status.state === "connected";
  const [afterDays, setAfterDays] = useState<number | null | undefined>(undefined);

  const load = useCallback(async () => {
    const result = await polaris().request("sessions.autoArchive", { hostKey: host.key });

    if (result.ok) setAfterDays(result.value.afterDays);
  }, [host.key]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const save = async (next: number | null) => {
    setAfterDays(next);

    const result = await polaris().request("sessions.setAutoArchive", {
      hostKey: host.key,
      settings: { afterDays: next },
    });

    if (!result.ok) {
      showRefusal("Couldn't save auto-archive", result.error);
      await load();
    }
  };

  const days =
    afterDays == null || CHOICES.includes(afterDays)
      ? CHOICES
      : [...CHOICES, afterDays].toSorted((a, b) => a - b);

  const options: ReadonlyArray<SettingsOption<string>> = [
    ...days.map((d) => ({ value: String(d), label: label(d) })),
    { value: NEVER, label: "Never" },
  ];

  return (
    <SettingsHostRow name={host.label} colour={hostColour(host)} offline={!connected}>
      <SettingsSelect
        label={`Archive dormant sessions on ${host.label}`}
        value={afterDays === undefined ? undefined : afterDays === null ? NEVER : String(afterDays)}
        options={options}
        placeholder="Loading…"
        disabled={afterDays === undefined}
        onChange={(value) => void save(value === NEVER ? null : Number(value))}
      />
    </SettingsHostRow>
  );
};

export const ArchiveCard = () => {
  const deleteMerged = useSettings((s) => s.sessions.deleteMergedBranch);

  const hosts = useApp((s) => s.hosts).filter((host) =>
    hasCapability(host, "sessions.auto-archive")
  );

  return (
    <SettingsCard
      title="Archive dormant sessions"
      aside="Per host"
      status="Pinned and constellation sessions are kept"
    >
      <SettingsWell>
        {hosts.map((host) => (
          <HostAutoArchive key={host.key} host={host} />
        ))}
        <SettingsToggleRow
          title="Delete merged branches"
          caption="Unmerged branches are never deleted"
          checked={deleteMerged}
          onCheckedChange={(on) => setSessionPrefs({ deleteMergedBranch: on })}
        />
      </SettingsWell>
    </SettingsCard>
  );
};
