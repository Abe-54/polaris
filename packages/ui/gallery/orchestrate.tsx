import { Fragment } from "react";

import {
  Badge,
  ApprovalCard,
  Button,
  Chip,
  HostStateChip,
  Dither,
  Kbd,
  PixelFailedIcon,
  PixelHandIcon,
  PlusIcon,
  SearchIcon,
  SegmentedControl,
  StateIcon,
  Toast,
  Wordmark,
} from "../src";
import { JumpMenuDialog } from "./jump-menu";
import { Intent, Output, Sidebar } from "./orchestrate-panes";

export interface OrchestrateProps {
  readonly density: string;
  readonly theme: string;
}

const params = new URLSearchParams(window.location.search);

function TitleBar() {
  return (
    <div className="border-hairline bg-surface-sunken flex h-11 shrink-0 items-center gap-4 border-b pr-3 pl-4">
      <div className="flex w-[60px] shrink-0 gap-2">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </div>
      <Wordmark />
      <SegmentedControl
        aria-label="Mode"
        value="orchestrate"
        onValueChange={() => undefined}
        options={[
          {
            value: "orchestrate",
            label: "Orchestrate",
            badge: (
              <Badge
                tone="needs-you"
                size="count"
                className="rounded-control h-[18px] min-w-[18px]"
              >
                2
              </Badge>
            ),
          },
          {
            value: "review",
            label: "Review",
            badge: <span className="text-micro font-regular text-text-subtle">3</span>,
          },
          { value: "edit", label: "Edit" },
        ]}
      />
      <span className="flex-1" />
      <JumpMenuDialog
        defaultOpen={params.get("k") === "1"}
        trigger={
          <button
            type="button"
            className="rounded-control border-hairline bg-bg text-body text-text-subtle flex h-7 w-[280px] shrink-0 cursor-default items-center gap-2 border pr-1.5 pl-2.5"
          >
            <SearchIcon size={14} />
            <span className="flex-1 text-left">Jump to a session or workspace</span>
            <Kbd>K</Kbd>
          </button>
        }
      />
      <Button variant="ghost" className="text-text-default px-2.5">
        <PlusIcon size={14} />
        New session
      </Button>
    </div>
  );
}

interface HostGroup {
  readonly host: string;
  readonly chips: readonly {
    readonly name: string;
    readonly glyph: "working" | "idle" | "dormant" | "needs-you" | "failed";
    readonly harness: "claude" | "codex";
    readonly needsYou?: number;
    readonly selected?: boolean;
  }[];
}

const HOSTS: readonly HostGroup[] = [
  {
    host: "Mac Studio",
    chips: [
      { name: "polaris", glyph: "working", harness: "claude", needsYou: 1, selected: true },
      { name: "sightline", glyph: "idle", harness: "claude" },
      { name: "shellhacks-fiu", glyph: "dormant", harness: "claude" },
    ],
  },
  {
    host: "Linux VM",
    chips: [
      { name: "nj-homes-choice-next", glyph: "needs-you", harness: "codex", needsYou: 1 },
      { name: "dcai", glyph: "working", harness: "codex" },
    ],
  },
  { host: "Raspberry Pi 4", chips: [{ name: "code", glyph: "failed", harness: "codex" }] },
  { host: "MacBook Pro", chips: [{ name: "~", glyph: "idle", harness: "claude" }] },
];

function ChipGlyph({ chip }: { readonly chip: HostGroup["chips"][number] }) {
  if (chip.glyph === "working") return <Dither hue={chip.harness} size={12} moving />;

  if (chip.glyph === "needs-you") return <PixelHandIcon size={12} className="text-needs-you" />;

  if (chip.glyph === "failed") return <PixelFailedIcon size={12} className="text-failed" />;

  return <StateIcon state={chip.glyph} harness={chip.harness} size={12} />;
}

const FIRST_SHORTCUT = HOSTS.map((_, i) =>
  HOSTS.slice(0, i).reduce((total, group) => total + group.chips.length, 1)
);

function WorkspaceBar() {
  return (
    <div className="border-hairline bg-surface-sunken flex h-10 shrink-0 items-center gap-1 border-b px-3">
      {HOSTS.map((group, groupIndex) => (
        <Fragment key={group.host}>
          {groupIndex === 0 ? null : <span className="bg-text-faint/25 mx-1.5 h-4 w-px" />}
          <HostStateChip host={group.host} state="connected" />
          {group.chips.map((chip, chipIndex) => (
            <Chip
              key={chip.name}
              selected={chip.selected ?? false}
              needsYou={chip.needsYou ?? 0}
              shortcut={`⌃${(FIRST_SHORTCUT[groupIndex] ?? 1) + chipIndex}`}
              leading={<ChipGlyph chip={chip} />}
            >
              {chip.name}
            </Chip>
          ))}
        </Fragment>
      ))}
    </div>
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

/** Artboard 5 ("Orchestrate · Elevated · Dark") rebuilt from @polaris/ui, statically. */
export function Orchestrate({ density, theme }: OrchestrateProps) {
  return (
    <div className={params.get("chrome") === "0" ? "" : "p-6"}>
      <div
        data-theme={theme}
        data-density={density}
        className="relative flex h-[900px] w-[1440px] flex-col overflow-hidden"
      >
        <TitleBar />
        <WorkspaceBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <Intent />
          <Output />
        </div>
        {params.get("toast") === "0" ? null : (
          <Toast
            className="absolute right-5 bottom-5"
            source="codex"
            icon={<PixelHandIcon size={24} className="text-needs-you" />}
            title="Codex needs you"
            message="Spike GPUI review screen wants to run cargo build --release"
            time="now"
            action={{ label: "Approve", onAction: () => undefined, shortcut: "⌘⇧A" }}
          />
        )}
        {params.get("hover") === "1" ? (
          <div className="rounded-card border-hairline bg-surface-raised shadow-float absolute top-[222px] left-[268px] w-[340px] overflow-clip border">
            <ApprovalCard {...APPROVAL} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
