/**
 * The folded "Thought" disclosure (DESIGN.md, Turns in the conversation):
 * "Thinking…" with its elapsed time while live, "Thought for 12s" once done.
 */
import { DisclosureChevron } from "@polaris/ui";
import { type ReactNode, useState } from "react";
import { useNow } from "../../../shell/useNow.ts";
import type { ItemView } from "../model/items.ts";
import { thoughtLabel } from "../model/meta.ts";
import { type Hue, LiveMark } from "./items.tsx";
import { softWrap } from "./softWrap.tsx";

const Disclosure = ({
  open,
  onToggle,
  children,
}: {
  readonly open: boolean;
  readonly onToggle: (() => void) | null;
  readonly children: ReactNode;
}) =>
  onToggle === null ? (
    <span className="text-body text-text-subtle flex h-6 items-center gap-2 self-start">
      {children}
    </span>
  ) : (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="text-body text-text-subtle hover:text-text-default flex h-6 cursor-default items-center gap-2 self-start"
    >
      {children}
      <DisclosureChevron open={open} className="text-text-faint" />
    </button>
  );

type ReasoningView = Extract<ItemView, { kind: "reasoning" }>;

/** Ticks once a second, and only while the row is live and timed. */
const Label = ({ item, hue }: { readonly item: ReasoningView; readonly hue: Hue }) => {
  const ticking = item.live && item.startedAt !== null;
  const now = useNow(ticking ? 1000 : 3_600_000);
  const { label, elapsed } = thoughtLabel(item, now);

  return (
    <>
      {item.live ? <LiveMark hue={hue} /> : null}
      <span className="tabular" data-testid="thought-label">
        {label}
      </span>
      {elapsed === null ? null : <span className="text-text-subtle tabular">{elapsed}</span>}
    </>
  );
};

export const Reasoning = ({ item, hue }: { readonly item: ReasoningView; readonly hue: Hue }) => {
  const [open, setOpen] = useState(false);
  const empty = item.text.trim() === "";

  return (
    <div className="flex flex-col gap-1.5" data-testid="reasoning">
      <Disclosure open={open} onToggle={empty ? null : () => setOpen(!open)}>
        <Label item={item} hue={hue} />
      </Disclosure>
      {open && !empty ? (
        <p className="text-body text-text-subtle break-words whitespace-pre-wrap">
          {softWrap(item.text)}
        </p>
      ) : null}
    </div>
  );
};
