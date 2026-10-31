/** A statement read-only in `code-inline`, syntax-coloured, a long one folded to its start. */
import { Button, cn } from "@polaris/ui";
import { useMemo, useState } from "react";
import { foldedSql, isLongSql } from "./model.ts";
import { type SqlTokenKind, sqlTokens } from "./sqlTokens.ts";

const COLOUR: Record<SqlTokenKind, string> = {
  keyword: "text-syntax-keyword",
  string: "text-syntax-string",
  number: "text-syntax-type",
  comment: "text-syntax-comment",
  punctuation: "text-syntax-punctuation",
  plain: "",
};

/** The statement's characters drawn at most; the rest is the Query Log's. */
const DRAWN_CHARS = 20_000;

export const SqlStatement = ({
  sql,
  className,
}: {
  readonly sql: string;
  readonly className?: string;
}) => {
  const long = isLongSql(sql);
  const [open, setOpen] = useState(false);
  const folded = long && !open;

  const shown = useMemo(() => {
    const text = folded ? foldedSql(sql) : sql;

    return sqlTokens(text.slice(0, DRAWN_CHARS));
  }, [sql, folded]);

  return (
    <div className={cn("border-hairline bg-well flex flex-col rounded-[10px] border", className)}>
      <pre
        className="text-code-inline text-text-default max-h-[320px] overflow-auto px-3 py-2.5 font-mono break-all whitespace-pre-wrap"
        data-testid="data-write-sql"
      >
        {shown.map((token, i) => (
          <span key={i} className={COLOUR[token.kind]}>
            {token.text}
          </span>
        ))}
        {folded ? <span className="text-text-faint">{"\n…"}</span> : null}
      </pre>
      {long ? (
        <Button
          variant="ghost"
          size="xs"
          className="mx-1.5 mb-1.5 self-start"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? "Show less" : "Show the whole statement"}
        </Button>
      ) : null}
    </div>
  );
};
