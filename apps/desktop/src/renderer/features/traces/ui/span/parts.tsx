/** The span panel's small pieces (Paper T1): a key/value row, a value as it reads, a quiet line. */
import { cn } from "@polaris/ui";
import { useMemo, type ReactNode } from "react";
import { showBidi } from "../../../data/grid/value.ts";
import { type SqlTokenKind, sqlTokens } from "../../../data/write/sqlTokens.ts";
import { REDACTED } from "../../model/span/fields.ts";

export const KICKER = "font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase";

const SQL_COLOUR: Record<SqlTokenKind, string> = {
  keyword: "text-syntax-keyword",
  string: "text-syntax-string",
  number: "text-syntax-type",
  comment: "text-syntax-comment",
  punctuation: "text-syntax-punctuation",
  plain: "",
};

const Sql = ({ text }: { readonly text: string }) => {
  const tokens = useMemo(() => sqlTokens(text), [text]);

  return tokens.map((t, i) => (
    <span key={i} className={SQL_COLOUR[t.kind]}>
      {showBidi(t.text)}
    </span>
  ));
};

/** A value in `code-inline`: "[redacted]" faint (whatever its key), SQL coloured, bidi named. */
export const Value = ({
  text,
  sql = false,
  className,
}: {
  readonly text: string;
  readonly sql?: boolean;
  readonly className?: string;
}) => (
  <span
    data-redacted={text === REDACTED ? "" : undefined}
    className={cn(
      "text-code-inline font-mono [overflow-wrap:anywhere] whitespace-pre-wrap",
      text === REDACTED ? "text-text-faint" : "text-text-default",
      className
    )}
  >
    {text === REDACTED ? text : sql ? <Sql text={text} /> : showBidi(text)}
  </span>
);

/** One field: its key in a 140px lane, its value wrapping beside it (Paper T1's rows). */
export const FieldRow = ({
  name,
  children,
}: {
  readonly name: string;
  readonly children: ReactNode;
}) => (
  <div className="flex gap-2.5 py-[3px] pr-4 pl-[30px]" data-testid="span-field">
    <span className="text-code-inline text-text-subtle w-[140px] shrink-0 font-mono [overflow-wrap:anywhere]">
      {name}
    </span>
    <span className="min-w-0 flex-1">{children}</span>
  </div>
);

/** A tab body's one line when it has nothing ("No logs were written during this span"). */
export const Quiet = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-caption text-text-subtle px-4 py-3">{children}</p>
);

/** `+12 ms` from the span's start, as events and logs show their time. */
export const offsetLabel = (startNano: string, atNano: string) => {
  const ms = Number(BigInt(atNano) - BigInt(startNano)) / 1e6;

  return `+${ms < 10 ? Number(ms.toFixed(1)) : Math.round(ms)} ms`;
};

/** A rounded outline action with its shortcut faint after it ("Open in Data ⌘4"). */
export const Pill = ({
  onClick,
  hint,
  mono,
  title,
  testId,
  children,
}: {
  readonly onClick: () => void;
  readonly hint: string | undefined;
  readonly mono?: boolean;
  readonly title?: string;
  readonly testId: string;
  readonly children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    data-testid={testId}
    className="border-text-strong/12 hover:bg-fill-hover focus-visible:ring-starlight h-tree-row flex min-w-0 cursor-default items-center gap-2 rounded-full border px-3 outline-none focus-visible:ring-2"
  >
    <span
      className={cn(
        "text-text-default min-w-0 truncate",
        mono ? "text-code-inline font-mono" : "text-label font-medium"
      )}
    >
      {children}
    </span>
    {hint === undefined ? null : (
      <span className="text-text-faint shrink-0 font-mono text-[11px] leading-[14px]">{hint}</span>
    )}
  </button>
);
