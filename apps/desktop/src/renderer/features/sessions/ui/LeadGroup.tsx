/**
 * A Lead in the sidebar (DESIGN.md, Constellation (DAG) → Sidebar; Paper C1): its session row
 * with the Constellation mark and "Lead · 7 workers", then its workers on a hairline rail under
 * their Task groups, needs-you first, accepted ones folded into one "A1, A2 done · show" line.
 */
import { cn, DisclosureChevron, Row } from "@polaris/ui";
import { type KeyboardEvent, useState } from "react";
import { needsYou, shownState } from "../../../routes/topBar.ts";
import { age } from "../../../shell/copy.ts";
import { SessionTile } from "../../../shell/glyphs.tsx";
import { useApp, useNav, useSelection, useShellActions } from "../../../shell/hooks.ts";
import { buttonProps, WithHover } from "../../../shell/sidebar/SessionRow.tsx";
import { LANE_MAX, laneWidth } from "../../constellation/model/lane.ts";
import { IdLane, laneStyle } from "../../constellation/ui/lane.tsx";
import { ConstellationMark, TaskGlyph } from "../glyphs.tsx";
import {
  doneLine,
  idsOnly,
  type LeadGroup as Group,
  type LeadWorker,
  leadLine,
  type SectionItem,
  type WorkerRow,
  type WorkerSection,
  workerSections,
} from "../model/leadGroups.ts";
import {
  blockedHover,
  setupHover,
  shownWorker,
  TONE_CLASS,
  waitingHover,
} from "../model/workerCopy.ts";
import { ConstellationPeek, useSpacePeek } from "../../constellation/ui/peek.tsx";
import { WaveBar } from "../../constellation/ui/waves.tsx";
import { RenameField, SessionMenu, useRenaming } from "./SessionMenu.tsx";
import { WorkerMenu } from "./WorkerMenu.tsx";
import { useConstellationActions, useFocusedTask } from "../source.ts";

interface GroupProps {
  readonly hostKey: string;
  readonly group: Group;
  readonly now: number;
}

/** Open, its workers show below; folded, the wave bar stands in for them (Paper X-H). */
const LeadLine = ({
  hostKey,
  group,
  open,
}: {
  readonly hostKey: string;
  readonly group: Group;
  readonly open: boolean;
}) => {
  const line = leadLine(group);

  if (!open)
    return (
      <span className="flex min-w-0 items-center gap-1">
        <WaveBar hostKey={hostKey} leadSessionId={group.lead.session.id} />
        <span className="sr-only">
          {line.workers}
          {line.needsYou === null ? null : ` · ${line.needsYou}`}
        </span>
      </span>
    );

  return (
    <span className="flex min-w-0 items-center gap-1">
      <ConstellationMark size={12} />
      <span className="truncate">Lead · {line.workers}</span>
    </span>
  );
};

/**
 * The row's id and title; when its Lead's ids are slugs the id alone fills the row, the
 * title in its tooltip and accessible name.
 */
const WorkerTitle = ({
  row,
  tone,
  idOnly,
}: {
  readonly row: LeadWorker;
  readonly tone: string;
  readonly idOnly: boolean;
}) =>
  idOnly ? (
    <span className="flex min-w-0" title={`${row.taskId} · ${row.title}`}>
      <span className={cn("text-code-inline truncate font-mono", tone)}>{row.taskId}</span>
      <span className="sr-only"> · {row.title}</span>
    </span>
  ) : (
    <span className="flex min-w-0 items-baseline gap-2">
      <IdLane id={row.taskId} max={LANE_MAX.sidebar} className={tone} />
      <span className="truncate">{row.title}</span>
    </span>
  );

const Worker = ({
  hostKey,
  group,
  row,
  idOnly,
  now,
}: {
  readonly hostKey: string;
  readonly group: Group;
  readonly row: LeadWorker;
  readonly idOnly: boolean;
  readonly now: number;
}) => {
  const { selectSession } = useShellActions();
  const { focusTask } = useConstellationActions();
  const selection = useSelection();
  const leadId = group.lead.session.id;
  const focused = useFocusedTask(hostKey, leadId);
  const shown = shownWorker(row);
  const hostLabel = useApp((s) => s.hosts.find((h) => h.key === row.hostKey)?.label ?? "its host");

  const selected =
    selection.pane === "session" &&
    ((selection.sessionId === leadId && focused === row.taskId) ||
      selection.sessionId === row.sessionId);

  const select = () => {
    selectSession({ hostKey, sessionId: leadId });
    focusTask({ hostKey, leadSessionId: leadId, taskId: row.taskId });
  };

  return (
    <WorkerMenu hostKey={hostKey} group={group} row={row} onFocus={select}>
      <Row
        {...buttonProps(select)}
        data-testid="worker-row"
        data-task={row.taskId}
        data-worker-state={row.state}
        aria-current={selected}
        selected={selected}
        className={cn(selected && "border-hairline bg-row-selected hover:bg-row-selected")}
        leading={
          <TaskGlyph glyph={shown.glyph} harness={row.entry?.session.harness ?? null} size={16} />
        }
        title={
          <WorkerTitle
            row={row}
            idOnly={idOnly}
            tone={shown.tone === "needs-you" ? "text-needs-you-text" : "text-text-subtle"}
          />
        }
        meta={<WorkerMeta row={row} shown={shown} hostLabel={hostLabel} now={now} />}
      />
    </WorkerMenu>
  );
};

/** The row's state or age: "setting up · 1m", "setup failed", "waiting · 2m", "31m". */
const WorkerMeta = ({
  row,
  shown,
  hostLabel,
  now,
}: {
  readonly row: LeadWorker;
  readonly shown: ReturnType<typeof shownWorker>;
  readonly hostLabel: string;
  readonly now: number;
}) => {
  const tone = TONE_CLASS[shown.tone];

  if (row.kind === "setup") {
    const since = age(row.setup.run.startedAt, now);
    const failed = row.state === "setup-failed";

    // The command would push the id and title out of a sidebar row; it shows on hover.
    return (
      <span className={tone} title={setupHover(row.setup.run, failed, since)}>
        {failed ? shown.word : `${shown.word} · ${since}`}
      </span>
    );
  }

  return <AttemptMeta row={row} tone={tone} word={shown.word} hostLabel={hostLabel} now={now} />;
};

const AttemptMeta = ({
  row,
  tone,
  word,
  hostLabel,
  now,
}: {
  readonly row: WorkerRow;
  readonly tone: string;
  readonly word: string | null;
  readonly hostLabel: string;
  readonly now: number;
}) =>
  row.waiting !== null ? (
    <span className={tone} title={waitingHover(row.waiting, age(row.waiting.since, now))}>
      waiting · {age(row.waiting.since, now)}
    </span>
  ) : row.slotSince === null ? (
    <span className={tone} title={row.state === "blocked" ? blockedHover(row.attempt) : undefined}>
      {word ?? age(row.attempt.startedAt, now)}
    </span>
  ) : (
    <span
      className={tone}
      title={`Waiting for a slot on ${hostLabel} · ${age(row.slotSince, now)}`}
    >
      waiting · {age(row.slotSince, now)}
    </span>
  );

const DoneLine = ({ group, onShow }: { readonly group: Group; readonly onShow: () => void }) => (
  <div className="h-tree-row gap-gap px-row-x text-caption text-text-subtle flex items-center">
    <TaskGlyph glyph="accepted" harness={null} size={16} />
    <span className="truncate">{doneLine(group.done)} ·</span>
    <button
      type="button"
      onClick={onShow}
      className="hover:text-text-default shrink-0 cursor-default underline-offset-2 hover:underline"
    >
      show
    </button>
  </div>
);

/** A Task group's heading, its label on the id lane and what needs you on the meta lane. */
const SectionHeading = ({ section }: { readonly section: WorkerSection }) => (
  <div
    data-testid="worker-section"
    className="h-tree-row gap-gap px-row-x text-caption text-text-subtle flex items-center"
  >
    <span aria-hidden className="w-4 shrink-0" />
    <span className="min-w-0 flex-1 truncate">{section.label}</span>
    {section.needsYou === 0 ? null : (
      <span className="text-needs-you-text tabular shrink-0">{section.needsYou} needs you</span>
    )}
  </div>
);

/** A step in from the hairline per depth, compactly. */
const indent = (depth: number) => (depth === 0 ? undefined : { marginLeft: `${depth * 0.75}rem` });

/**
 * A parent Task's heading, nesting its workers as the tab does: its id (alone when ids are
 * slugs) and title, then what needs you or is blocked under it on the meta lane.
 */
const ParentHeading = ({
  item,
  idOnly,
}: {
  readonly item: Extract<SectionItem, { kind: "parent" }>;
  readonly idOnly: boolean;
}) => (
  <div
    data-testid="worker-parent"
    data-parent={item.parent.id}
    className="h-tree-row gap-gap px-row-x text-caption text-text-subtle flex items-center"
    style={indent(item.depth)}
    title={`${item.parent.id} · ${item.parent.title}`}
  >
    <span aria-hidden className="w-4 shrink-0" />
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      {idOnly ? (
        <span className="text-code-inline truncate font-mono">{item.parent.id}</span>
      ) : (
        <>
          <IdLane id={item.parent.id} max={LANE_MAX.sidebar} />
          <span className="truncate">{item.parent.title}</span>
        </>
      )}
    </span>
    {item.needsYou > 0 ? (
      <span className="text-needs-you-text tabular shrink-0">{item.needsYou} needs you</span>
    ) : item.blocked > 0 ? (
      <span className="tabular shrink-0">{item.blocked} blocked</span>
    ) : null}
  </div>
);

const useOpen = (hostKey: string, group: Group) => {
  const selection = useSelection();
  const folded = useNav((s) => s.folded[group.key]);

  const inGroup =
    selection.hostKey === hostKey &&
    (selection.sessionId === group.lead.session.id ||
      group.workers.some((w) => w.sessionId === selection.sessionId));

  return folded === undefined ? inGroup : !folded;
};

export const LeadGroup = ({ hostKey, group, now }: GroupProps) => {
  const { selectSession, toggleFolded } = useShellActions();
  const { unfocusTask } = useConstellationActions();
  const density = useApp((s) => s.density);
  const selection = useSelection();
  const open = useOpen(hostKey, group);
  const [showDone, setShowDone] = useState(false);
  const { lead } = group;
  const leadId = lead.session.id;
  const focused = useFocusedTask(hostKey, leadId);

  const select = () => {
    selectSession({ hostKey, sessionId: leadId });
    unfocusTask({ hostKey, leadSessionId: leadId });
  };

  const selected =
    selection.pane === "session" && selection.sessionId === leadId && focused === null;

  const props = buttonProps(select);
  const peek = useSpacePeek();
  const rename = useRenaming();

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Space previews the Constellation (Paper 13); Enter still opens the Lead.
    if (event.key === " ") {
      event.preventDefault();
      peek.toggle();

      return;
    }

    if (event.key === "Enter") peek.setOpen(false);

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      toggleFolded(group.key, event.key === "ArrowRight");

      return;
    }

    props.onKeyDown(event);
  };

  const sections = workerSections(showDone ? [...group.workers, ...group.done] : group.workers);

  const ids = [...group.workers, ...group.done].flatMap((r) => [
    r.taskId,
    ...r.parents.map((p) => p.id),
  ]);

  const idOnly = idsOnly(group);

  return (
    <div className="flex flex-col" data-testid="lead-group" data-lead={leadId}>
      <WithHover hostKey={hostKey} entry={lead}>
        <SessionMenu hostKey={hostKey} entry={lead} onRename={rename.start}>
          <ConstellationPeek
            hostKey={hostKey}
            leadSessionId={leadId}
            open={peek.open}
            onOpenChange={peek.setOpen}
          >
            <Row
              {...props}
              {...peek.rowProps}
              onKeyDown={onKeyDown}
              aria-current={selected}
              aria-expanded={open}
              data-state={shownState(lead)}
              variant="session"
              selected={selected}
              tone={needsYou(lead) ? "needs-you" : "default"}
              leading={
                <SessionTile
                  state={shownState(lead)}
                  harness={lead.session.harness}
                  density={density}
                  celestial={lead.session.celestial}
                  lead
                />
              }
              title={
                rename.renaming ? (
                  <RenameField hostKey={hostKey} entry={lead} onDone={rename.stop} />
                ) : (
                  lead.session.title || group.view.constellation.name
                )
              }
              description={<LeadLine hostKey={hostKey} group={group} open={open} />}
              meta={age(lead.session.createdAt, now)}
              trailing={
                <button
                  type="button"
                  aria-label={open ? "Fold workers" : "Show workers"}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleFolded(group.key, !open);
                  }}
                  className="text-text-faint hover:text-text-default -mr-1 hidden size-4 cursor-default items-center justify-center group-hover/row:flex"
                >
                  <DisclosureChevron open={open} />
                </button>
              }
            />
          </ConstellationPeek>
        </SessionMenu>
      </WithHover>
      {open ? (
        <div
          data-testid="lead-workers"
          className="border-hairline ml-[calc(var(--spacing-gap)+var(--density-harness-tile)/2)] flex flex-col border-l pl-1"
          style={laneStyle(laneWidth(ids, LANE_MAX.sidebar))}
        >
          {sections.map((section) => (
            <div
              key={section.key}
              className="flex flex-col"
              role="group"
              aria-label={section.label ?? undefined}
            >
              {section.label === null ? null : <SectionHeading section={section} />}
              {section.items.map((item) =>
                item.kind === "parent" ? (
                  <ParentHeading key={item.key} item={item} idOnly={idOnly} />
                ) : (
                  <div key={item.key} style={indent(item.depth)}>
                    <Worker
                      hostKey={hostKey}
                      group={group}
                      row={item.row}
                      idOnly={idOnly}
                      now={now}
                    />
                  </div>
                )
              )}
            </div>
          ))}
          {group.done.length > 0 && !showDone ? (
            <DoneLine group={group} onShow={() => setShowDone(true)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
