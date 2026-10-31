import { useState } from "react";

import {
  ApprovalCard,
  Button,
  Celestial,
  CodeWell,
  Composer,
  ContextMenu,
  ContextMenuContent,
  ContextMenuEntries,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  MENU_SEPARATOR_ENTRY,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  Toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  showToast,
} from "../../src";
import { JumpMenu, JumpMenuDialog } from "../jump-menu";
import { Section } from "./layout";

const noop = () => undefined;

export function ComposerSection() {
  return (
    <Section title="Composer and working strip">
      <div className="grid grid-cols-2 gap-3">
        <Composer harness="claude" model="Opus 5" branch="main" placeholder="Ask for a change" />
        <Composer harness="codex" model="GPT-5.5" branch="main" />
      </div>
      <Composer
        harness="claude"
        model="Opus 5"
        branch="main"
        working={{ elapsed: "1m 12s", onStop: () => undefined }}
      />
      <Composer
        harness="codex"
        model="GPT-5.5"
        branch="spike/gpui-review"
        working={{ elapsed: "8s", onStop: () => undefined }}
      />
      <Composer
        harness="claude"
        model="Opus 5"
        branch="main"
        defaultValue="!git status"
        shell={{
          where: (
            <>
              runs in <span className="font-mono">~/code/polaris</span>
            </>
          ),
        }}
      />
      <Composer
        harness="claude"
        model="Opus 5"
        branch="main"
        working={{ elapsed: "1m 12s", onStop: () => undefined }}
        shell={{
          where: (
            <>
              runs after this turn, in <span className="font-mono">~/code/polaris</span>
            </>
          ),
        }}
      />
    </Section>
  );
}

const APPROVAL = {
  harness: "codex",
  title: "Spike GPUI review screen",
  summary: "Codex wants to run a command · 42m",
  command: "cargo build --release -p review-spike",
  where: "Mac Studio · polaris · ⎇ spike/gpui-review",
  onAlwaysAllow: () => undefined,
} as const;

function Triggers() {
  const [checked, setChecked] = useState(true);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <HoverCard>
        <HoverCardTrigger asChild>
          <Button>Hover card</Button>
        </HoverCardTrigger>
        <HoverCardContent>
          <ApprovalCard {...APPROVAL} />
        </HoverCardContent>
      </HoverCard>
      <Popover>
        <PopoverTrigger asChild>
          <Button>Popover</Button>
        </PopoverTrigger>
        <PopoverContent>
          <PopoverTitle>Why is this not a problem?</PopoverTitle>
          <PopoverDescription>Rule changes wait for you.</PopoverDescription>
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Dropdown</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Agent session</DropdownMenuLabel>
          <DropdownMenuItem needsInput>Rename…</DropdownMenuItem>
          <DropdownMenuItem>Open in terminal</DropdownMenuItem>
          <DropdownMenuItem needsInput>Fork…</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked={checked} onCheckedChange={setChecked}>
            Follow the agent
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>
            Archive <DropdownMenuShortcut>Host offline</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ContextMenu>
        <ContextMenuTrigger className="rounded-control border-text-faint/40 text-caption text-text-subtle flex h-7 items-center border border-dashed px-3">
          Right-click here
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuEntries
            entries={[
              { kind: "item", label: "New file…", needsInput: true, onSelect: noop },
              { kind: "item", label: "New folder…", needsInput: true, onSelect: noop },
              MENU_SEPARATOR_ENTRY,
              { kind: "item", label: "Rename…", needsInput: true, shortcut: "F2", onSelect: noop },
              MENU_SEPARATOR_ENTRY,
              { kind: "item", label: "Copy path", onSelect: noop },
              { kind: "item", label: "Copy relative path", onSelect: noop },
              { kind: "item", label: "Reveal in Finder", onSelect: noop },
              {
                kind: "sub",
                label: "Message the lead about this",
                entries: [
                  { kind: "item", label: "Ask for a recommendation", onSelect: noop },
                  { kind: "item", label: "Let it decide", onSelect: noop },
                ],
              },
              MENU_SEPARATOR_ENTRY,
              {
                kind: "item",
                label: "Delete",
                destructive: true,
                shortcut: "⌘⌫",
                onSelect: noop,
              },
            ]}
          />
        </ContextMenuContent>
      </ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost">Tooltip</Button>
        </TooltipTrigger>
        <TooltipContent shortcut="⌘2">Open in Review</TooltipContent>
      </Tooltip>
      <Dialog>
        <DialogTrigger asChild>
          <Button>Dialog</Button>
        </DialogTrigger>
        <DialogContent showClose>
          <DialogHeader>
            <DialogTitle>Remove this workspace?</DialogTitle>
            <DialogDescription>
              Polaris forgets ~/code/polaris on Mac Studio. Files and worktrees stay on disk.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost">Cancel</Button>
            <Button variant="primary">Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <JumpMenuDialog trigger={<Button>Jump menu</Button>} />
      <Button
        onClick={() =>
          showToast({
            source: "codex",
            icon: <Celestial body="ringed" harness="codex" size={32} />,
            needsYou: true,
            title: (
              <>
                Spike GPUI review wants to run <code>cargo build</code>
              </>
            ),
            time: "now",
            action: { label: "Approve", onAction: () => undefined, shortcut: "⌘⇧A" },
            secondaryAction: { label: "Open session", onAction: () => undefined },
          })
        }
      >
        Show toast
      </Button>
    </div>
  );
}

/** Floating layers rendered in place for the side-by-side comparison, plus live triggers. */
export function FloatingSection() {
  return (
    <Section title="Floating layers">
      <Triggers />
      <div className="flex flex-wrap items-start gap-4">
        <div className="rounded-card border-hairline bg-surface-raised shadow-float w-[340px] overflow-clip border">
          <ApprovalCard {...APPROVAL} />
        </div>
        <div className="flex flex-col gap-3">
          <Toast
            source="codex"
            icon={<Celestial body="ringed" harness="codex" size={32} />}
            needsYou
            title={
              <>
                Spike GPUI review wants to run <code>cargo build</code>
              </>
            }
            time="now"
            action={{ label: "Approve", onAction: () => undefined, shortcut: "⌘⇧A" }}
            secondaryAction={{ label: "Open session", onAction: () => undefined }}
          />
          <Toast
            source="claude"
            icon={<Celestial body="cratered" harness="claude" size={32} />}
            title="Polaris planning finished · 3 files changed"
            time="1m"
            action={{
              label: "Open review",
              emphasis: "secondary",
              onAction: () => undefined,
              shortcut: "⌘2",
            }}
          />
        </div>
      </div>
      <div className="rounded-card border-hairline bg-surface-raised shadow-float w-[620px] max-w-full overflow-clip border">
        <JumpMenu />
      </div>
      <CodeWell>ssh-keyscan -t ed25519 linux-vm.local</CodeWell>
    </Section>
  );
}
