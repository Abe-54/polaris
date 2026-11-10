/**
 * The list above the composer while a `/` or `$` word is typed: Skills, then
 * Slash Commands, filtered as you type. Keyboard-first: the editor keeps focus
 * and owns ↑ ↓ ↵ ⇥ esc; a click picks too (DESIGN.md, Skills and Slash Commands).
 */
import { Button, CommandIcon, cn, Kbd, REVEAL_MOTION, SkillIcon } from "@polaris/ui";
import { useEffect, useRef } from "react";
import type { CommandOption, Menu } from "../model/commands.ts";
import type { CommandNotice } from "../model/notice.ts";
import { describe, sourceLabel } from "../model/labels.ts";

export interface CommandMenuProps {
  /** Said instead of the list when the Host can't list commands. */
  readonly notice: CommandNotice | null;
  /** Null while the list is still being read from the Host. */
  readonly menu: Menu | null;
  readonly loading: boolean;
  readonly active: number;
  readonly onPick: (index: number) => void;
  readonly onHover: (index: number) => void;
}

const GROUP_LABELS = { skill: "Skills", command: "Commands" } as const;

const Row = ({
  option,
  selected,
  onPick,
  onHover,
}: {
  readonly option: CommandOption;
  readonly selected: boolean;
  readonly onPick: () => void;
  readonly onHover: () => void;
}) => {
  const Icon = option.kind === "skill" ? SkillIcon : CommandIcon;
  const source = sourceLabel(option);

  return (
    <div
      role="option"
      aria-selected={selected}
      data-selected={selected ? "" : undefined}
      // The editor keeps focus: a mouse press must not move it.
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
      onMouseMove={onHover}
      className={cn(
        "rounded-row px-row-x flex cursor-default items-start gap-2.5 py-1.5 select-none",
        selected && "bg-fill-selected"
      )}
    >
      <Icon
        size={16}
        className={cn("mt-px shrink-0", selected ? "text-text-strong" : "text-text-subtle")}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "text-label truncate font-medium",
              selected ? "text-text-strong" : "text-text-default"
            )}
          >
            {option.sigil}
            {option.name}
          </span>
          {option.argumentHint === null ? null : (
            <span className="text-caption text-text-subtle truncate">{option.argumentHint}</span>
          )}
          {source === null ? null : (
            <span className="text-micro text-text-subtle ml-auto shrink-0">{source}</span>
          )}
        </span>
        <span className="text-caption text-text-subtle truncate">{describe(option)}</span>
      </span>
    </div>
  );
};

const NoticeRow = ({ notice }: { readonly notice: CommandNotice }) => (
  <div className="px-row-x flex items-center gap-3 py-1.5" data-testid="command-notice">
    <SkillIcon size={16} className="text-text-subtle shrink-0" />
    <p
      className="text-caption text-text-default line-clamp-2 min-w-0 flex-1"
      title={notice.message}
    >
      {notice.message}
    </p>
    {notice.action === null ? null : (
      <Button
        variant="secondary"
        size="sm"
        className="h-[22px] shrink-0 gap-1.5 px-2"
        // The editor keeps focus: a mouse press must not move it.
        onMouseDown={(event) => event.preventDefault()}
        onClick={notice.action.run}
      >
        {notice.action.label}
        <Kbd variant="plain">↵</Kbd>
      </Button>
    )}
  </div>
);

export const CommandMenu = ({
  notice,
  menu,
  loading,
  active,
  onPick,
  onHover,
}: CommandMenuProps) => {
  const list = useRef<HTMLDivElement>(null);

  // Keeps the highlighted row in view as ↑ ↓ move it.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (notice !== null) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          REVEAL_MOTION,
          "rounded-card border-hairline bg-surface-raised shadow-float max-w-[560px] border p-1.5"
        )}
      >
        <NoticeRow notice={notice} />
      </div>
    );
  }

  if (menu === null && !loading) return null;

  const options = menu?.options ?? [];
  const recent = menu?.recent ?? 0;
  const grouped = recent > 0 || new Set(options.map((o) => o.kind)).size > 1;

  /** The header a row starts, if any: "Recent" over the frecent picks, then by kind. */
  const header = (i: number, option: CommandOption) => {
    if (!grouped) return null;

    if (i === 0 && recent > 0) return "Recent";

    if (i < recent) return null;

    return i === recent || options[i - 1]?.kind !== option.kind ? GROUP_LABELS[option.kind] : null;
  };

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Skills and commands"
      data-testid="command-menu"
      className={cn(
        REVEAL_MOTION,
        "rounded-card border-hairline bg-surface-raised shadow-float max-h-[var(--menu-room,min(320px,40vh))] max-w-[560px] overflow-y-auto border p-1.5"
      )}
    >
      {menu === null ? (
        <p className="text-caption text-text-subtle px-row-x py-1.5">
          Reading skills and commands…
        </p>
      ) : null}
      {options.map((option, i) => (
        <div key={`${option.sigil}${option.name}`}>
          {header(i, option) === null ? null : (
            <div role="presentation" className="px-row-x text-caption text-text-subtle pt-2 pb-1">
              {header(i, option)}
            </div>
          )}
          <Row
            option={option}
            selected={i === active}
            onPick={() => onPick(i)}
            onHover={() => onHover(i)}
          />
        </div>
      ))}
      {menu !== null && menu.more > 0 ? (
        <p
          role="presentation"
          className="border-hairline text-caption text-text-subtle px-row-x mt-1 border-t pt-1.5 pb-0.5"
        >
          {menu.more} more · keep typing to narrow
        </p>
      ) : null}
    </div>
  );
};
