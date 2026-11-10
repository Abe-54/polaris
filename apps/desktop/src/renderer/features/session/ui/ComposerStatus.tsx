/**
 * The composer footer's right side (Paper X-E): "Draft saved" once the Host holds the draft
 * (continuity), the running Subagents as their moons and a count (a popover lists each), the
 * context ring (hover for the context card), and the permission mode chip with its menu.
 */
import {
  CHIP,
  cn,
  ContextRing,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  type Harness,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@polaris/ui";
import type { DraftStatus } from "@polaris/client/continuity";
import { useState } from "react";
import type { SessionData } from "../../../store/plain.ts";
import { send } from "../dispatch.ts";
import { useHost } from "../hooks.ts";
import { permissionCommand, permissionLabel, permissionModesOn } from "../model/intent.ts";
import { contextChip, contextLabel } from "../model/meta.ts";
import type { SubagentRoster } from "../model/subagents.ts";
import { ContextReadout } from "./ContextCard.tsx";
import { PermissionGlyph } from "./permissionGlyphs.tsx";
import { RosterKicker, SubagentMoon, SubagentRows } from "./subagentRow.tsx";

const MOONS_SHOWN = 3;

// As the composer narrows, Send stays put: "· nearly full" goes first (the strip says it),
// then the permission chip keeps its glyph, then the Subagents chip its count.
const NEARLY_FULL_WORDS = "hidden @min-[600px]/composer:inline";

const PERMISSION_WORDS = "hidden @min-[500px]/composer:inline";

const SUBAGENT_WORDS = "hidden @min-[440px]/composer:inline";

// "Draft saved" is the first to go; "Draft not saved" stays, since it's worth knowing.
const DRAFT_SAVED_WORDS = "hidden @min-[680px]/composer:inline";

/** Says whether the Host holds the composer's text; nothing for an empty composer. */
export const draftCaption = (draft: string, status: DraftStatus | null): string | null => {
  if (draft.trim() === "") return null;

  if (status === "saved") return "Draft saved";

  return status === "unsaved" ? "Draft not saved" : null;
};

const DraftCaption = ({ text }: { readonly text: string | null }) =>
  text === null ? null : (
    <span
      data-testid="composer-draft-status"
      title={text === "Draft saved" ? "Your other devices see this draft" : undefined}
      className={cn(
        "text-caption whitespace-nowrap",
        text === "Draft saved" ? cn("text-text-faint", DRAFT_SAVED_WORDS) : "text-text-subtle"
      )}
    >
      {text}
    </span>
  );

const Subagents = ({
  harness,
  roster,
  onOpen,
}: {
  readonly harness: Harness;
  readonly roster: SubagentRoster;
  readonly onOpen: (subagentId: string) => void;
}) => {
  const [open, setOpen] = useState(false);

  if (roster.running === 0) return null;
  const moons = roster.working.slice(0, MOONS_SHOWN);
  const kicker = [`${roster.running} running`, roster.done > 0 ? `${roster.done} done` : null];

  const openOne = (id: string) => {
    setOpen(false);
    onOpen(id);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          data-testid="composer-subagents"
          className={cn(CHIP, "pr-gap gap-[7px] bg-transparent pl-1 hover:bg-transparent")}
        >
          <span className="flex">
            {moons.map((m, i) => (
              <button
                key={m.id}
                type="button"
                aria-label={`Open ${m.agent}: ${m.task}`}
                data-testid="composer-moon"
                onClick={() => openOne(m.id)}
                className={cn("flex cursor-default rounded-full", i > 0 && "-ml-1.5")}
              >
                <SubagentMoon index={m.index} working harness={harness} />
              </button>
            ))}
          </span>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="text-caption text-text-subtle hover:text-text-default tabular cursor-default whitespace-nowrap"
            >
              {roster.running}
              <span className={SUBAGENT_WORDS}>
                {roster.running === 1 ? " subagent" : " subagents"}
              </span>
            </button>
          </PopoverTrigger>
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        side="top"
        data-surface="raised"
        className="flex w-[460px] max-w-[calc(100vw-24px)] flex-col p-1"
        data-testid="subagents-popover"
      >
        <RosterKicker parts={["Subagents", ...kicker].filter((p) => p !== null)} />
        <div className="max-h-72 overflow-y-auto">
          <SubagentRows rows={roster.rows} harness={harness} onOpen={openOne} />
        </div>
      </PopoverContent>
    </Popover>
  );
};

/** "17%", "91% · nearly full", "84k" while the window is unknown, or "—" before any report. */
const ContextChip = ({
  hostKey,
  session,
  turnNumber,
}: {
  readonly hostKey: string;
  readonly session: SessionData;
  readonly turnNumber: number | null;
}) => {
  const usage = session.contextUsage;
  const label = contextLabel(usage);
  const chip = contextChip(usage);

  const readout = (
    <>
      <ContextRing share={chip.share} />
      <span className="text-caption text-text-default tabular font-mono whitespace-nowrap">
        {chip.words}
        {chip.nearlyFull ? <span className={NEARLY_FULL_WORDS}> · nearly full</span> : null}
      </span>
    </>
  );

  // Nothing to open yet: the chip holds its place so the footer doesn't shift on the first report.
  if (label === null)
    return (
      <span
        data-testid="composer-context-unknown"
        title="No context report yet"
        aria-label="Context usage not reported yet"
        className={cn(CHIP, "pr-row-x pl-gap cursor-default gap-[7px]")}
      >
        {readout}
      </span>
    );

  return (
    <ContextReadout
      hostKey={hostKey}
      session={session}
      label={label.text}
      detail={label.detail}
      turnNumber={turnNumber}
      triggerClassName={cn(CHIP, "pr-row-x pl-gap gap-[7px]")}
    >
      {readout}
    </ContextReadout>
  );
};

const Permission = ({
  hostKey,
  session,
}: {
  readonly hostKey: string;
  readonly session: SessionData;
}) => {
  const modes = permissionModesOn(useHost(hostKey)?.status.capabilities ?? []);
  const current = session.permissionMode;

  const pick = (mode: string) => {
    const found = modes.find((p) => p.mode === mode);

    if (found !== undefined && found.mode !== current)
      void send(hostKey, permissionCommand(session.id, found.mode), "Couldn't change permissions");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Permissions: ${permissionLabel(current)}`}
          data-testid="composer-permission"
          className={cn(CHIP, "px-row-x text-text-default gap-[7px]")}
        >
          <PermissionGlyph mode={current} />
          <span className={cn("text-caption font-medium", PERMISSION_WORDS)}>
            {permissionLabel(current)}
          </span>
          <svg
            width="8"
            height="8"
            viewBox="0 0 8 8"
            aria-hidden="true"
            className="text-text-faint"
          >
            <path
              d="M1.5 3l2.5 2.5L6.5 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-[280px]">
        <DropdownMenuRadioGroup value={current} onValueChange={pick}>
          {modes.map((p) => (
            <DropdownMenuRadioItem key={p.mode} value={p.mode} className="items-start">
              <span className="text-text-subtle mt-[3px]">
                <PermissionGlyph mode={p.mode} />
              </span>
              <span className="flex flex-col py-0.5">
                <span className="text-label text-text-strong">{p.label}</span>
                <span className="text-caption text-text-subtle">{p.detail}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export interface ComposerStatusProps {
  readonly hostKey: string;
  readonly harness: Harness;
  readonly session: SessionData;
  /** The session's Subagents (`subagentRoster`): the latest Turn's and any still running. */
  readonly roster: SubagentRoster;
  readonly onOpenSubagent: (subagentId: string) => void;
  readonly turnNumber: number | null;
  /** `draftCaption`'s words, or null. */
  readonly draft?: string | null;
}

export const ComposerStatus = ({
  hostKey,
  harness,
  session,
  roster,
  onOpenSubagent,
  turnNumber,
  draft,
}: ComposerStatusProps) => (
  <>
    <DraftCaption text={draft ?? null} />
    <Subagents harness={harness} roster={roster} onOpen={onOpenSubagent} />
    <ContextChip hostKey={hostKey} session={session} turnNumber={turnNumber} />
    <Permission hostKey={hostKey} session={session} />
  </>
);
