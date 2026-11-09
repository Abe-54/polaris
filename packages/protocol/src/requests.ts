/** Requests, Sends and the Send Log (ADR 0098, ENG-809). Secret values never reach a Client. */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ScrubbedText } from "./dataValues.ts";
import { Unsupported } from "./errors.ts";
import { SessionId, Timestamp, TurnId } from "./ids.ts";
import { TraceId } from "./traces.ts";

export const REQUESTS_CAPABILITY = "requests";

/** A Send's response body is cut at 1 MB; `responseTruncated` says so. */
export const SEND_BODY_CAP_BYTES = 1024 * 1024;

const Name = Schema.String.check(Schema.isMinLength(1));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Writes are every method but GET, HEAD and OPTIONS (`isWriteMethod`). */
export const HttpMethod = Schema.Literals([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export type HttpMethod = typeof HttpMethod.Type;

export const isWriteMethod = (method: HttpMethod) =>
  method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

export const HttpHeader = Schema.Struct({ name: Name, value: Schema.String });

export type HttpHeader = typeof HttpHeader.Type;

/** Values keep their `{{variables}}` unresolved, as written in the file. */
export const RequestAuth = Schema.TaggedUnion({
  Bearer: { token: Schema.String },
  Basic: { user: Schema.String, password: Schema.String },
});

export type RequestAuth = typeof RequestAuth.Type;

/** `file` is checkout-relative; `name` is unique within it (`### name` or `# @name`). */
export const RequestRef = Schema.Struct({ file: Name, name: Name });

export type RequestRef = typeof RequestRef.Type;

/** A saved Request as written: `url`, headers, body and auth keep their `{{variables}}`. */
export class HttpRequest extends Schema.Class<HttpRequest>("HttpRequest")({
  ...RequestRef.fields,
  method: HttpMethod,
  url: Name,
  headers: Schema.Array(HttpHeader),
  body: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(RequestAuth),
  /** 1-based line of the Request's first line in its file, for "Open in Edit". */
  line: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
}) {}

/** An ad-hoc Request (a pasted curl, an agent's unsaved Send): no file, maybe no name. */
export const AdHocRequest = Schema.Struct({
  method: HttpMethod,
  url: Name,
  headers: Schema.Array(HttpHeader),
  body: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(RequestAuth),
});

export type AdHocRequest = typeof AdHocRequest.Type;

export const RequestParseError = Schema.Struct({
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  message: Schema.String,
});

/** One `.http` or `.rest` file in the checkout that isn't gitignored. */
export class RequestFile extends Schema.Class<RequestFile>("RequestFile")({
  path: Name,
  requests: Schema.Array(HttpRequest),
  parseErrors: Schema.Array(RequestParseError),
}) {}

/** What the Requests view lists: the files and the environments of `http-client.env.json`. */
export const RequestsSnapshot = Schema.Struct({
  files: Schema.Array(RequestFile),
  environments: Schema.Array(Name),
});

export type RequestsSnapshot = typeof RequestsSnapshot.Type;

/** An origin's locality: Local needs no Origin Approval for an agent's Send. */
export const OriginLocality = Schema.Literals(["local", "remote"]);

/**
 * `value` is present only when the variable isn't secret; `origin` only for a URL-valued one.
 * `file` is the checkout-relative `.env` file a `dotenv` value came from.
 */
export const ResolvedVariable = Schema.Struct({
  name: Name,
  source: Schema.Literals(["env", "dotenv", "file"]),
  masked: Schema.Boolean,
  value: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(OriginLocality),
  file: Schema.optionalKey(Name),
}).check(Schema.makeFilter((variable) => !variable.masked || variable.value === undefined));

export type ResolvedVariable = typeof ResolvedVariable.Type;

/** Who sent: an agent in a Turn, or the user (from an Agent Session's Requests view). */
export const SendAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent"), sessionId: SessionId, turn: TurnId }),
  Schema.Struct({
    kind: Schema.Literal("user"),
    sessionId: Schema.optionalKey(SessionId),
    turn: Schema.optionalKey(TurnId),
  }),
]);

export type SendAuthor = typeof SendAuthor.Type;

/**
 * `refused`: connection refused; `denied`: an Origin Approval was denied; `http-error`: a 4xx/5xx.
 * `failed` is any other transport failure (DNS, TLS, a bad URL).
 */
export const SendOutcome = Schema.Literals([
  "ok",
  "http-error",
  "refused",
  "timeout",
  "denied",
  "failed",
]);

export type SendOutcome = typeof SendOutcome.Type;

/** One Send, as recorded in the Send Log. URL and request headers have secrets masked. */
export class Send extends Schema.Class<Send>("Send")({
  id: Name,
  checkout: Schema.String,
  /** Null for an ad-hoc Send. */
  requestRef: Schema.NullOr(RequestRef),
  environment: Schema.optionalKey(Name),
  method: HttpMethod,
  url: Schema.String,
  requestHeaders: Schema.Array(HttpHeader),
  requestBody: Schema.optionalKey(Schema.String),
  /** Absent when no response arrived (refused, timeout, denied, failed). */
  status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  statusText: Schema.optionalKey(Schema.String),
  responseHeaders: Schema.Array(HttpHeader),
  responseBody: Schema.optionalKey(Schema.String),
  /** The whole body's size, when it is larger than what `responseBody` holds. */
  responseBytes: Schema.optionalKey(Count),
  responseTruncated: Schema.Boolean,
  durationMs: Milliseconds,
  /** The Trace whose root client Span Polaris recorded; null when nothing was sent (`denied`). */
  traceId: Schema.NullOr(TraceId),
  startedAt: Timestamp,
  by: SendAuthor,
  outcome: SendOutcome,
  errorMessage: Schema.optionalKey(ScrubbedText),
}) {}

export const RequestsErrorCode = Schema.Literals([
  "E-INPUT",
  "E-REQUEST-NOT-FOUND",
  "E-REQUEST-PARSE",
  "E-REQUEST-CONFLICT",
  "E-ENVIRONMENT-NOT-FOUND",
  "E-VARIABLE-UNRESOLVED",
  "E-SEND-NOT-FOUND",
  "E-CURL-PARSE",
  "E-REQUESTS-UNAVAILABLE",
]);

export class RequestsError extends Schema.TaggedError<RequestsError>()("RequestsError", {
  code: RequestsErrorCode,
  message: ScrubbedText,
  fix: ScrubbedText,
}) {}

const Errors = Schema.Union([RequestsError, Unsupported]);

/** Every Requests RPC acts on the checkout of this Agent Session. */
const OnSession = { sessionId: SessionId };

/** What to send or format: a saved Request by ref, or an inline one. */
export const RequestTarget = Schema.TaggedUnion({
  Saved: { ref: RequestRef },
  Inline: { request: AdHocRequest, name: Schema.optionalKey(Name) },
});

export type RequestTarget = typeof RequestTarget.Type;

const WithEnvironment = { environment: Schema.optionalKey(Name) };

export const WatchRequests = Rpc.make("requests.watch", {
  payload: OnSession,
  success: RequestsSnapshot,
  error: Errors,
  stream: true,
});

/**
 * Writes one Request back over `previousName` (or `request.name`) in `request.file`, or appends
 * it; a missing file such as `http/requests.http` is created.
 */
export const SaveRequest = Rpc.make("requests.save", {
  payload: { ...OnSession, request: HttpRequest, previousName: Schema.optionalKey(Name) },
  success: RequestFile,
  error: Errors,
});

/** The user's Send: never gated by an Origin Approval. Agents send through Polaris's tools. */
export const SendRequest = Rpc.make("requests.send", {
  payload: { ...OnSession, target: RequestTarget, ...WithEnvironment },
  success: Send,
  error: Errors,
});

/** The variables a target uses, resolved in an environment, for the VARIABLES footer. */
export const ResolveRequestVariables = Rpc.make("requests.variables", {
  payload: { ...OnSession, target: RequestTarget, ...WithEnvironment },
  success: Schema.Array(ResolvedVariable),
  error: Errors,
});

/** Newest first, exclusive of `before`; `filter` matches method, URL, status and author. */
export const SendLogPage = Schema.Struct({
  sends: Schema.Array(Send).check(Schema.isMaxLength(100)),
  next: Schema.NullOr(Name),
});

export type SendLogPage = typeof SendLogPage.Type;

export const PageSendLog = Rpc.make("requests.sendLog.page", {
  payload: {
    ...OnSession,
    before: Schema.optionalKey(Name),
    filter: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  },
  success: SendLogPage,
  error: Errors,
});

/** Snapshots of the checkout's latest 100 Sends, newest first, on every new Send. */
export const WatchSendLog = Rpc.make("requests.sendLog.watch", {
  payload: OnSession,
  success: Schema.Array(Send).check(Schema.isMaxLength(100)),
  error: Errors,
  stream: true,
});

/** By Send id, or by the Trace it started ("Resend in Requests"). */
export const SendLookup = Schema.TaggedUnion({
  ById: { id: Name },
  ByTrace: { traceId: TraceId },
});

export type SendLookup = typeof SendLookup.Type;

export const GetSend = Rpc.make("requests.send.get", {
  payload: { ...OnSession, lookup: SendLookup },
  success: Send,
  error: Errors,
});

export const ParseCurl = Rpc.make("requests.curl.parse", {
  payload: { ...OnSession, text: Name.check(Schema.isMaxLength(SEND_BODY_CAP_BYTES)) },
  success: AdHocRequest,
  error: Errors,
});

/** A curl command with variables resolved in `environment` and secrets masked. */
export const FormatCurl = Rpc.make("requests.curl.format", {
  payload: { ...OnSession, target: RequestTarget, ...WithEnvironment },
  success: Schema.String,
  error: Errors,
});

export class RequestsRpcs extends RpcGroup.make(
  WatchRequests,
  SaveRequest,
  SendRequest,
  ResolveRequestVariables,
  PageSendLog,
  WatchSendLog,
  GetSend,
  ParseCurl,
  FormatCurl
) {}
