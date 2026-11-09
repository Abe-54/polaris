import { RequestsError, type HttpRequest, type RequestFile } from "@polaris/protocol";
import { Result } from "effect";
import { authorizationValue } from "./auth.ts";
import type { Line } from "./lines.ts";
import { parseDocument, type RequestBlock } from "./parse.ts";

/** A Request's request line, headers and body, without its `###` separator. */
export const serializeContent = (request: HttpRequest, eol = "\n") => {
  const lines = [`${request.method} ${request.url}`];

  for (const header of request.headers) lines.push(`${header.name}: ${header.value}`);

  if (request.auth) lines.push(`Authorization: ${authorizationValue(request.auth)}`);

  if (request.body !== undefined) lines.push("", ...request.body.split(/\r?\n/));

  return lines.join(eol);
};

export const serializeRequest = (request: HttpRequest, eol = "\n") =>
  `### ${request.name}${eol}${serializeContent(request, eol)}${eol}`;

/** A whole file from its Requests; comments, handlers and `@var` lines are not in a RequestFile. */
export const serialize = (file: RequestFile, eol = "\n") =>
  file.requests.map((request) => serializeRequest(request, eol)).join(eol);

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const renamed = (line: Line, name: string): Replacement => {
  const tag = /^(\s*(?:#|\/\/)\s*@name\s*[=:]?\s*)/.exec(line.text)?.[1];

  return {
    start: line.start,
    end: line.end,
    text: tag === undefined ? `### ${name}` : `${tag}${name}`,
  };
};

/** Renames where the name was written; a derived name becomes `### name` or a `# @name` line. */
const nameReplacement = (
  block: RequestBlock,
  name: string,
  eol: string
): Replacement | undefined => {
  if (block.request.name === name) return undefined;
  const source = block.name;

  if (source.kind !== "derived") return renamed(source.line, name);

  if (source.separator) return renamed(source.separator, name);

  return { start: block.contentStart, end: block.contentStart, text: `# @name ${name}${eol}` };
};

const apply = (text: string, replacements: ReadonlyArray<Replacement>) =>
  [...replacements]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (out, { start, end, text: value }) => out.slice(0, start) + value + out.slice(end),
      text
    );

const append = (text: string, request: HttpRequest, eol: string) => {
  if (text === "") return serializeRequest(request, eol);
  const ended = /\r?\n$/.test(text) ? text : `${text}${eol}`;

  return `${ended}${eol}${serializeRequest(request, eol)}`;
};

const error = (code: "E-REQUEST-NOT-FOUND" | "E-REQUEST-CONFLICT", message: string, fix: string) =>
  Result.fail(new RequestsError({ code, message, fix }));

/**
 * Writes `request` over the Request named `previousName` (or `request.name`), leaving every other
 * byte of the file as it was; a new name is appended. `previousName` must exist.
 */
export const editRequest = (
  text: string,
  path: string,
  request: HttpRequest,
  previousName?: string
): Result.Result<string, RequestsError> => {
  const document = parseDocument(text, path);
  const target = previousName ?? request.name;
  const block = document.blocks.find((item) => item.request.name === target);

  const clash = document.blocks.find(
    (item) => item.request.name === request.name && item !== block
  );

  if (previousName !== undefined && !block)
    return error(
      "E-REQUEST-NOT-FOUND",
      `${path} has no request named "${previousName}"`,
      "Reload the requests and save again"
    );

  if (clash && block)
    return error(
      "E-REQUEST-CONFLICT",
      `${path} already has a request named "${request.name}"`,
      "Choose another name"
    );

  if (!block) return Result.succeed(append(text, request, document.eol));

  const content = {
    start: block.contentStart,
    end: block.contentEnd,
    text: serializeContent(request, document.eol),
  };

  const name = nameReplacement(block, request.name, document.eol);

  // The content goes first: a `# @name` inserted at its start must land before it.
  return Result.succeed(apply(text, name ? [content, name] : [content]));
};
