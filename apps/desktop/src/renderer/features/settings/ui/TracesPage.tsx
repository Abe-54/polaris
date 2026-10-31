/**
 * Settings → Traces (DESIGN.md, Traces → Setup; Paper T4, right; built without a mockup of the
 * page itself): one Workspace at a time, picked in the card's corner, saved on its Host.
 */
import type { WorkspaceId } from "@polaris/protocol";
import { SettingsCard, SettingsEmpty, SettingsPage, SettingsSelect } from "@polaris/ui";
import { useState } from "react";
import { workspaceKeyOf } from "../../../../shared/acceptBranch.ts";
import { useApp, useSelection } from "../../../shell/hooks.ts";
import { showRefusal } from "../../session/dispatch.ts";
import {
  takeTracesSettingsTarget,
  TracesSettingsCard,
  tracesSettingsUnavailable,
  useWorkspaceTracesSettings,
} from "../../traces/index.ts";
import { sectionInfo } from "../model/sections.ts";
import type { WorkspaceOption } from "../model/workspaces.ts";
import { useWorkspaceOptions } from "./WorkspaceOverrides.tsx";

/** Three offset bars, a waterfall: the section's nav glyph. */
export const WaterfallGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <path d="M2 4h7M5 8h8M4 12h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** The deep-linked Workspace, else the selected one, else the first listed. */
const useInitialKey = (options: ReadonlyArray<WorkspaceOption>): string | null => {
  const { hostKey, workspaceId } = useSelection();

  const [initial] = useState(() => {
    const target = takeTracesSettingsTarget();

    if (target !== null) return workspaceKeyOf(target.hostKey, target.workspaceId);

    return hostKey === null || workspaceId === null ? null : workspaceKeyOf(hostKey, workspaceId);
  });

  return options.some((o) => o.key === initial) ? initial : (options[0]?.key ?? null);
};

const Body = ({ option }: { readonly option: WorkspaceOption }) => {
  const host = useApp((s) => s.hosts.find((h) => h.key === option.hostKey));
  const unavailable = tracesSettingsUnavailable(host);

  const { settings, update } = useWorkspaceTracesSettings(
    unavailable === null
      ? // SAFETY: option ids are the Host's own Workspace ids (workspaceOptions).
        { hostKey: option.hostKey, workspaceId: option.workspaceId as WorkspaceId }
      : null
  );

  if (unavailable !== null) return <SettingsEmpty>{unavailable}</SettingsEmpty>;

  if (settings.status === "loading") return <SettingsEmpty>Reading traces settings…</SettingsEmpty>;

  if (settings.status === "failed")
    return (
      <SettingsEmpty>
        Couldn’t read traces settings: {settings.error.message}
        <span className="font-mono"> · {settings.error.code}</span>
      </SettingsEmpty>
    );

  return (
    <TracesSettingsCard
      settings={settings.value}
      disabled={false}
      save={(patch) =>
        void update(patch).then((refused) => {
          if (refused !== null) showRefusal("Couldn’t save traces settings", refused);
        })
      }
    />
  );
};

export const TracesPage = () => {
  const info = sectionInfo("traces");
  const options = useWorkspaceOptions();
  const initial = useInitialKey(options);
  const [picked, setPicked] = useState<string | null>(null);
  const key = picked ?? initial;
  const option = options.find((o) => o.key === key);

  return (
    <SettingsPage title={info.title} blurb={info.blurb} scope="Each workspace">
      <SettingsCard
        title={option === undefined ? "Traces" : `${option.name} · traces`}
        aside={
          options.length === 0 ? undefined : (
            <SettingsSelect
              label="Workspace"
              value={key ?? undefined}
              options={options.map((o) => ({
                value: o.key,
                label: `${o.name} · ${o.hostLabel}`,
                short: o.name,
              }))}
              onChange={setPicked}
            />
          )
        }
        status={option === undefined ? undefined : `Saved on ${option.hostLabel}`}
      >
        {option === undefined ? (
          <SettingsEmpty>No workspaces yet</SettingsEmpty>
        ) : (
          <Body key={option.key} option={option} />
        )}
      </SettingsCard>
    </SettingsPage>
  );
};
