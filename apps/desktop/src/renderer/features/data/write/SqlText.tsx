/** SQL as coloured runs in the surrounding text style: keywords, strings, numbers, comments. */
import { useMemo } from "react";
import { showBidi } from "../grid/value.ts";
import { type SqlTokenKind, sqlTokens } from "./sqlTokens.ts";

export const SQL_COLOUR: Record<SqlTokenKind, string> = {
  keyword: "text-syntax-keyword",
  string: "text-syntax-string",
  number: "text-syntax-type",
  comment: "text-syntax-comment",
  punctuation: "text-syntax-punctuation",
  plain: "",
};

export const SqlText = ({ text }: { readonly text: string }) => {
  const tokens = useMemo(() => sqlTokens(text), [text]);

  return tokens.map((t, i) => (
    <span key={i} className={SQL_COLOUR[t.kind]}>
      {showBidi(t.text)}
    </span>
  ));
};
