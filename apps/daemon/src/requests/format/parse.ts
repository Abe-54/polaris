/** The `.http` parser: the VS Code REST Client and JetBrains HTTP Client subset (ADR 0098). */
import { HttpMethod, HttpRequest, RequestFile, type HttpHeader } from "@polaris/protocol";
import { Schema } from "effect";
import { authFromHeaders } from "./auth.ts";
import { isBlank, isComment, lineEnding, splitLines, type Line } from "./lines.ts";

/** Where a Request's name came from, so an edit rewrites it in the same place. */
export type NameSource =
  | { readonly kind: "separator"; readonly line: Line }
  | { readonly kind: "tag"; readonly line: Line }
  | { readonly kind: "derived"; readonly separator: Line | undefined };

/** A Request and the offsets an in-place edit replaces: `[contentStart, contentEnd)`. */
export interface RequestBlock {
  readonly request: HttpRequest;
  readonly name: NameSource;
  readonly contentStart: number;
  readonly contentEnd: number;
}

/** A file-level `@name = value` definition. */
export interface FileVariable {
  readonly name: string;
  readonly value: string;
  readonly line: number;
}

export interface ParseError {
  readonly line: number;
  readonly message: string;
}

export interface RequestDocument {
  readonly file: RequestFile;
  readonly blocks: ReadonlyArray<RequestBlock>;
  readonly variables: ReadonlyArray<FileVariable>;
  readonly eol: string;
}

const isMethod = Schema.is(HttpMethod);

const SEPARATOR = /^###(.*)$/;

const NAME_TAG = /^\s*(?:#|\/\/)\s*@name\s*[=:]?\s*(\S.*?)\s*$/;

const FILE_VARIABLE = /^\s*@([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/;

const REQUEST_LINE = /^(?:([A-Za-z]+)\s+)?(\S.*?)(?:\s+HTTP\/[\d.]+)?\s*$/;

const HEADER = /^([^\s:][^:]*?)\s*:\s?(.*)$/;

/** A response handler, redirect or reference ends the body: `> {% … %}`, `>> out.json`, `<> r.json`. */
const HANDLER = /^(?:>>?!?|<>)\s/;

interface Segment {
  readonly separator: Line | undefined;
  readonly lines: Line[];
}

const segments = (lines: ReadonlyArray<Line>) => {
  const found: Segment[] = [];
  let current: Segment = { separator: undefined, lines: [] };

  for (const line of lines) {
    if (SEPARATOR.test(line.text)) {
      found.push(current);
      current = { separator: line, lines: [] };
    } else current.lines.push(line);
  }

  found.push(current);

  return found;
};

const separatorName = (line: Line | undefined) =>
  line ? (SEPARATOR.exec(line.text)?.[1] ?? "").replace(/^#+/, "").trim() : "";

interface Prelude {
  name: NameSource | undefined;
  variables: FileVariable[];
  index: number;
}

/** Comments, `# @name` and `@var = value` lines before the request line. */
const prelude = (segment: Segment): Prelude => {
  const result: Prelude = { name: undefined, variables: [], index: segment.lines.length };

  if (separatorName(segment.separator) && segment.separator)
    result.name = { kind: "separator", line: segment.separator };

  for (const [index, line] of segment.lines.entries()) {
    const variable = FILE_VARIABLE.exec(line.text);
    const tag = NAME_TAG.exec(line.text);

    if (variable?.[1] !== undefined)
      result.variables.push({ name: variable[1], value: variable[2] ?? "", line: line.number });
    else if (tag) result.name ??= { kind: "tag", line };
    else if (!isBlank(line.text) && !isComment(line.text)) {
      result.index = index;
      break;
    }
  }

  return result;
};

const nameOf = (source: NameSource) => {
  switch (source.kind) {
    case "separator":
      return separatorName(source.line);
    case "tag":
      return NAME_TAG.exec(source.line.text)?.[1] ?? "";
    case "derived":
      return "";
  }
};

/** The URL plus JetBrains' indented `?a=1` / `&b=2` continuation lines. */
const requestUrl = (lines: ReadonlyArray<Line>, from: number, url: string) => {
  let index = from;
  let full = url;

  while (index < lines.length && /^\s+[?&]/.test(lines[index]?.text ?? "")) {
    full += (lines[index]?.text ?? "").trim();
    index++;
  }

  return { url: full, index };
};

interface Content {
  headers: HttpHeader[];
  body: string | undefined;
  end: number;
}

const headerLines = (lines: ReadonlyArray<Line>, from: number, errors: ParseError[]) => {
  const headers: HttpHeader[] = [];
  let index = from;

  for (; index < lines.length; index++) {
    const line = lines[index]!;

    if (isBlank(line.text)) break;

    if (isComment(line.text)) continue;
    const header = HEADER.exec(line.text);

    if (header?.[1]) headers.push({ name: header[1], value: header[2] ?? "" });
    else
      errors.push({
        line: line.number,
        message: "Expected a header (Name: value), or a blank line before the body",
      });
  }

  return { headers, index };
};

/** Headers until a blank line, then the body until a response handler or the next `###`. */
const content = (
  lines: ReadonlyArray<Line>,
  from: number,
  errors: ParseError[],
  fallback: number
) => {
  const { headers, index } = headerLines(lines, from, errors);
  let last: Line | undefined = lines[index - 1];
  const body: Line[] = [];

  for (let at = index + 1; at < lines.length; at++) {
    const line = lines[at]!;

    if (HANDLER.test(line.text)) break;
    body.push(line);
  }

  while (body.length > 0 && isBlank(body.at(-1)!.text)) body.pop();

  if (body.length > 0) last = body.at(-1);
  const text = body.map((line) => line.text).join("\n");

  return {
    headers,
    body: body.length > 0 ? text : undefined,
    end: last?.end ?? fallback,
  } satisfies Content;
};

const derivedName = (method: string, url: string) => {
  const path = url.replace(/^[a-z]+:\/\/[^/?#]*/i, "").replace(/^\{\{[^}]*\}\}/, "");

  return `${method} ${path.split(/[?#]/)[0] || "/"}`;
};

type RequestFields = Omit<ConstructorParameters<typeof HttpRequest>[0], "file">;

interface Parsed {
  block?: Omit<RequestBlock, "request"> & { fields: RequestFields };
  variables: FileVariable[];
}

const parseSegment = (segment: Segment, errors: ParseError[]): Parsed => {
  const head = prelude(segment);
  const first = segment.lines[head.index];

  if (!first) {
    if (head.name?.kind === "separator")
      errors.push({ line: head.name.line.number, message: "This request has no request line" });

    return { variables: head.variables };
  }

  const match = REQUEST_LINE.exec(first.text);
  const method = match?.[1] ?? "GET";

  if (!isMethod(method)) {
    errors.push({
      line: first.number,
      message: `Unsupported method ${method}: use GET, HEAD, OPTIONS, POST, PUT, PATCH or DELETE`,
    });

    return { variables: head.variables };
  }

  const { url, index } = requestUrl(segment.lines, head.index + 1, match?.[2] ?? first.text.trim());
  const parsed = content(segment.lines, index, errors, first.end);
  const { headers, auth } = authFromHeaders(parsed.headers);

  const fields: RequestFields = {
    name: head.name ? nameOf(head.name) : derivedName(method, url),
    method,
    url,
    headers,
    line: first.number,
  };

  if (parsed.body !== undefined) Object.assign(fields, { body: parsed.body });

  if (auth) Object.assign(fields, { auth });

  return {
    variables: head.variables,
    block: {
      name: head.name ?? { kind: "derived", separator: segment.separator },
      contentStart: first.start,
      contentEnd: parsed.end,
      fields,
    },
  };
};

/** Unique names: a repeated explicit name is an error; derived names get " (2)", " (3)"… */
const uniqueName = (name: string, taken: Set<string>) => {
  let candidate = name;

  for (let n = 2; taken.has(candidate); n++) candidate = `${name} (${n})`;
  taken.add(candidate);

  return candidate;
};

/** Parses a `.http` or `.rest` file; problems become `parseErrors`, never exceptions. */
export const parseDocument = (text: string, path: string): RequestDocument => {
  const errors: ParseError[] = [];
  const variables: FileVariable[] = [];
  const blocks: RequestBlock[] = [];
  const taken = new Set<string>();

  for (const segment of segments(splitLines(text))) {
    const parsed = parseSegment(segment, errors);
    variables.push(...parsed.variables);

    if (!parsed.block) continue;
    const { fields, ...offsets } = parsed.block;

    if (offsets.name.kind !== "derived" && taken.has(fields.name))
      errors.push({
        line: fields.line ?? 1,
        message: `Another request in this file is named "${fields.name}"`,
      });
    const name = uniqueName(fields.name, taken);

    blocks.push({ ...offsets, request: new HttpRequest({ ...fields, file: path, name }) });
  }

  return {
    file: new RequestFile({
      path,
      requests: blocks.map((block) => block.request),
      parseErrors: errors,
    }),
    blocks,
    variables,
    eol: lineEnding(text),
  };
};

export const parse = (text: string, path: string): RequestFile => parseDocument(text, path).file;
