/**
 * Settings → About › Developer Mode (ENG-709): one switch for all Hosts (locked on in Polaris
 * Dev), then each Host's Polaris Workspace with a picker to choose another.
 */
import { DEVELOPER_MODE_CAPABILITY, WorkspaceId } from "@polaris/protocol";
import {
  SettingsCard,
  SettingsHostRow,
  SettingsSelect,
  SettingsToggleRow,
  SettingsWell,
} from "@polaris/ui";
import { useMemo } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { setPolarisWorkspace, useDeveloperModes } from "../developerModeSync.ts";
import { useHostDeveloperModes } from "../hostDeveloperModes.ts";
import { BY_REMOTE, developerModeSwitch, polarisWorkspaceRow } from "../model/developerMode.ts";
import { setSessionPrefs, useSettings } from "../store.ts";

const PolarisWorkspaces = () => {
  const hosts = useApp((s) => s.hosts);
  const models = useApp((s) => s.hostModels);
  const read = useDeveloperModes();
  const watched = useHostDeveloperModes();

  const connected = hosts.filter(
    (h) =>
      h.status.state === "connected" && h.status.capabilities.includes(DEVELOPER_MODE_CAPABILITY)
  );

  const names = useMemo(
    () =>
      new Map(
        Object.values(models).flatMap((m) => [...m.workspaces.values()].map((w) => [w.id, w.name]))
      ),
    [models]
  );

  if (connected.length === 0) return null;

  return (
    <SettingsWell>
      <p className="px-panel text-caption text-text-subtle pt-2.5">
        Polaris workspace · where its own traces appear
      </p>
      {connected.map((host) => {
        const live = watched[host.key];
        const state = live === undefined ? read[host.key] : { kind: "mode" as const, mode: live };
        const row = polarisWorkspaceRow(host, state, names);

        const workspaces = [...(models[host.key]?.workspaces.values() ?? [])].filter(
          (w) => w.isGitRepo
        );

        return (
          <SettingsHostRow
            key={host.key}
            name={host.label}
            colour={host.colour ?? "var(--color-text-faint)"}
            fact={row.fact}
          >
            {row.value === null ? null : (
              <SettingsSelect
                label={`Polaris workspace on ${host.label}`}
                value={row.value}
                options={[
                  { value: BY_REMOTE, label: "Find by git remote", short: "By git remote" },
                  ...workspaces.map((w) => ({ value: w.id, label: w.name })),
                ]}
                onChange={(value) =>
                  void setPolarisWorkspace(
                    host.key,
                    value === BY_REMOTE ? null : WorkspaceId.make(value)
                  )
                }
              />
            )}
          </SettingsHostRow>
        );
      })}
    </SettingsWell>
  );
};

export const DeveloperModeCard = () => {
  const enabled = useSettings((s) => s.sessions.developerMode);
  const developmentBuild = useSettings((s) => s.developmentBuild);
  const toggle = developerModeSwitch(enabled, developmentBuild);

  return (
    <SettingsCard title="Developer mode" data-testid="about-developer-mode">
      <SettingsWell>
        <SettingsToggleRow
          title="Developer mode"
          caption={toggle.caption}
          checked={toggle.checked}
          disabled={toggle.locked}
          onCheckedChange={(on) => setSessionPrefs({ developerMode: on })}
        />
      </SettingsWell>
      <PolarisWorkspaces />
    </SettingsCard>
  );
};
