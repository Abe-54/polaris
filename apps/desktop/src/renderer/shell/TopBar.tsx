/**
 * The adaptive top bar (ENG-177): Workspace chips across every Host while
 * there are at most 10 (⌃1…⌃0), the machine bar from 11 (⌃1… per machine),
 * nothing with a single machine in machine mode. A Host's Connection State
 * shows inline, never as a modal.
 */
import { Badge, Chip, cn, Kbd, PlusIcon } from "@polaris/ui";
import { Fragment, type ReactNode, type RefObject, useLayoutEffect, useMemo, useRef } from "react";
import type { HostView } from "../../shared/api.ts";
import { type BarHost, barHosts, edgeFade, revealOffset, shortcutLabel } from "../routes/topBar.ts";
import {
  acknowledgeUpgrade,
  UpgradeHover,
  useUpgradeCaption,
} from "../features/machines/updates/UpgradeStatus.tsx";
import { HostsButton } from "../features/machines/hostsCard/HostsCard.tsx";
import { slots } from "../app/slots.tsx";
import { useQuietSessions } from "../features/needs-you/index.ts";
import { plural } from "./copy.ts";
import { HostBarLabel, HostStateCaption } from "./HostState.tsx";
import { isSlowLink } from "./hostCopy.ts";
import { SummaryGlyph } from "./glyphs.tsx";
import { useApp, useCommands, useNav, useSelection, useShellActions } from "./hooks.ts";
import { HostMenu, WorkspaceChipMenu } from "./TopBarMenus.tsx";
import { commandShortcut } from "../../shared/keymap.ts";

/** ⌃N, only on the first ten chips (Chip takes no undefined shortcut). */
interface ChipShortcut {
  shortcut?: string;
}

const useBar = () => {
  const hosts = useApp((s) => s.hosts);
  const models = useApp((s) => s.hostModels);
  const quiet = useQuietSessions();
  const collapsed = useNav((s) => s.collapsedHosts);
  const { hostKey, workspaceId } = useSelection();

  return useMemo(
    () => barHosts({ hosts, models, quiet, open: { hostKey, workspaceId }, collapsed }),
    [hosts, models, quiet, hostKey, workspaceId, collapsed]
  );
};

/** Room kept between a revealed chip and the bar's edge. */
const REVEAL_PAD = 16;

/** Scrolls the open chip (`[aria-pressed=true]`) into view in the bar. */
const reveal = (nav: HTMLElement) => {
  const open = nav.querySelector<HTMLElement>('[aria-pressed="true"]');

  if (open === null) return;
  const at = open.getBoundingClientRect().left - nav.getBoundingClientRect().left;
  const view = { start: nav.scrollLeft, size: nav.clientWidth };

  nav.scrollLeft = revealOffset(
    view,
    { start: at + nav.scrollLeft, size: open.offsetWidth },
    REVEAL_PAD
  );
};

/** Marks which edges have chips past them (`data-fade`), for the mask; set directly, no render. */
const markFade = (nav: HTMLElement) => {
  nav.dataset["fade"] = edgeFade({
    offset: nav.scrollLeft,
    view: nav.clientWidth,
    content: nav.scrollWidth,
  });
};

/**
 * Reveals the open chip when `key` changes and when the bar is resized (a narrower window),
 * and keeps the edge fade current on scroll, resize and every render (chips come and go).
 */
const useBarScroll = (bar: RefObject<HTMLElement | null>, key: string) => {
  useLayoutEffect(() => {
    const nav = bar.current;

    if (nav === null) return;
    reveal(nav);
    markFade(nav);

    const observer = new ResizeObserver(() => {
      reveal(nav);
      markFade(nav);
    });

    const onScroll = () => markFade(nav);

    observer.observe(nav);
    nav.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      nav.removeEventListener("scroll", onScroll);
    };
  }, [bar, key]);

  useLayoutEffect(() => {
    if (bar.current !== null) markFade(bar.current);
  });
};

/** A 24px fade on each side with chips past it; still, never animated (DESIGN.md, Chrome redesign). */
const EDGE_FADE =
  "data-[fade=start]:[mask-image:linear-gradient(to_right,transparent,black_24px)] data-[fade=end]:[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)] data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]";

const SCROLLER =
  "flex h-full min-w-0 flex-1 [scrollbar-width:none] items-center overflow-x-auto px-4";

/** A bar: its chips scroll, and the Hosts trigger stays pinned at the right edge, never clipped. */
const BarRow = ({
  height,
  children,
}: {
  readonly height: string;
  readonly children: ReactNode;
}) => (
  <div className={cn(height, "flex shrink-0 items-center pr-4 pb-1")}>
    {children}
    <HostsButton />
  </div>
);

const connected = (host: HostView) => host.status.state === "connected";

/** The Host's chips show last known state, dimmed, while it isn't connected (rule/remote-is-normal). */
const dimmed = (host: HostView) =>
  host.status.state === "reconnecting" || host.status.state === "offline";

/** Paper 57Q-1: a dashed chip that adds a Workspace (⌘O on this Mac). */
const AddWorkspaceChip = ({ hostKey }: { readonly hostKey: string | null }) => {
  const commands = useCommands();

  if (hostKey === null) return null;

  return (
    <button
      type="button"
      onClick={() => commands.run("workspace.add")}
      data-testid="add-workspace"
      className="hover:bg-fill-hover border-text-subtle/30 ml-1 flex h-[30px] shrink-0 cursor-default items-center gap-1.5 rounded-full border border-dashed px-3"
    >
      <span className="text-label text-text-subtle">+ Add workspace</span>
      <Kbd variant="plain" className="text-text-subtle">
        {commandShortcut("workspace.add")}
      </Kbd>
    </button>
  );
};

/** What a collapsed Host still shows: its loudest state, how many chips, and who needs you. */
const CollapsedSummary = ({ group }: { readonly group: BarHost }) => (
  <span className="flex items-center gap-1.5 pr-3" data-testid={`collapsed-${group.host.key}`}>
    <SummaryGlyph summary={group.summary} />
    <span className="text-caption text-text-subtle tabular">
      {group.workspaces.filter((w) => !w.hidden).length}
    </span>
    {group.summary.needsYou > 0 ? (
      <Badge tone="needs-you" size="count">
        {group.summary.needsYou}
      </Badge>
    ) : null}
  </span>
);

const collapseTitle = (group: BarHost) =>
  group.collapsed
    ? `Expand ${group.host.label} · ${plural(group.workspaces.filter((w) => !w.hidden).length, "workspace")}`
    : `Collapse ${group.host.label}`;

const HostLabel = ({ group }: { readonly group: BarHost }) => {
  const { host } = group;
  const selection = useSelection();
  const { selectHost, selectWorkspace, toggleHostCollapsed } = useShellActions();
  const first = group.workspaces[0];

  // Its first Workspace, or the Host itself when it has none (the stage to add one).
  const open = (at?: number) => {
    acknowledgeUpgrade(host.key);

    if (first === undefined) selectHost(host.key, at);
    else selectWorkspace({ hostKey: host.key, workspaceId: first.workspace.id }, at);
  };

  // A Host with Workspaces collapses and expands them; one without opens its stage to add one.
  const collapsible = first !== undefined;

  // Needs Attention is its own bordered chip (a button); the others are a label to select the Host.
  if (host.status.state === "needs-attention") {
    return (
      <HostMenu host={host}>
        <span className="flex shrink-0" data-host={host.key} data-connection={host.status.state}>
          <HostBarLabel host={host} onOpen={() => open()} />
        </span>
      </HostMenu>
    );
  }

  return (
    <UpgradeHover hostKey={host.key}>
      <HostMenu host={host}>
        <button
          type="button"
          {...(collapsible
            ? { "aria-expanded": !group.collapsed, title: collapseTitle(group) }
            : { "aria-pressed": host.key === selection.hostKey && selection.workspaceId === null })}
          onClick={(event) => {
            if (!collapsible) return open(event.timeStamp);
            acknowledgeUpgrade(host.key);
            toggleHostCollapsed(host.key);
          }}
          className="hover:bg-fill-hover flex h-[30px] shrink-0 cursor-default items-center rounded-full"
          data-host={host.key}
          data-connection={host.status.state}
        >
          <HostBarLabel host={host} onOpen={() => open()} />
          {group.collapsed && collapsible ? <CollapsedSummary group={group} /> : null}
        </button>
      </HostMenu>
    </UpgradeHover>
  );
};

/** A hidden chip's tooltip: why it's in the bar now, and until when. */
const hiddenTitle = (path: string, open: boolean) =>
  `${path}\nHidden · shown while ${open ? "it's open" : "a session here needs you"}`;

const WorkspaceBar = ({ bar }: { readonly bar: ReadonlyArray<BarHost> }) => {
  const selection = useSelection();
  const { selectWorkspace } = useShellActions();
  const nav = useRef<HTMLElement>(null);
  let index = 0;

  useBarScroll(nav, `${selection.hostKey}:${selection.workspaceId}`);

  return (
    <BarRow height="h-11">
      <nav ref={nav} aria-label="Workspaces" className={cn(EDGE_FADE, SCROLLER, "gap-1")}>
        {bar.map((group, groupIndex) => (
          <Fragment key={group.host.key}>
            {groupIndex === 0 ? null : (
              <span className="bg-text-faint/25 mx-1.5 h-4 w-px shrink-0" />
            )}
            <HostLabel group={group} />
            {group.workspaces.map((item) => {
              const { hostKey, workspace, summary } = item;

              const selected =
                hostKey === selection.hostKey && workspace.id === selection.workspaceId;

              // A collapsed Host keeps only the open chip, so you still see where you are.
              if (group.collapsed && !selected) return null;
              // A hidden or collapsed chip takes no ⌃N, so the others shift onto the visible ones.
              const shortcut = item.hidden || group.collapsed ? undefined : shortcutLabel(index++);
              const extra: ChipShortcut = {};

              if (shortcut !== undefined) extra.shortcut = shortcut;

              return (
                <slots.NeedsYouHover
                  key={workspace.id}
                  hostKey={hostKey}
                  workspaceId={workspace.id}
                >
                  <WorkspaceChipMenu item={item} current={selected}>
                    <Chip
                      title={item.hidden ? hiddenTitle(workspace.path, selected) : workspace.path}
                      // Pills on the ground; the open one is raised (DESIGN.md, Chrome redesign).
                      className={cn(
                        "h-[30px] rounded-full pr-3 pl-2.5",
                        selected && "bg-raised hover:bg-raised",
                        dimmed(group.host) && "opacity-(--opacity-dimmed)"
                      )}
                      data-hidden={item.hidden ? "" : undefined}
                      selected={selected}
                      needsYou={summary.needsYou}
                      {...extra}
                      leading={<SummaryGlyph summary={summary} />}
                      onClick={(event) =>
                        selectWorkspace({ hostKey, workspaceId: workspace.id }, event.timeStamp)
                      }
                    >
                      <span className="max-w-60 truncate">{workspace.name}</span>
                      {item.hidden ? (
                        <span className="text-caption text-text-subtle">hidden</span>
                      ) : null}
                    </Chip>
                  </WorkspaceChipMenu>
                </slots.NeedsYouHover>
              );
            })}
          </Fragment>
        ))}
        <AddWorkspaceChip hostKey={selection.hostKey} />
      </nav>
    </BarRow>
  );
};

/** "5 workspaces", or the state when that is the news (Paper MX-0: "Slow link"). */
const MachineCaption = ({ group }: { readonly group: BarHost }) => {
  const upgrade = useUpgradeCaption(group.host.key);

  if (!connected(group.host) || isSlowLink(group.host))
    return <HostStateCaption host={group.host} />;

  return (
    <span className="text-caption text-text-subtle">
      {upgrade ?? plural(group.workspaces.filter((w) => !w.hidden).length, "workspace")}
    </span>
  );
};

const MachineBar = ({ bar }: { readonly bar: ReadonlyArray<BarHost> }) => {
  const selection = useSelection();
  const { selectHost, openSettings } = useShellActions();
  const nav = useRef<HTMLElement>(null);

  useBarScroll(nav, `${selection.hostKey}`);

  return (
    <BarRow height="h-13">
      <nav ref={nav} aria-label="Machines" className={cn(EDGE_FADE, SCROLLER, "gap-1.5")}>
        {bar.map((group, index) => {
          const selected = group.host.key === selection.hostKey;
          const shortcut = shortcutLabel(index);

          return (
            <UpgradeHover key={group.host.key} hostKey={group.host.key}>
              <HostMenu host={group.host}>
                <button
                  type="button"
                  aria-pressed={selected}
                  data-host={group.host.key}
                  data-connection={group.host.status.state}
                  onClick={(event) => {
                    acknowledgeUpgrade(group.host.key);
                    selectHost(group.host.key, event.timeStamp);
                  }}
                  className={cn(
                    "gap-gap flex h-[38px] shrink-0 cursor-default items-center rounded-full border border-transparent pr-3 pl-3",
                    selected ? "border-hairline bg-raised" : "hover:bg-fill-hover"
                  )}
                >
                  <SummaryGlyph summary={group.summary} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span
                      title={group.host.label}
                      className={cn(
                        "text-label max-w-48 truncate",
                        selected ? "text-text-strong" : "text-text-default"
                      )}
                    >
                      {group.host.label}
                    </span>
                    <MachineCaption group={group} />
                  </span>
                  {group.summary.needsYou > 0 ? (
                    <Badge tone="needs-you" size="count">
                      {group.summary.needsYou}
                    </Badge>
                  ) : null}
                  {shortcut === undefined ? null : <Kbd variant="plain">{shortcut}</Kbd>}
                </button>
              </HostMenu>
            </UpgradeHover>
          );
        })}
        <button
          type="button"
          onClick={() => openSettings("hosts", { adding: true })}
          data-testid="add-machine"
          className="hover:bg-fill-hover flex h-[38px] shrink-0 cursor-default items-center gap-1.5 rounded-full px-3"
        >
          <PlusIcon size={14} className="text-text-subtle" />
          <span className="text-label font-regular text-text-subtle">Add machine</span>
        </button>
      </nav>
    </BarRow>
  );
};

export const TopBar = () => {
  const bar = useBar();
  const { topBar } = useSelection();

  if (topBar === "hidden" || bar.length === 0) return null;

  return topBar === "workspaces" ? <WorkspaceBar bar={bar} /> : <MachineBar bar={bar} />;
};
