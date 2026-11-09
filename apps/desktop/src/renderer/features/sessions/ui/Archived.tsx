/**
 * The sidebar's archived section (ENG-679): at the foot of a Workspace's list, a fold like
 * Reviews ("Archived" and a count), each row with Unarchive.
 */
import { Button, DisclosureChevron, Row } from "@polaris/ui";
import { useMemo } from "react";
import { age } from "../../../shell/copy.ts";
import { SessionGlyph } from "../../../shell/glyphs.tsx";
import { useNav, useShellActions } from "../../../shell/hooks.ts";
import type { HostModel } from "../../../store/hostModel.ts";
import { unarchiveSession } from "../../session/archive.ts";
import { type ArchivedRow, archivedOf, archivedOpen } from "../model/archived.ts";
import { useConstellations } from "../source.ts";

/** The fold key for a Workspace's archived section. */
export const archivedKey = (scope: string) => `archived\u0000${scope}`;

/** One line, quiet; a lead its running Constellation lost gets a second line saying so. */
const ArchivedSessionRow = ({
  hostKey,
  row,
  now,
}: {
  readonly hostKey: string;
  readonly row: ArchivedRow;
  readonly now: number;
}) => {
  const { session } = row.entry;
  const { leaderless } = row;

  return (
    <Row
      data-testid="archived-row"
      variant={leaderless === null ? "list" : "session"}
      tone="quiet"
      leading={<SessionGlyph state="archived" harness={session.harness} />}
      title={session.title || "Untitled session"}
      description={
        leaderless === null ? undefined : `Lead of ${leaderless.name} · ${leaderless.state}`
      }
      meta={
        <span className="group-focus-within/row:hidden group-hover/row:hidden">
          {age(session.updatedAt, now)}
        </span>
      }
      trailing={
        // Unarchive takes the age's place on hover or focus, so titles keep the width at rest.
        <Button
          variant="ghost"
          size="xs"
          className="sr-only group-focus-within/row:not-sr-only group-hover/row:not-sr-only"
          onClick={() => void unarchiveSession(hostKey, session.id)}
        >
          Unarchive
        </Button>
      }
    />
  );
};

export interface ArchivedGroupProps {
  readonly hostKey: string;
  readonly model: HostModel;
  readonly workspaceId: string;
  readonly scope: string;
  readonly now: number;
}

export const ArchivedGroup = ({ hostKey, model, workspaceId, scope, now }: ArchivedGroupProps) => {
  const { toggleFolded } = useShellActions();
  const views = useConstellations(hostKey);
  const foldKey = archivedKey(scope);
  const folded = useNav((s) => s.folded[foldKey]);

  const rows = useMemo(
    () => archivedOf(model.sessions.values(), workspaceId, views),
    [model, workspaceId, views]
  );

  if (rows.length === 0) return null;
  const open = archivedOpen(rows, folded);

  return (
    <div className="flex flex-col pt-1.5" data-testid="archived-group">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggleFolded(foldKey, !open)}
        className="h-tree-row text-caption flex cursor-default items-center gap-1.5 px-2"
      >
        <DisclosureChevron open={open} className="text-text-faint" />
        <span className="text-text-subtle flex-1 text-left font-medium">Archived</span>
        <span className="text-text-subtle tabular">{rows.length}</span>
      </button>
      {open
        ? rows.map((row) => (
            <ArchivedSessionRow key={row.entry.session.id} hostKey={hostKey} row={row} now={now} />
          ))
        : null}
    </div>
  );
};
