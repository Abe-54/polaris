/**
 * The K jump menu (Paper AR-0, X-F 07): one field across every Host, to sessions,
 * Workspaces, Worktrees and machines; commands are the Command Palette's. ↑↓ move, ↵ opens, ⌘↵ opens a
 * session in Review, esc closes. Fills the shell's `JumpMenu` slot.
 */
import {
  BranchIcon,
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  cn,
  FolderIcon,
  KICKER,
  SEVERITIES,
  SEVERITY_LABELS,
  SeverityGlyph,
} from "@polaris/ui";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { useStore } from "zustand";
import { useReviewSubject } from "../../routes/review.ts";
import { PullGlyph } from "../pulls/ui/glyphs.tsx";
import { usePulls } from "../pulls/store.ts";
import { subjectKey, surfaceStore } from "../review/index.ts";
import type { JumpMenuProps } from "../../app/slots.tsx";
import { barHosts } from "../../routes/topBar.ts";
import { SessionGlyph, SummaryGlyph } from "../../shell/glyphs.tsx";
import { useApp, useNav, useSelection, useShellActions } from "../../shell/hooks.ts";
import { jumpCopy } from "./copy.ts";
import { jumpGroups, type JumpGroup, type ReviewSources, searchedCount } from "./groups.ts";
import { matchSpans } from "./ranking.ts";
import { fileItems, findingItems, pullItems } from "./reviewItems.ts";
import { hostItems, type JumpItem, sessionItems, workspaceItems, worktreeItems } from "./items.ts";
import { useRunJump } from "./run.ts";
import { modKey, shortcutLabel } from "../../../shared/chord.ts";
import { FIELD_CHORDS } from "../../../shared/keymap.ts";

const Leading = ({ item }: { readonly item: JumpItem }) => {
  const { target } = item;

  if (target.kind === "pull") return <PullGlyph className="text-text-subtle" />;

  if (target.kind === "finding") {
    const severity = SEVERITIES.find((s) => SEVERITY_LABELS[s] === item.meta);

    return severity === undefined ? null : <SeverityGlyph severity={severity} tone="text" />;
  }

  if (target.kind === "workspace") return <FolderIcon size={16} className="text-text-subtle" />;

  if (target.kind === "worktree") return <BranchIcon size={16} className="text-text-subtle" />;

  if (item.state === null || item.harness === null) return null;

  if (target.kind === "host") {
    return (
      <SummaryGlyph
        summary={{ state: item.state, harness: item.harness, needsYou: 0, sessions: 0 }}
      />
    );
  }

  return <SessionGlyph state={item.state} harness={item.harness} size={16} />;
};

/** The title with the query's words, where they appear as written, in strong semibold. */
const Highlighted = ({ text, query }: { readonly text: string; readonly query: string }) => {
  const parts: Array<ReactNode> = [];
  let from = 0;

  for (const [start, end] of matchSpans(query, text)) {
    parts.push(text.slice(from, start));
    parts.push(
      <b key={start} className="text-text-strong font-semibold">
        {text.slice(start, end)}
      </b>
    );
    from = end;
  }

  parts.push(text.slice(from));

  return <>{parts}</>;
};

/** The right-hand lane: where it lives (a Workspace's path in mono), then its state or chord. */
const Meta = ({ item }: { readonly item: JumpItem }) => {
  if (item.detail === "" && item.meta === "") return undefined;

  return (
    <span className="flex max-w-80 min-w-0 items-center gap-2.5">
      {item.detail === "" ? null : (
        <span
          className={cn(
            "truncate",
            item.target.kind === "workspace" && "font-mono text-[11px] leading-4"
          )}
        >
          {item.detail}
        </span>
      )}
      {item.meta === "" ? null : <span className="shrink-0">{item.meta}</span>}
    </span>
  );
};

/** A group's kicker; "Sessions · 12" when more matched than it shows. */
const heading = (group: JumpGroup) => (
  <span className={KICKER}>
    {group.matched > group.items.length ? `${group.heading} · ${group.matched}` : group.heading}
  </span>
);

/** In Review: pull requests, and the open Review's files and findings. */
const useReviewSources = (mode: string): ReviewSources | undefined => {
  const list = usePulls((s) => s.list);
  const subject = useReviewSubject();
  const surfaces = useStore(surfaceStore, (s) => s);
  const surface = subject === null ? undefined : surfaces[subjectKey(subject)];

  return useMemo(
    () =>
      mode !== "review"
        ? undefined
        : {
            pulls: pullItems(list),
            files: fileItems(surface?.paths ?? []),
            findings: findingItems(surface?.findings ?? []),
          },
    [mode, list, surface]
  );
};

const useSources = () => {
  const hosts = useApp((s) => s.hosts);
  const models = useApp((s) => s.hostModels);
  const { topBar, mode } = useSelection();
  const collapsed = useNav((s) => s.collapsedHosts);
  const review = useReviewSources(mode);

  return useMemo(() => {
    const data = {
      bar: barHosts({ hosts, models, collapsed }),
      models,
      machineBar: topBar !== "workspaces",
    };

    return {
      sessions: sessionItems(data),
      workspaces: workspaceItems(data),
      worktrees: worktreeItems(data),
      hosts: hostItems(data),
      review,
    };
  }, [hosts, models, collapsed, topBar, review]);
};

const Results = ({ onClose }: { readonly onClose: () => void }) => {
  const [query, setQuery] = useState("");
  const sources = useSources();
  const copy = jumpCopy(useSelection().mode);
  const recent = useNav((s) => s.recent);
  const groups = jumpGroups({ query, sources, recent });
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const byId = new Map(groups.flatMap((g) => g.items.map((i) => [i.id, i])));
  const runJump = useRunJump();

  const open = (item: JumpItem, review: boolean) => {
    onClose();
    runJump(item.target, review);
  };

  // ⌘↵ opens the highlighted session in Review; cmdk marks the highlighted row.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || !modKey(event)) return;
    const highlighted = event.currentTarget.querySelector<HTMLElement>('[data-selected="true"]');
    const item = byId.get(highlighted?.dataset.jumpId ?? "");

    if (item === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    open(item, true);
  };

  return (
    <div onKeyDownCapture={onKeyDownCapture} className="contents">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={copy.placeholder}
        hint={<kbd className="font-mono text-[11px] leading-[14px]">esc</kbd>}
        aria-label={copy.label}
      />
      <CommandList aria-label="Results" className="max-h-[420px] p-1">
        <CommandEmpty>Nothing matches</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup
            key={group.heading}
            heading={heading(group)}
            className="border-hairline [&_[cmdk-group-heading]]:h-tree-row not-first:mt-1 not-first:border-t [&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-1 [&_[cmdk-group-heading]]:pb-0 first:[&_[cmdk-group-heading]]:pt-1"
          >
            {group.items.map((item) => (
              <CommandItem
                key={item.id}
                value={item.id}
                data-jump-id={item.id}
                data-testid="jump-item"
                leading={<Leading item={item} />}
                meta={<Meta item={item} />}
                onSelect={() => open(item, false)}
              >
                <Highlighted text={item.title} query={query} />
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <CommandFooter className="px-panel gap-4 bg-transparent">
        <span className={cn(KICKER, "min-w-0 flex-1 truncate")}>
          ↵ Open · {shortcutLabel(FIELD_CHORDS.submit)} Open in Review
        </span>
        <span className={cn(KICKER, "shrink-0")}>
          {shown} of {searchedCount(sources)}
        </span>
      </CommandFooter>
    </div>
  );
};

/**
 * Rendered only while open: a closing dialog must not linger through its fade-out
 * as Radix's topmost layer, taking the next overlay's Escape (routes/keyboard.ts).
 */
export const JumpMenu = ({ open, onOpenChange }: JumpMenuProps) => {
  const { setJumpOpen } = useShellActions();

  if (!open) return null;

  return (
    <CommandDialog
      open
      testId="jump-menu"
      className="w-[560px]"
      onOpenChange={onOpenChange}
      shouldFilter={false}
      title="Jump"
      description="Jump to a session, workspace, worktree or machine"
    >
      <Results onClose={() => setJumpOpen(false)} />
    </CommandDialog>
  );
};
