/**
 * Settings → Sessions' "Hidden workspaces" card (DESIGN.md, SR-01; ENG-566): every hidden
 * workspace with Unhide, and a destructive Remove that confirms in place, naming what goes
 * with it (docs/adr/0086).
 */
import type { WorkspaceId } from "@polaris/protocol";
import {
  SettingsButton,
  SettingsCard,
  SettingsConfirmRow,
  SettingsEmpty,
  SettingsWell,
} from "@polaris/ui";
import { useMemo, useState } from "react";
import { Commands } from "../../../commands.ts";
import { useApp } from "../../../shell/hooks.ts";
import { send } from "../../session/dispatch.ts";
import {
  type HiddenWorkspaceRow,
  hiddenWorkspaceRows,
  removalBlocked,
  removalConsequence,
  rowCaption,
} from "../model/hiddenWorkspaces.ts";
import { removeWorkspace } from "../removeWorkspace.ts";

type Act = (row: HiddenWorkspaceRow) => Promise<boolean>;

const Row = ({
  row,
  onRemove,
  onUnhide,
}: {
  readonly row: HiddenWorkspaceRow;
  readonly onRemove: Act;
  readonly onUnhide: Act;
}) => {
  const [busy, setBusy] = useState<"removing" | "unhiding" | null>(null);

  const run = (what: "removing" | "unhiding", act: Act) => {
    setBusy(what);
    // A done act unmounts the row; one refused hands it back.
    void act(row).then((done) => {
      if (!done) setBusy(null);
    });
  };

  const blocked = busy === "removing" ? "Removing…" : removalBlocked(row);

  return (
    <div data-testid="hidden-workspace" title={row.path}>
      <SettingsConfirmRow
        title={row.name}
        caption={rowCaption(row)}
        action="Remove workspace…"
        consequence={removalConsequence(row)}
        confirm={`Remove ${row.name}`}
        onConfirm={() => run("removing", onRemove)}
        {...(blocked === null ? {} : { disabledReason: blocked })}
      >
        <SettingsButton
          variant="ghost"
          disabled={!row.connected || busy !== null}
          onClick={() => run("unhiding", onUnhide)}
        >
          Unhide
        </SettingsButton>
      </SettingsConfirmRow>
    </div>
  );
};

const unhideWorkspace: Act = (row) =>
  send(
    row.hostKey,
    // SAFETY: the id came from this Host's own Workspace list.
    Commands.SetWorkspaceHidden({ workspaceId: row.workspaceId as WorkspaceId, hidden: false }),
    "Couldn't unhide the workspace"
  );

const hiddenCount = (n: number) => (n === 0 ? "None hidden" : `${n} hidden`);

export const HiddenWorkspaces = ({
  remove = (row: HiddenWorkspaceRow) => removeWorkspace(row.hostKey, row.workspaceId),
  unhide = unhideWorkspace,
}: {
  /** Sends the removal; tests and the preview pass their own. */
  readonly remove?: Act;
  readonly unhide?: Act;
}) => {
  const hosts = useApp((s) => s.hosts);
  const models = useApp((s) => s.hostModels);
  const constellations = useApp((s) => s.constellations);

  const rows = useMemo(
    () => hiddenWorkspaceRows(hosts, models, constellations),
    [hosts, models, constellations]
  );

  return (
    <SettingsCard
      title="Hidden workspaces"
      aside={hiddenCount(rows.length)}
      status="Removing never touches the folder on disk"
    >
      {rows.length === 0 ? (
        <SettingsEmpty>No hidden workspaces</SettingsEmpty>
      ) : (
        <SettingsWell>
          {rows.map((row) => (
            <Row key={row.key} row={row} onRemove={remove} onUnhide={unhide} />
          ))}
        </SettingsWell>
      )}
    </SettingsCard>
  );
};
