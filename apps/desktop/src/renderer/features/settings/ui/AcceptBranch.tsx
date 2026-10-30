/**
 * Settings → Sessions' "Accepting work" card (ENG-224): where accepted Turns are committed by
 * default (committing to main is first-class), and per-Workspace overrides under it.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SettingsButton,
  SettingsCard,
  SettingsOverrideRow,
  type SettingsOption,
  SettingsSelectRow,
  SettingsWell,
} from "@polaris/ui";
import { ACCEPT_BRANCH_LABELS } from "../../../../shared/acceptBranch.ts";
import type { AcceptBranchMode } from "../../../../shared/contract.ts";
import type { WorkspaceOption } from "../model/workspaces.ts";
import { setSessionPrefs, useSettings } from "../store.ts";
import { useWorkspaceOptions } from "./WorkspaceOverrides.tsx";

/** A narrow card's closed select shows these; its menu, the full wording. */
const SHORT: Readonly<Record<AcceptBranchMode, string>> = {
  auto: "Branch from default",
  current: "Current branch",
  create: "New branch",
};

const OPTIONS: ReadonlyArray<SettingsOption<AcceptBranchMode>> = (
  ["auto", "current", "create"] as const
).map((mode) => ({ value: mode, label: ACCEPT_BRANCH_LABELS[mode], short: SHORT[mode] }));

const without = <V,>(record: Readonly<Record<string, V>>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

const differs = (n: number) =>
  n === 0 ? "Every workspace commits alike" : `${n} workspace${n === 1 ? " differs" : "s differ"}`;

const AddWorkspace = ({
  options,
  onAdd,
}: {
  readonly options: ReadonlyArray<WorkspaceOption>;
  readonly onAdd: (key: string) => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild disabled={options.length === 0}>
      <SettingsButton>Add a workspace…</SettingsButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {options.map((o) => (
        <DropdownMenuItem key={o.key} onSelect={() => onAdd(o.key)}>
          {o.name} · {o.hostLabel}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

export const AcceptingWorkCard = () => {
  const mode = useSettings((s) => s.sessions.acceptBranch);
  const overrides = useSettings((s) => s.sessions.workspaceAcceptBranch);
  const options = useWorkspaceOptions().filter((o) => o.isGitRepo);
  const keys = Object.keys(overrides).toSorted();

  const setOverride = (key: string, next: AcceptBranchMode | null) =>
    setSessionPrefs({
      workspaceAcceptBranch:
        next === null ? without(overrides, key) : { ...overrides, [key]: next },
    });

  return (
    <SettingsCard
      title="Accepting work"
      aside="Where accepted turns commit"
      status={differs(keys.length)}
      action={
        <AddWorkspace
          options={options.filter((o) => !keys.includes(o.key))}
          onAdd={(key) => setOverride(key, mode === "current" ? "auto" : "current")}
        />
      }
    >
      <SettingsWell>
        <SettingsSelectRow
          title="Every workspace"
          label="Where accepted turns are committed"
          caption="A worktree session uses its branch"
          value={mode}
          options={OPTIONS}
          onChange={(next) => setSessionPrefs({ acceptBranch: next })}
        />
        {keys.map((key) => {
          const option = options.find((o) => o.key === key);
          const name = option?.name ?? key;

          return (
            <SettingsOverrideRow
              key={key}
              name={name}
              caption={`${option?.hostLabel ?? "Not on any connected host"} · overrides`}
              value={overrides[key] ?? null}
              options={OPTIONS}
              defaultLabel={SHORT[mode]}
              clearLabel={`Remove the override for ${name}`}
              onChange={(next) => setOverride(key, next)}
            />
          );
        })}
      </SettingsWell>
    </SettingsCard>
  );
};
