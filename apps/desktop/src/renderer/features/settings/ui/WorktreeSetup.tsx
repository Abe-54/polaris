/**
 * Settings → Sessions' "Worker worktree setup" card: per host, per workspace, what runs in a
 * worker's new worktree before its first turn. Saved on each Host.
 */
import type { WorktreeSetup, Workspace } from "@polaris/protocol";
import {
  Input,
  Kicker,
  SettingsButton,
  SettingsCard,
  SettingsEmpty,
  type SettingsOption,
  SettingsRow,
  SettingsSelect,
  SettingsWell,
} from "@polaris/ui";
import { Data, Predicate } from "effect";
import { hasCapability } from "../../session/hooks.ts";
import { useState } from "react";
import { Commands } from "../../../commands.ts";
import type { HostView } from "../../../../shared/api.ts";
import { useApp } from "../../../shell/hooks.ts";
import { send } from "../../session/dispatch.ts";
import { hostColour } from "./AutoArchive.tsx";

const Setup = Data.taggedEnum<WorktreeSetup>();

type Mode = WorktreeSetup["_tag"] | "Auto";

const MODES: ReadonlyArray<SettingsOption<Mode>> = [
  { value: "Auto", label: "Detect from lockfile" },
  { value: "Disabled", label: "None" },
  { value: "Command", label: "Custom command" },
];

const WorkspaceSetup = ({
  hostKey,
  workspace,
  connected,
}: {
  readonly hostKey: string;
  readonly workspace: Workspace;
  readonly connected: boolean;
}) => {
  const current = workspace.worktreeSetup;

  const [command, setCommand] = useState(
    current !== null && Predicate.isTagged(current, "Command") ? current.command : ""
  );

  const [mode, setMode] = useState<Mode>(current?._tag ?? "Auto");
  const [busy, setBusy] = useState(false);

  const save = async (setup: WorktreeSetup | null) => {
    setBusy(true);

    const saved = await send(
      hostKey,
      Commands.SetWorktreeSetup({ workspaceId: workspace.id, setup }),
      "Couldn't save worktree setup"
    );

    if (!saved) setMode(current?._tag ?? "Auto");

    setBusy(false);
  };

  return (
    <div>
      <SettingsRow title={workspace.name}>
        <SettingsSelect
          label={`Worktree setup for ${workspace.name}`}
          value={mode}
          options={MODES}
          disabled={busy || !connected}
          onChange={(value) => {
            setMode(value);

            if (value === "Auto") void save(null);

            if (value === "Disabled") void save(Setup.Disabled());
          }}
        />
      </SettingsRow>
      {mode !== "Command" ? null : (
        <SettingsRow
          nested
          className="-mt-2 pt-0"
          title={
            <Input
              aria-label={`Setup command for ${workspace.name}`}
              className="text-code-inline h-[26px] font-mono"
              value={command}
              placeholder="bun i && bun run gen"
              onChange={(event) => setCommand(event.target.value)}
              disabled={busy || !connected}
            />
          }
        >
          <SettingsButton
            variant="ghost"
            disabled={busy || !connected || command.trim() === ""}
            onClick={() => void save(Setup.Command({ command: command.trim() }))}
          >
            Save
          </SettingsButton>
        </SettingsRow>
      )}
    </div>
  );
};

const HostLabel = ({ host }: { readonly host: HostView }) => (
  <div className="px-panel flex items-center gap-2 pt-[calc(var(--spacing-gap)+4px)]">
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-[2px]"
      style={{ backgroundColor: hostColour(host) }}
    />
    <Kicker>
      {host.label}
      {host.status.state === "connected" ? "" : " · not connected"}
    </Kicker>
  </div>
);

export const WorktreeSetupSettings = () => {
  const models = useApp((s) => s.hostModels);
  const hosts = useApp((s) => s.hosts).filter((host) => hasCapability(host, "workspace.setup"));

  const groups = hosts
    .map((host) => ({ host, workspaces: [...(models[host.key]?.workspaces.values() ?? [])] }))
    .filter((group) => group.workspaces.length > 0);

  return (
    <SettingsCard
      title="Worker worktree setup"
      aside="Before a worker's first turn"
      status="Bun · npm · pnpm · uv · trusted workspaces only"
    >
      {groups.length === 0 ? (
        <SettingsEmpty>No workspaces on a host that runs setup</SettingsEmpty>
      ) : (
        <SettingsWell rows={false}>
          {groups.map(({ host, workspaces }) => (
            <div key={host.key} className="divide-hairline flex flex-col divide-y">
              <HostLabel host={host} />
              {workspaces.map((workspace) => (
                <WorkspaceSetup
                  key={`${workspace.id}:${JSON.stringify(workspace.worktreeSetup)}`}
                  connected={host.status.state === "connected"}
                  hostKey={host.key}
                  workspace={workspace}
                />
              ))}
            </div>
          ))}
        </SettingsWell>
      )}
    </SettingsCard>
  );
};
