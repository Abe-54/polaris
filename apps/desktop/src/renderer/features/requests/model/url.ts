/**
 * A Request's URL as written (DESIGN.md, Requests → URL bar): `{{variables}}` kept, cut into the
 * pieces the bar colours, and its query read and rewritten for the Params tab.
 */

export interface UrlPiece {
  /** `variable` is a whole `{{…}}`; `query` is text from the first `?` on. */
  readonly kind: "text" | "variable" | "query";
  readonly text: string;
}

const VARIABLE = /\{\{[^{}]*\}\}/g;

const piecesOf = (text: string, plain: UrlPiece["kind"]): Array<UrlPiece> => {
  const pieces: Array<UrlPiece> = [];
  let at = 0;

  for (const match of text.matchAll(VARIABLE)) {
    if (match.index > at) pieces.push({ kind: plain, text: text.slice(at, match.index) });
    pieces.push({ kind: "variable", text: match[0] });
    at = match.index + match[0].length;
  }

  if (at < text.length) pieces.push({ kind: plain, text: text.slice(at) });

  return pieces;
};

/** The pieces in order; joined, they are the URL again. */
export const urlPieces = (url: string): ReadonlyArray<UrlPiece> => {
  const query = url.indexOf("?");

  return query < 0
    ? piecesOf(url, "text")
    : [...piecesOf(url.slice(0, query), "text"), ...piecesOf(url.slice(query), "query")];
};

/** Every `{{name}}` in `text`, in order, without repeats or braces. */
export const variablesIn = (text: string): ReadonlyArray<string> => [
  ...new Set([...text.matchAll(VARIABLE)].map((m) => m[0].slice(2, -2).trim())),
];

export interface QueryParam {
  readonly name: string;
  readonly value: string;
}

/** The query's parameters as written, undecoded so `{{variables}}` stay readable. */
export const queryParams = (url: string): ReadonlyArray<QueryParam> => {
  const query = url.indexOf("?");

  if (query < 0) return [];

  return url
    .slice(query + 1)
    .split("&")
    .filter((part) => part !== "")
    .map((part) => {
      const equals = part.indexOf("=");

      return equals < 0
        ? { name: part, value: "" }
        : { name: part.slice(0, equals), value: part.slice(equals + 1) };
    });
};

/** The URL with its query replaced by `params`; no `?` when there are none. */
export const withQueryParams = (url: string, params: ReadonlyArray<QueryParam>): string => {
  const query = url.indexOf("?");
  const base = query < 0 ? url : url.slice(0, query);
  const kept = params.filter((p) => p.name !== "" || p.value !== "");

  if (kept.length === 0) return base;

  return `${base}?${kept.map((p) => (p.value === "" ? p.name : `${p.name}=${p.value}`)).join("&")}`;
};
