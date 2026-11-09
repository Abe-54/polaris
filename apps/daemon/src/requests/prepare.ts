/** From a RequestTarget to the bytes on the wire: load, resolve variables, read a `< file` body. */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative as relativePath } from "node:path";
import {
  RequestsError,
  SEND_BODY_CAP_BYTES,
  type AdHocRequest,
  type HttpHeader,
  type RequestRef,
  type RequestTarget,
  type ResolvedVariable,
} from "@polaris/protocol";
import { Match, Result } from "effect";
import { read } from "../data/read.ts";
import {
  REQUEST_FILE_LIMIT,
  encodedAuthorization,
  fileVariables,
  isRequestFile,
  parseDocument,
  resolveRequest,
  variableSources,
  type VariableSources,
} from "./format/index.ts";

export interface PreparedRequest {
  readonly ref: RequestRef | null;
  readonly environment?: string;
  /** Resolved: carries secret values, so it never leaves the Daemon as is. */
  readonly request: AdHocRequest;
  readonly headers: ReadonlyArray<HttpHeader>;
  readonly variables: ReadonlyArray<ResolvedVariable>;
  readonly secrets: ReadonlyArray<string>;
  /** The checkout-relative file a `< ./file` body was read from. */
  readonly bodyFile?: string;
}

export interface Loaded {
  readonly ref: RequestRef | null;
  readonly path: string | undefined;
  readonly request: AdHocRequest;
  readonly variables: Readonly<Record<string, string>>;
}

const requestNotFound = (ref: RequestRef) =>
  new RequestsError({
    code: "E-REQUEST-NOT-FOUND",
    message: `No Request named ${ref.name} in ${ref.file}.`,
    fix: "Pick a Request from the Requests view, or save it first.",
  });

const loadSaved = async (
  checkout: string,
  ref: RequestRef
): Promise<Result.Result<Loaded, RequestsError>> => {
  if (!isRequestFile(ref.file)) return Result.fail(requestNotFound(ref));
  const text = await read(checkout, ref.file, REQUEST_FILE_LIMIT);
  const document = parseDocument(text, ref.file);
  const block = document.blocks.find((item) => item.request.name === ref.name);

  if (block === undefined) return Result.fail(requestNotFound(ref));
  const { method, url, headers, body, auth } = block.request;

  return Result.succeed({
    ref: { file: ref.file, name: ref.name },
    path: ref.file,
    request: {
      method,
      url,
      headers,
      ...(body === undefined ? undefined : { body }),
      ...(auth === undefined ? undefined : { auth }),
    },
    variables: fileVariables(document),
  });
};

/** The target as written, with its file's `@var` values; nothing resolved yet. */
export const loadTarget = (checkout: string, target: RequestTarget) =>
  Match.valueTags(target, {
    Saved: ({ ref }) => loadSaved(checkout, ref),
    Inline: ({ request }) =>
      Promise.resolve(
        Result.succeed<Loaded>({ ref: null, path: undefined, request, variables: {} })
      ),
  });

const INPUT_FILE = /^<\s+(\S.*?)\s*$/;

const bodyFileError = (file: string) =>
  new RequestsError({
    code: "E-INPUT",
    message: `The body file ${file} isn't a readable file inside this checkout, under 1 MB.`,
    fix: "Point `< ./file` at a file inside the checkout, relative to the .http file.",
  });

/** Env files and key material never become a body: their values would leave unmasked. */
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|http-client\.private\.env\.json|id_[a-z0-9]+|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;

const secretFileError = (file: string) =>
  new RequestsError({
    code: "E-INPUT",
    message: `The body file ${file} holds secrets; Polaris won't send it as a body.`,
    fix: "Copy the values the body needs into a separate file, or use {{variables}}.",
  });

/** An empty read is an empty file only when the path is a zero-byte regular file inside. */
const emptyFile = async (checkout: string, relative: string) => {
  try {
    const root = await realpath(checkout);
    const path = await realpath(join(root, relative));
    const stat = await lstat(path);

    const inside = relativePath(root, path);

    return stat.isFile() && stat.size === 0 && !inside.startsWith("..") && !isAbsolute(inside);
  } catch {
    return false;
  }
};

/** JetBrains' `< ./file` body: read only when the path stays inside the checkout. */
export const bodyFromFile = async (
  checkout: string,
  requestFile: string | undefined,
  body: string
): Promise<Result.Result<{ body: string; file?: string }, RequestsError>> => {
  const file = INPUT_FILE.exec(body.trim())?.[1];

  if (file === undefined || body.trim().includes("\n")) return Result.succeed({ body });
  const relative = posix.normalize(posix.join(posix.dirname(requestFile ?? "."), file));

  if (isAbsolute(file) || relative === ".." || relative.startsWith("../"))
    return Result.fail(bodyFileError(file));

  if (SECRET_FILE.test(posix.basename(relative))) return Result.fail(secretFileError(file));
  const text = await read(checkout, relative, SEND_BODY_CAP_BYTES);

  if (text === "" && !(await emptyFile(checkout, relative)))
    return Result.fail(bodyFileError(file));

  return Result.succeed({ body: text, file: relative });
};

/** Values shorter than this are masked only when a Request used them, so "1" isn't masked everywhere. */
const MIN_UNUSED_SECRET = 6;

/** The resolved secrets plus every private-env and `.env` value, should one reach the body or a response. */
const allSecrets = (resolved: ReadonlyArray<string>, sources: VariableSources) => {
  const unused = [...Object.values(sources.private), ...Object.values(sources.dotenv)].filter(
    (value) => value.length >= MIN_UNUSED_SECRET
  );

  return [...new Set([...resolved, ...unused])];
};

/** The headers to send: `auth` becomes Authorization unless the Request sets one itself. */
export const wireHeaders = (request: AdHocRequest): HttpHeader[] => {
  const own = request.headers.some((header) => header.name.toLowerCase() === "authorization");

  if (request.auth === undefined || own) return [...request.headers];

  return [...request.headers, { name: "Authorization", value: encodedAuthorization(request.auth) }];
};

export interface PrepareOptions {
  readonly locality?: VariableSources["locality"];
}

export const prepare = async (
  checkout: string,
  target: RequestTarget,
  environment: string | undefined,
  options: PrepareOptions = {}
): Promise<Result.Result<PreparedRequest, RequestsError>> => {
  const loaded = await loadTarget(checkout, target);

  if (Result.isFailure(loaded)) return Result.fail(loaded.failure);
  const { ref, path, request, variables } = loaded.success;
  const sources = await variableSources(checkout, path, variables, environment);

  if (Result.isFailure(sources)) return Result.fail(sources.failure);

  const resolution = resolveRequest(
    request,
    { ...sources.success, ...(options.locality ? { locality: options.locality } : undefined) },
    environment
  );

  if (Result.isFailure(resolution)) return Result.fail(resolution.failure);
  const resolved = resolution.success.request;
  let body = resolved.body;
  let bodyFile: string | undefined;

  if (body !== undefined) {
    const read = await bodyFromFile(checkout, path, body);

    if (Result.isFailure(read)) return Result.fail(read.failure);
    body = read.success.body;
    bodyFile = read.success.file;
  }

  return Result.succeed({
    ref,
    ...(environment === undefined ? undefined : { environment }),
    request: { ...resolved, ...(body === undefined ? undefined : { body }) },
    headers: wireHeaders(resolved),
    variables: resolution.success.variables,
    secrets: allSecrets(resolution.success.secrets, sources.success),
    ...(bodyFile === undefined ? undefined : { bodyFile }),
  });
};
