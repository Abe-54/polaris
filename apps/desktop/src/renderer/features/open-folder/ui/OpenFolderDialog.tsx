/**
 * ⌘O, "Add workspace" (DESIGN.md, Open folder): pick a Host (this Mac or a
 * remote one, with its Connection State), then a folder on it, browsed over
 * the Host's own Daemon; the folder becomes a Workspace there and is selected.
 */
import {
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  FolderIcon,
} from "@polaris/ui";
import { type KeyboardEvent, useEffect, useState } from "react";
import type { HostView } from "../../../../shared/api.ts";
import { modKey, shortcutLabel } from "../../../../shared/chord.ts";
import { FIELD_CHORDS } from "../../../../shared/keymap.ts";
import { hostSentence } from "../../../shell/hostCopy.ts";
import { useNav, useShellActions } from "../../../shell/hooks.ts";
import { browsable, enter, START, up } from "../model.ts";
import { type Target, useFolderRows } from "../rows.ts";
import { useDialogHosts, useOpenFolder } from "../useOpenFolder.ts";
import { HostStrip } from "./HostStrip.tsx";

const Leading = () => <FolderIcon size={14} className="text-text-subtle" />;

/** The row cmdk has highlighted, by the `data-target` its item carries. */
const highlighted = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-selected="true"]')?.dataset.target ?? null;

interface BrowserProps {
  readonly host: HostView;
  readonly hosts: ReadonlyArray<HostView>;
  readonly onHost: (hostKey: string) => void;
  /** Moves cmdk's highlight: to the first row whenever the rows change under it. */
  readonly onHighlight: (id: string) => void;
}

const Browser = ({ host, hosts, onHost, onHighlight }: BrowserProps) => {
  const [typed, setTyped] = useState(START);
  const homeDir = host.status.host?.homeDir ?? null;
  const { open, busy, error } = useOpenFolder(host);
  const { groups, empty, byId } = useFolderRows(host, typed);
  const first = groups[0]?.rows[0]?.id ?? "";

  // A listing arrives after the Finder row: ↵ must mean the first row, never a stale one.
  useEffect(() => {
    onHighlight(first);
  }, [first, onHighlight]);

  const run = (target: Target, direct: boolean) => {
    if (target.kind === "finder") return void open.finder();

    if (target.kind === "create") return void open.create(target.path);

    if (target.kind === "folder" && !direct) return setTyped(enter(target.path, homeDir));

    void open.path(target.path);
  };

  const cycleHost = (step: number) => {
    const at = hosts.findIndex((h) => h.key === host.key);
    const next = hosts[(at + step + hosts.length) % hosts.length];

    if (next !== undefined) onHost(next.key);
  };

  // Ctrl+Tab changes Host, mod+Up goes up, mod+Enter opens the highlighted folder, Tab steps into it.
  const actionFor = (event: KeyboardEvent<HTMLDivElement>): (() => void) | null => {
    if (event.key === "Tab" && event.ctrlKey) return () => cycleHost(event.shiftKey ? -1 : 1);

    if (event.key === "ArrowUp" && modKey(event)) return () => setTyped(up(typed, homeDir));

    const target = byId.get(highlighted(event.currentTarget) ?? "");

    if (target === undefined) return null;

    if (event.key === "Enter" && modKey(event)) return () => run(target, true);

    const steps = event.key === "Tab" && !event.shiftKey && target.kind === "folder";

    return steps ? () => run(target, false) : null;
  };

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = actionFor(event);

    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };

  return (
    <div onKeyDownCapture={onKeyDownCapture} className="contents">
      <HostStrip hosts={hosts} value={host.key} onChange={onHost} />
      <CommandInput
        value={typed}
        onValueChange={setTyped}
        placeholder="~/code/polaris"
        hint={`Folders on ${host.label}`}
        aria-label={`Folder on ${host.label}`}
        className="text-code-inline font-mono"
        data-testid="folder-path"
        disabled={busy}
      />
      <CommandList aria-label="Folders">
        <CommandEmpty>{empty}</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group.heading} heading={group.heading}>
            {group.rows.map((row) => (
              <CommandItem
                key={row.id}
                value={row.id}
                data-target={row.id}
                data-testid={row.testId}
                leading={<Leading />}
                meta={row.meta}
                disabled={busy}
                onSelect={() => run(row.target, false)}
              >
                {row.title}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      {error === null ? null : (
        <p className="text-caption text-text-default px-4 pb-2.5" role="alert">
          {error}
        </p>
      )}
      <CommandFooter>
        <span>{shortcutLabel("Enter")} Enter folder</span>
        <span>{shortcutLabel(FIELD_CHORDS.submit)} Open</span>
        <span>{shortcutLabel(FIELD_CHORDS.folderUp)} Up</span>
        {hosts.length > 1 ? <span>{shortcutLabel(FIELD_CHORDS.nextHost)} Host</span> : null}
        <span className="flex-1" />
        <span>{shortcutLabel("Esc")}</span>
      </CommandFooter>
    </div>
  );
};

/** A Host that can't be browsed says why, in its Connection State's words. */
const Unavailable = ({ host, hosts, onHost }: BrowserProps) => (
  <div className="contents">
    <HostStrip hosts={hosts} value={host.key} onChange={onHost} />
    <p className="text-body text-text-default px-4 py-6" data-testid="folder-host-unavailable">
      {hostSentence(host, undefined)}
    </p>
    <CommandFooter>
      {hosts.length > 1 ? <span>{shortcutLabel(FIELD_CHORDS.nextHost)} Host</span> : null}
      <span className="flex-1" />
      <span>{shortcutLabel("Esc")}</span>
    </CommandFooter>
  </div>
);

const Body = ({ onHighlight }: Pick<BrowserProps, "onHighlight">) => {
  const route = useNav((s) => s.folder);
  const hosts = useDialogHosts();
  const [picked, setPicked] = useState<string | null>(null);
  const wanted = picked ?? route?.hostKey ?? null;
  const host = hosts.find((h) => h.key === wanted) ?? hosts.find(browsable) ?? hosts[0];

  if (host === undefined) return <CommandEmpty>No hosts yet</CommandEmpty>;

  const props = { host, hosts, onHost: setPicked, onHighlight };

  // Keyed by Host: each starts at its own home.
  return browsable(host) ? (
    <Browser key={host.key} {...props} />
  ) : (
    <Unavailable key={host.key} {...props} />
  );
};

/** Rendered only while open, like the jump menu (routes/keyboard.ts: Escape from state). */
export const OpenFolderDialog = () => {
  const open = useNav((s) => s.folder !== null);
  const { closeFolder } = useShellActions();
  const [highlight, setHighlight] = useState("");

  if (!open) return null;

  return (
    <CommandDialog
      open
      onOpenChange={(next) => {
        if (!next) closeFolder();
      }}
      shouldFilter={false}
      value={highlight}
      onValueChange={setHighlight}
      title="Open a folder"
      description="Choose a host, then a folder on it to add as a workspace"
    >
      <Body onHighlight={setHighlight} />
    </CommandDialog>
  );
};
