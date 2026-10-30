/**
 * The Browser tab's body in Output (DESIGN.md, Output → Browser; Paper "Browser (ENG-615)" B1–B3):
 * the session's tabs, the toolbar and URL bar, and the area main lays the page's view over.
 */
import type { SessionId, WorkspaceId } from "@polaris/protocol";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CodeIcon,
  cn,
  CursorIcon,
  EmptyState,
  GlobeIcon,
  type Harness,
  harnessHue,
  harnessTextVar,
  IconButton,
  LockIcon,
  PickElementIcon,
  PixelSparkleIcon,
  PlusIcon,
  ReloadIcon,
  ServerIcon,
} from "@polaris/ui";
import { Predicate } from "effect";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { BrowserTab, BrowserTabId } from "../../../shared/browserContract.ts";
import { polaris } from "../bridge.ts";
import { browserKey } from "./feed.ts";
import { displayUrl, tabLabel } from "./model.ts";
import { attachPick } from "./pick.ts";
import { useBrowserPlacement, useOverlayOpen } from "./placement.ts";
import { useBrowserUi } from "./state.ts";

export interface BrowserPaneProps {
  readonly hostKey: string;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly harness: Harness | null;
  /** The Host's name, for the empty state ("Host addresses load from Mac Studio"). */
  readonly hostLabel: string;
  /** The Host stages attachments, so a picked element can go to the next message. */
  readonly canAttach: boolean;
}

type Target = Pick<BrowserPaneProps, "hostKey" | "sessionId">;

const onTab = ({ hostKey, sessionId }: Target, tabId: BrowserTabId) => ({
  hostKey,
  sessionId,
  tabId,
});

/** Who drives a tab, by name: its Subagent, else the session's Harness. */
const agentName = (tab: BrowserTab, harness: Harness | null) => {
  const fallback = harness === null ? "The agent" : harnessHue(harness).name;

  return Predicate.isTagged(tab.openedBy, "Subagent") ? tab.openedBy.name : fallback;
};

const TabButton = ({
  tab,
  active,
  harness,
  target,
}: {
  readonly tab: BrowserTab;
  readonly active: boolean;
  readonly harness: Harness | null;
  readonly target: Target;
}) => {
  const byAgent = !Predicate.isTagged(tab.openedBy, "User");
  const subagent = Predicate.isTagged(tab.openedBy, "Subagent") ? tab.openedBy.name : null;
  const hue = harness === null ? undefined : harnessTextVar(harness);

  return (
    <div
      className={cn(
        "group/tab rounded-control flex h-7 max-w-52 min-w-0 shrink items-center",
        active ? "bg-fill-selected" : "hover:bg-fill-hover"
      )}
      data-testid="browser-tab"
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={() => void polaris().request("browser.activateTab", onTab(target, tab.tabId))}
        className="flex h-full min-w-0 cursor-default items-center gap-2 pl-2.5"
      >
        {byAgent ? (
          <CursorIcon
            size={12}
            className="shrink-0"
            style={{ color: tab.agentDriving ? hue : undefined }}
          />
        ) : (
          <GlobeIcon size={12} className="text-text-faint shrink-0" />
        )}
        {subagent === null ? null : (
          <span className="text-caption shrink-0 font-medium" style={{ color: hue }}>
            {subagent}
          </span>
        )}
        <span
          className={cn("text-caption truncate", active ? "text-text-strong" : "text-text-subtle")}
        >
          {tabLabel(tab)}
        </span>
      </button>
      <button
        type="button"
        aria-label="Close tab"
        onClick={() => void polaris().request("browser.closeTab", onTab(target, tab.tabId))}
        className={cn(
          "text-text-subtle hover:text-text-strong mx-1 grid size-5 shrink-0 cursor-default place-items-center rounded",
          !active && "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100"
        )}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
};

/** The URL bar's lead: the Host address badge, the padlock for https, else a globe. */
const Origin = ({ tab }: { readonly tab: BrowserTab | null }) => {
  if (tab?.hostAddress === true)
    return (
      <span
        className="bg-fill-selected text-caption text-text-default flex h-5 shrink-0 items-center gap-1.5 rounded px-1.5"
        data-testid="host-address-badge"
      >
        <ServerIcon size={12} className="text-starlight" />
        Host address
      </span>
    );

  if (tab?.url.startsWith("https://") === true)
    return <LockIcon size={12} className="text-text-subtle mx-1 shrink-0" aria-label="Secure" />;

  return <GlobeIcon size={12} className="text-text-faint mx-1 shrink-0" />;
};

interface BarProps {
  readonly tab: BrowserTab | null;
  readonly target: Target;
  /** Pick mode: null when the Host can't take the pick as an attachment. */
  readonly pick: { readonly on: boolean; readonly toggle: () => void } | null;
  readonly workspaceId: WorkspaceId;
  /** The bar opens a new tab rather than navigating this one (the + button). */
  readonly adding: boolean;
  readonly onDone: () => void;
}

const UrlBar = ({ tab, target, workspaceId, adding, onDone }: BarProps) => {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const opens = tab === null || adding;

  const go = async (text: string) => {
    const result = opens
      ? await polaris().request("browser.openTab", { ...target, workspaceId, url: text })
      : await polaris().request("browser.navigate", { ...onTab(target, tab.tabId), url: text });

    setError(!result.ok);

    if (!result.ok) return;
    setDraft(null);
    onDone();
    // As in a browser, the page has the focus once it loads.
    input.current?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && draft !== null) {
      event.preventDefault();
      void go(draft);
    }

    if (event.key === "Escape") {
      setDraft(null);
      setError(false);
      onDone();
      event.currentTarget.blur();
    }
  };

  return (
    <label
      className={cn(
        "border-hairline bg-surface-sunken rounded-control flex h-7 min-w-0 flex-1 items-center gap-1.5 border pr-2 pl-1",
        "focus-within:border-starlight",
        error && "border-failed/60"
      )}
    >
      <Origin tab={opens ? null : tab} />
      <input
        ref={input}
        key={adding ? "adding" : "tab"}
        // The empty state's one action, and the + button's: typing a URL.
        autoFocus={opens}
        value={draft ?? (opens ? "" : displayUrl(tab.url))}
        placeholder="Enter a URL or a host address"
        spellCheck={false}
        aria-label="Address"
        aria-invalid={error}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setError(false);
        }}
        onBlur={() => {
          setDraft(null);
          onDone();
        }}
        onKeyDown={onKeyDown}
        className="text-code-inline text-text-default placeholder:text-text-faint min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:font-sans"
        data-testid="browser-url"
      />
    </label>
  );
};

const Toolbar = (props: BarProps) => {
  const { tab, target } = props;
  const [devtools, setDevtools] = useState(false);

  const on = (run: (tabId: BrowserTabId) => void) => () => {
    if (tab !== null) run(tab.tabId);
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 px-2">
      <IconButton
        size="sm"
        label="Back"
        icon={<ChevronLeftIcon size={14} />}
        disabled={tab?.canGoBack !== true}
        onClick={on((id) => void polaris().request("browser.back", onTab(target, id)))}
      />
      <IconButton
        size="sm"
        label="Forward"
        icon={<ChevronRightIcon size={14} />}
        disabled={tab?.canGoForward !== true}
        onClick={on((id) => void polaris().request("browser.forward", onTab(target, id)))}
      />
      <IconButton
        size="sm"
        label="Reload"
        icon={<ReloadIcon size={14} />}
        disabled={tab === null}
        onClick={on(
          (id) =>
            void polaris().request("browser.reload", { ...onTab(target, id), ignoreCache: false })
        )}
      />
      <span className="w-1 shrink-0" />
      <UrlBar {...props} />
      <span className="w-1 shrink-0" />
      {props.pick === null ? null : (
        <IconButton
          size="sm"
          label={props.pick.on ? "Stop picking" : "Pick an element"}
          icon={<PickElementIcon size={14} />}
          aria-pressed={props.pick.on}
          // An agent's CDP clicks would land on the overlay and pick for the user.
          disabled={tab === null || tab.agentDriving}
          onClick={props.pick.toggle}
          className={props.pick.on ? "bg-fill-selected text-text-strong" : undefined}
          data-testid="browser-pick"
        />
      )}
      <IconButton
        size="sm"
        label={devtools ? "Close DevTools" : "Open DevTools"}
        icon={<CodeIcon size={14} />}
        disabled={tab === null}
        onClick={on((id) => {
          setDevtools(!devtools);
          void polaris().request("browser.devtools", { ...onTab(target, id), open: !devtools });
        })}
      />
    </div>
  );
};

/** A thin strip over the page while an agent drives the tab. */
const Driving = ({
  tab,
  harness,
}: {
  readonly tab: BrowserTab;
  readonly harness: Harness | null;
}) => {
  const hue = harness === null ? undefined : harnessTextVar(harness);

  return (
    <div
      className="bg-surface-sunken text-caption flex h-7 shrink-0 items-center gap-2 border-b px-3"
      style={{
        borderColor: hue === undefined ? undefined : `color-mix(in srgb, ${hue} 28%, transparent)`,
      }}
      data-testid="browser-driving"
    >
      <CursorIcon size={12} style={{ color: hue }} />
      <span style={{ color: hue }}>{agentName(tab, harness)} is using this tab</span>
    </div>
  );
};

/** Over the page while pick mode is on: what to do, and how to stop. */
const Picking = ({ onCancel }: { readonly onCancel: () => void }) => (
  <div
    className="border-hairline bg-surface-sunken text-caption flex h-7 shrink-0 items-center gap-2 border-b px-3"
    role="status"
    data-testid="browser-picking"
  >
    <PickElementIcon size={12} className="text-text-subtle" />
    <span className="text-text-default">Click an element to attach it to your next message</span>
    <button
      type="button"
      onClick={onCancel}
      className="text-text-subtle hover:text-text-strong ml-auto cursor-default"
    >
      Cancel <span className="text-text-faint">esc</span>
    </button>
  </div>
);

/** Pick mode in the active tab: the pick goes to the session's composer as a chip. */
const usePick = (props: BrowserPaneProps, tab: BrowserTab | null) => {
  const [picking, setPicking] = useState<BrowserTabId | null>(null);
  const { hostKey, workspaceId, sessionId } = props;

  const start = async (tabId: BrowserTabId) => {
    setPicking(tabId);

    const result = await polaris().request("browser.pick", { hostKey, sessionId, tabId });

    setPicking((now) => (now === tabId ? null : now));

    if (result.ok && result.value !== null)
      await attachPick({ hostKey, workspaceId, sessionId }, result.value);
  };

  const cancel = () => {
    if (picking !== null)
      void polaris().request("browser.cancelPick", { hostKey, sessionId, tabId: picking });
  };

  const on = picking !== null && picking === tab?.tabId;
  const driving = tab?.agentDriving === true;

  // An agent took the tab mid-pick: its clicks must reach the page, not the overlay.
  useEffect(() => {
    if (on && driving)
      void polaris().request("browser.cancelPick", { hostKey, sessionId, tabId: picking });
  }, [on, driving, hostKey, sessionId, picking]);

  return {
    on,
    cancel,
    toggle: () => {
      if (on) cancel();
      else if (tab !== null) void start(tab.tabId);
    },
  };
};

export const BrowserPane = (props: BrowserPaneProps) => {
  const { hostKey, workspaceId, sessionId, harness, hostLabel, canAttach } = props;
  const { tabs } = useBrowserUi(browserKey(hostKey, sessionId));
  const [adding, setAdding] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const covered = useOverlayOpen();
  const target = { hostKey, sessionId };
  const active = tabs.tabs.find((t) => t.tabId === tabs.active) ?? null;
  const pick = usePick(props, active);

  useBrowserPlacement(area, target, covered);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="browser">
      {tabs.tabs.length === 0 ? null : (
        <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-hidden px-2 pt-1">
          {tabs.tabs.map((tab) => (
            <TabButton
              key={tab.tabId}
              tab={tab}
              active={tab.tabId === tabs.active}
              harness={harness}
              target={target}
            />
          ))}
          <IconButton
            size="sm"
            label="New tab"
            icon={<PlusIcon size={14} />}
            onClick={() => setAdding(true)}
          />
        </div>
      )}
      <Toolbar
        tab={active}
        target={target}
        pick={canAttach ? pick : null}
        workspaceId={workspaceId}
        adding={adding}
        onDone={() => setAdding(false)}
      />
      {active?.agentDriving === true ? <Driving tab={active} harness={harness} /> : null}
      {pick.on ? <Picking onCancel={pick.cancel} /> : null}
      <div ref={area} className="border-hairline relative min-h-0 flex-1 border-t">
        {active === null && tabs.ready ? (
          <div className="grid h-full place-items-center pb-20" data-testid="browser-empty">
            <EmptyState
              icon={<PixelSparkleIcon size={24} className="text-text-strong" />}
              title="Open a host address, like localhost:3000"
              fact={`Host addresses load from ${hostLabel}; other URLs from this Mac.`}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};
