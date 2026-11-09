/**
 * A Request being edited: the saved Request's fields as the user changes them, compared with the
 * file's to mark unsaved edits, and turned into what save, send and the variables read.
 */
import {
  type AdHocRequest,
  type HttpHeader,
  type HttpMethod,
  HttpRequest,
  type RequestAuth,
  type RequestRef,
  RequestTarget,
} from "@polaris/protocol";

export interface Draft {
  readonly file: string;
  readonly name: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: ReadonlyArray<HttpHeader>;
  readonly body: string;
  readonly auth: RequestAuth | null;
  /** The saved Request's first line, for "Open in Edit"; null until it is saved. */
  readonly line: number | null;
}

/** Where a new or imported Request is saved (DESIGN.md, Requests → States). */
export const NEW_REQUEST_FILE = "http/requests.http";

export const draftOf = (request: HttpRequest): Draft => ({
  file: request.file,
  name: request.name,
  method: request.method,
  url: request.url,
  headers: request.headers,
  body: request.body ?? "",
  auth: request.auth ?? null,
  line: request.line ?? null,
});

const sameHeaders = (a: ReadonlyArray<HttpHeader>, b: ReadonlyArray<HttpHeader>) =>
  a.length === b.length && a.every((h, i) => h.name === b[i]?.name && h.value === b[i]?.value);

const sameAuth = (a: RequestAuth | null, b: RequestAuth | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Whether the draft differs from the file; a Request not in the file yet always does. */
export const isDirty = (draft: Draft, saved: HttpRequest | undefined): boolean => {
  if (saved === undefined) return true;
  const base = draftOf(saved);

  return (
    draft.name !== base.name ||
    draft.method !== base.method ||
    draft.url !== base.url ||
    draft.body !== base.body ||
    !sameHeaders(draft.headers, base.headers) ||
    !sameAuth(draft.auth, base.auth)
  );
};

/** Header rows the user left blank aren't written or sent. */
const filled = (headers: ReadonlyArray<HttpHeader>) => headers.filter((h) => h.name.trim() !== "");

type Mutable<A> = { -readonly [K in keyof A]: A[K] };

const toAdHoc = (draft: Draft): AdHocRequest => {
  const request: Mutable<AdHocRequest> = {
    method: draft.method,
    url: draft.url,
    headers: filled(draft.headers),
  };

  if (draft.body !== "") request.body = draft.body;

  if (draft.auth !== null) request.auth = draft.auth;

  return request;
};

export const toHttpRequest = (draft: Draft): HttpRequest => {
  const fields: Mutable<ConstructorParameters<typeof HttpRequest>[0]> = {
    file: draft.file,
    name: draft.name.trim(),
    ...toAdHoc(draft),
  };

  if (draft.line !== null) fields.line = draft.line;

  return new HttpRequest(fields);
};

/** The file's Request when nothing changed; otherwise the draft as written, so edits are sent. */
export const targetOf = (draft: Draft, saved: HttpRequest | undefined): RequestTarget =>
  saved !== undefined && !isDirty(draft, saved)
    ? RequestTarget.cases.Saved.make({ ref: { file: saved.file, name: saved.name } })
    : RequestTarget.cases.Inline.make({ request: toAdHoc(draft), name: draft.name });

/** A pasted curl command as a new draft named for its method and path. */
export const draftFromAdHoc = (request: AdHocRequest, taken: ReadonlySet<string>): Draft => {
  const path = request.url.replace(/^[a-z]+:\/\/[^/]+/i, "").split("?")[0] || "/";
  const base = `${request.method} ${path}`;
  let name = base;

  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;

  return {
    file: NEW_REQUEST_FILE,
    name,
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body ?? "",
    auth: request.auth ?? null,
    line: null,
  };
};

export const refString = (ref: RequestRef) => `${ref.file}\u0000${ref.name}`;

/** Whether the Request sets its own `traceparent`; Polaris then adds none. */
export const setsTraceparent = (headers: ReadonlyArray<HttpHeader>) =>
  headers.some((h) => h.name.trim().toLowerCase() === "traceparent");

export type BodyLanguage = "json" | "xml" | "form" | "text";

/** The body's language for colouring, from Content-Type, else its first character. */
export const bodyLanguage = (draft: Pick<Draft, "headers" | "body">): BodyLanguage => {
  const type = draft.headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";

  if (/json/i.test(type)) return "json";

  if (/xml|html/i.test(type)) return "xml";

  if (/x-www-form-urlencoded/i.test(type)) return "form";
  const first = draft.body.trimStart()[0];

  if (first === "{" || first === "[") return "json";

  return first === "<" ? "xml" : "text";
};
