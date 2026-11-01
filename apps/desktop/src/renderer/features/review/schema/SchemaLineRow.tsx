/**
 * One line of a table card (Paper D4): sign, kind word, name and what changed; a long view or
 * trigger definition folds behind a disclosure showing it before → after.
 */
import type { SchemaTableDiff } from "@polaris/protocol";
import { cn, CodeWell, DisclosureChevron } from "@polaris/ui";
import { useId, useState } from "react";
import type { LineChange, SchemaLine } from "./lines.ts";

export type Tone = LineChange | SchemaTableDiff["kind"];

export const TEXT: Record<Tone, string> = {
  added: "text-diff-added-text",
  removed: "text-diff-removed-text",
  changed: "text-git-modified-text",
  renamed: "text-git-modified-text",
  same: "text-text-default",
};

export const SIGN: Record<Tone, string> = {
  added: "+",
  removed: "−",
  changed: "~",
  renamed: "→",
  same: "",
};

const Definition = ({
  definition,
}: {
  readonly definition: NonNullable<SchemaLine["definition"]>;
}) => (
  <div data-testid="schema-definition" className="flex flex-col gap-1 pl-5">
    {definition.before !== null && (
      <CodeWell size="sm" className="text-diff-removed-text" aria-label="Before">
        {definition.before}
      </CodeWell>
    )}
    {definition.after !== null && (
      <CodeWell size="sm" className="text-diff-added-text" aria-label="After">
        {definition.after}
      </CodeWell>
    )}
  </div>
);

export const SchemaLineRow = ({ line }: { readonly line: SchemaLine }) => {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        data-testid="schema-line"
        data-change={line.change}
        className={cn(
          "gap-row-x flex min-w-0 items-baseline font-mono text-caption",
          TEXT[line.change]
        )}
      >
        <span aria-hidden="true" className="w-3 shrink-0 text-center">
          {SIGN[line.change]}
        </span>
        {line.what !== "column" && <span className="shrink-0">{line.what}</span>}
        {line.name !== line.what && (
          <span className="max-w-[40%] shrink-0 truncate" title={line.name}>
            {line.name}
          </span>
        )}
        <span
          className={cn("min-w-0 flex-1 truncate", line.change === "same" && "text-text-subtle")}
          title={line.detail}
        >
          {line.detail}
        </span>
        {line.definition !== undefined && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
            className="text-text-subtle hover:text-text-default rounded-control flex shrink-0 items-center gap-1 font-sans"
          >
            <DisclosureChevron open={open} />
            {open ? "Hide definition" : "Show definition"}
          </button>
        )}
      </div>
      {open && line.definition !== undefined && (
        <div id={id}>
          <Definition definition={line.definition} />
        </div>
      )}
    </div>
  );
};
