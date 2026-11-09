/**
 * The Input column (264px): the selected Workspace's Agent Sessions in the
 * Workspace bar, or the selected machine's sessions grouped by Workspace in
 * the machine bar; the Sessions / Needs you switch; "Needs you elsewhere".
 */
import { clientCopy } from "../../../shared/clientCopy.ts";
import type { Workspace } from "@polaris/protocol";
import {
  Button,
  DisclosureChevron,
  GearIcon,
  IconButton,
  Kbd,
  PlusIcon,
  SectionHeader,
  SegmentedControl,
} from "@polaris/ui";
import { useMemo } from "react";
import { slots } from "../../app/slots.tsx";
import { useDismissAll, useNeedsYouCount } from "../../features/needs-you/index.ts";
import {
  ReviewsGroup,
  reviewsKey,
  sectionsOf,
  useConstellationCount,
} from "../../features/sessions/index.ts";
import { type SidebarView, sessionOrder, workspaceKey } from "../../routes/selection.ts";
import {
  activeSessions,
  listedWorkspaces,
  shownState,
  shownWorkspaces,
} from "../../routes/topBar.ts";
import { WorkspaceChipMenu } from "../TopBarMenus.tsx";
import { emptyHostModel, type HostModel, type SessionEntry } from "../../store/hostModel.ts";
import type { HostView } from "../../../shared/api.ts";
import { age, homePath, plural } from "../copy.ts";
import { HostStateNote } from "../HostState.tsx";
import { useApp, useNav, useSelection, useShellActions } from "../hooks.ts";
import { useNow } from "../useNow.ts";
import { Elsewhere } from "./Elsewhere.tsx";
import { CompactSessionRow } from "./SessionRow.tsx";
import { commandShortcut } from "../../../shared/keymap.ts";

const useHostModel = (hostKey: string | null) =>
  useApp((s) => (hostKey === null ? undefined : s.hostModels[hostKey])) ?? emptyHostModel;

const ViewSwitch = () => {
  const { sidebar } = useSelection();
  const { showSidebar } = useShellActions();
  const waiting = useNeedsYouCount();

  return (
    <SegmentedControl<SidebarView>
      aria-label="Sidebar view"
      variant="fill"
      pill
      value={sidebar}
      onValueChange={showSidebar}
      options={[
        { value: "sessions", label: "Sessions" },
        {
          value: "needs-you",
          label: "Needs you",
          badge:
            waiting > 0 ? (
              <span className="text-micro text-needs-you-text">{waiting}</span>
            ) : undefined,
        },
      ]}
    />
  );
};

interface HeaderProps {
  readonly title: string;
  readonly caption: string;
  readonly canStart: boolean;
  readonly host?: HostView | undefined;
  /** The Workspace in view, whose right-click menu the title opens. */
  readonly workspace?: { readonly hostKey: string; readonly workspace: Workspace } | undefined;
}

/** Paper 10: in the Needs you view the header is the inbox's, with Dismiss all. */
const useInboxHeader = () => {
  const { sidebar } = useSelection();
  const { items, dismissAll } = useDismissAll();

  if (sidebar !== "needs-you") return null;

  return {
    caption: items.length === 0 ? "Nothing waiting" : `${items.length} waiting`,
    dismissAll: items.length === 0 ? null : dismissAll,
  };
};

const Header = ({ title, caption, canStart, host, workspace }: HeaderProps) => {
  const { startNewSession } = useShellActions();
  const inbox = useInboxHeader();

  const heading = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5" data-testid="sidebar-heading">
      <h1
        className="text-heading text-text-strong truncate"
        title={inbox === null ? title : undefined}
      >
        {inbox === null ? title : "Inbox"}
      </h1>
      <p
        className="text-caption text-text-subtle tabular truncate"
        title={inbox === null ? caption : undefined}
      >
        {inbox === null ? caption : inbox.caption}
      </p>
    </div>
  );

  return (
    <div className="px-panel pt-panel flex flex-col gap-3 pb-2">
      <div className="flex items-center gap-2">
        {workspace === undefined || inbox !== null ? (
          heading
        ) : (
          <WorkspaceChipMenu item={workspace} current>
            {heading}
          </WorkspaceChipMenu>
        )}
        {inbox?.dismissAll ? (
          <Button
            variant="ghost"
            size="xs"
            data-testid="dismiss-all"
            title={`Dismiss every item on ${clientCopy().machine} · each comes back if its session changes`}
            onClick={inbox.dismissAll}
          >
            Dismiss all
          </Button>
        ) : null}
        {canStart ? (
          <IconButton
            label="New session"
            icon={<PlusIcon />}
            shortcut={commandShortcut("session.new")}
            onClick={startNewSession}
          />
        ) : null}
      </div>
      {host === undefined ? null : <HostStateNote host={host} />}
      <ViewSwitch />
    </div>
  );
};

interface WorkspaceListProps {
  readonly hostKey: string;
  readonly model: HostModel;
  readonly workspace: Workspace;
}

const WorkspaceSessions = ({ hostKey, model, workspace }: WorkspaceListProps) => {
  const now = useNow();

  const entries = useMemo(
    () => [...activeSessions(model, workspace.id)].sort(sessionOrder),
    [model, workspace.id]
  );

  return (
    <div className="flex flex-col gap-0.5 px-2 pt-2">
      <slots.SessionList
        hostKey={hostKey}
        model={model}
        entries={entries}
        now={now}
        scope={workspaceKey(hostKey, workspace.id)}
        empty={`None in ${workspace.name}`}
        workspaceId={workspace.id}
      />
    </div>
  );
};

/** Machine groups show this many sessions, loudest first, then "N more". */
const GROUP_CAP = 3;

const hiddenSummary = (rest: ReadonlyArray<SessionEntry>) => {
  const states = [...new Set(rest.map((e) => shownState(e)))].map(
    (s) => s.charAt(0).toUpperCase() + s.slice(1).replace("-", " ")
  );

  return `${rest.length} more, ${states.join(", ")}`;
};

const MachineGroup = ({
  hostKey,
  model,
  workspace,
  now,
}: WorkspaceListProps & { readonly now: number }) => {
  const { toggleFolded } = useShellActions();
  const key = workspaceKey(hostKey, workspace.id);
  const folded = useNav((s) => s.folded[key]);
  const { sessionId, workspaceId } = useSelection();

  // Pinned and Reviews sessions sit in their own sections above and below the groups.
  const entries = useMemo(
    () =>
      sectionsOf([...activeSessions(model, workspace.id)].sort(sessionOrder), (e) => e).sessions,
    [model, workspace.id]
  );

  const lively = entries.some(
    (e) => e.session.id === sessionId || !["idle", "dormant"].includes(shownState(e))
  );

  const open = folded === undefined ? lively : !folded;
  const shown = entries.slice(0, GROUP_CAP);
  const rest = entries.slice(GROUP_CAP);

  return (
    <div className="flex flex-col px-2 pt-2">
      <WorkspaceChipMenu item={{ hostKey, workspace }} current={workspace.id === workspaceId}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggleFolded(key, !open)}
          className="h-tree-row text-caption flex cursor-default items-center gap-1.5 px-2"
        >
          <DisclosureChevron open={open} className="text-text-faint" />
          <span
            className="text-text-subtle flex-1 truncate text-left font-medium"
            title={workspace.path}
          >
            {workspace.name}
          </span>
          {workspace.hidden ? <span className="text-text-faint">hidden</span> : null}
          <span className="text-text-subtle tabular">{entries.length}</span>
        </button>
      </WorkspaceChipMenu>
      {open
        ? shown.map((entry) => (
            <CompactSessionRow
              key={entry.session.id}
              hostKey={hostKey}
              entry={entry}
              now={now}
              meta={age(entry.session.createdAt, now)}
            />
          ))
        : null}
      {open && rest.length > 0 ? (
        <p className="text-caption text-text-subtle pt-1 pr-2 pl-[34px]">{hiddenSummary(rest)}</p>
      ) : null}
    </div>
  );
};

const Footer = ({ caption }: { readonly caption: string }) => {
  const { openJump, openSettings } = useShellActions();

  return (
    <div className="pl-panel flex h-12 shrink-0 items-center gap-2 pr-2">
      <button type="button" onClick={openJump} className="flex cursor-default items-center gap-2">
        <Kbd>K</Kbd>
        <span className="text-caption text-text-subtle">Jump</span>
      </button>
      <span className="flex-1" />
      {/* On the dawn ridge the subtle line darkens to stay legible (DESIGN.md, The horizon). */}
      <span className="text-caption min-w-0 truncate text-[light-dark(#4a4c52,var(--color-text-subtle))]">
        {caption}
      </span>
      <IconButton
        label="Settings"
        shortcut={commandShortcut("settings.open")}
        size="sm"
        icon={<GearIcon size={14} />}
        className="text-text-subtle"
        onClick={() => openSettings()}
      />
    </div>
  );
};

const WorkspaceSidebar = () => {
  const { hostKey, workspaceId, sidebar } = useSelection();
  const model = useHostModel(hostKey);
  const host = useApp((s) => s.hosts.find((h) => h.key === hostKey));

  // The chosen Host; with none chosen yet, this Mac.
  const shown = useApp(
    (s) => s.hosts.find((h) => h.key === hostKey) ?? s.hosts.find((h) => h.kind === "local")
  );

  const hostCount = useApp((s) => s.hosts.length);
  const workspace = workspaceId === null ? undefined : model.workspaces.get(workspaceId);
  const constellations = useConstellationCount(hostKey, workspaceId);

  // New session still works here: it starts in the Host's home directory (onboarding).
  if (hostKey === null || workspace === undefined || host === undefined) {
    return (
      <SidebarFrame
        header={
          <Header
            title="No workspace yet"
            caption={shown === undefined ? "No hosts yet" : shown.label}
            canStart={shown?.status.state === "connected"}
            host={shown}
          />
        }
        footer={hostCount === 0 ? "" : plural(hostCount, "host")}
      >
        <div className="flex flex-col px-2 pt-2">
          <SectionHeader empty="None yet">Sessions</SectionHeader>
        </div>
      </SidebarFrame>
    );
  }

  const sessions = activeSessions(model, workspace.id);

  const worktrees = [...model.worktrees.values()].filter(
    (w) => w.workspaceId === workspace.id && !w.isMain
  );

  const sessionsLine =
    worktrees.length === 0
      ? plural(sessions.length, "session")
      : `${plural(sessions.length, "session")} · ${plural(worktrees.length, "worktree")}`;

  return (
    <SidebarFrame
      header={
        <Header
          title={workspace.name}
          caption={`${host.label} · ${homePath(workspace.path, host.status.host?.homeDir ?? null)}`}
          canStart
          host={host}
          workspace={{ hostKey, workspace }}
        />
      }
      footer={constellations === 0 ? sessionsLine : plural(constellations, "constellation")}
    >
      {sidebar === "needs-you" ? (
        <slots.NeedsYouInbox />
      ) : (
        <>
          <WorkspaceSessions hostKey={hostKey} model={model} workspace={workspace} />
          <Elsewhere hostKey={hostKey} workspaceId={workspace.id} />
        </>
      )}
    </SidebarFrame>
  );
};

const MachineSidebar = () => {
  const { hostKey, sidebar, workspaceId } = useSelection();
  const model = useHostModel(hostKey);
  const host = useApp((s) => s.hosts.find((h) => h.key === hostKey));
  const now = useNow();

  // A hidden Workspace is listed while it's open or a session in it needs you (topBar.ts).
  const listed = useMemo(
    () =>
      hostKey === null ? [] : listedWorkspaces({ hostKey, model, open: { hostKey, workspaceId } }),
    [hostKey, model, workspaceId]
  );

  const workspaces = listed.map((w) => w.workspace);
  const shownCount = listed.filter((w) => !w.hidden).length;

  if (hostKey === null || host === undefined) {
    return (
      <SidebarFrame
        header={<Header title="Polaris" caption="No hosts yet" canStart={false} />}
        footer=""
      />
    );
  }

  const sessions = activeSessions(model).length;

  return (
    <SidebarFrame
      header={
        <Header
          title={host.label}
          caption={plural(sessions, "session")}
          canStart={workspaces.length > 0}
          host={host}
        />
      }
      footer={plural(shownCount, "workspace")}
    >
      {sidebar === "needs-you" ? (
        <slots.NeedsYouInbox />
      ) : (
        <>
          <MachinePinned hostKey={hostKey} model={model} now={now} />
          {workspaces.map((workspace) => (
            <MachineGroup
              key={workspace.id}
              hostKey={hostKey}
              model={model}
              workspace={workspace}
              now={now}
            />
          ))}
          <MachineReviews hostKey={hostKey} model={model} now={now} />
          <Elsewhere hostKey={hostKey} workspaceId={null} />
        </>
      )}
    </SidebarFrame>
  );
};

interface MachineSectionProps {
  readonly hostKey: string;
  readonly model: HostModel;
  readonly now: number;
}

/** The machine's sections across its shown Workspaces (Paper 12b). */
const useMachineSections = (model: HostModel) =>
  useMemo(() => {
    const shown = new Set(shownWorkspaces(model).map((w) => w.id));

    const entries = activeSessions(model)
      .filter((e) => shown.has(e.session.workspaceId))
      .sort(sessionOrder);

    return sectionsOf(entries, (e) => e);
  }, [model]);

const compactRows = (hostKey: string, entries: ReadonlyArray<SessionEntry>, now: number) =>
  entries.map((entry) => (
    <CompactSessionRow
      key={entry.session.id}
      hostKey={hostKey}
      entry={entry}
      now={now}
      meta={age(entry.session.createdAt, now)}
    />
  ));

const MachinePinned = ({ hostKey, model, now }: MachineSectionProps) => {
  const { pinned } = useMachineSections(model);

  if (pinned.length === 0) return null;

  return (
    <div className="flex flex-col px-2 pt-2">
      <SectionHeader>Pinned</SectionHeader>
      {compactRows(hostKey, pinned, now)}
    </div>
  );
};

const MachineReviews = ({ hostKey, model, now }: MachineSectionProps) => {
  const { reviews } = useMachineSections(model);

  return (
    <div className="flex flex-col px-2">
      <ReviewsGroup foldKey={reviewsKey(hostKey)} entries={reviews}>
        {compactRows(hostKey, reviews, now)}
      </ReviewsGroup>
    </div>
  );
};

interface FrameProps {
  readonly header: React.ReactNode;
  readonly footer: string;
  readonly children?: React.ReactNode;
}

const SidebarFrame = ({ header, footer, children }: FrameProps) => (
  <aside aria-label="Sessions" className="flex w-[288px] shrink-0 flex-col pt-2 pr-1 pl-2">
    {header}
    {/* The list fades out above the horizon, so no legible row sits on its moon or stars. */}
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [mask-image:linear-gradient(to_bottom,black_calc(100%-128px),transparent_calc(100%-72px))] pb-32">
      {children}
    </div>
    <Footer caption={footer} />
  </aside>
);

export const Sidebar = () => {
  const { topBar } = useSelection();

  return topBar === "workspaces" ? <WorkspaceSidebar /> : <MachineSidebar />;
};
