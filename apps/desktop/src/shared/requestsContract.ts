/** Requests over IPC (ADR 0098): the protocol's payloads plus the Host, and its answers unchanged. */
import {
  FormatCurl,
  GetSend,
  PageSendLog,
  ParseCurl,
  ResolveRequestVariables,
  SaveRequest,
  SendRequest,
  WatchRequests,
  WatchSendLog,
  type AdHocRequest,
  type RequestFile,
  type RequestsSnapshot,
  type ResolvedVariable,
  type Send,
  type SendLogPage,
} from "@polaris/protocol";
import { Schema } from "effect";

const OnHost = { hostKey: Schema.String.check(Schema.isMinLength(1)) };

export const RequestsRequestInputs = {
  "requests.save": Schema.Struct({ ...OnHost, ...SaveRequest.payloadSchema.fields }),
  "requests.send": Schema.Struct({ ...OnHost, ...SendRequest.payloadSchema.fields }),
  "requests.variables": Schema.Struct({
    ...OnHost,
    ...ResolveRequestVariables.payloadSchema.fields,
  }),
  "requests.sendLog.page": Schema.Struct({ ...OnHost, ...PageSendLog.payloadSchema.fields }),
  "requests.send.get": Schema.Struct({ ...OnHost, ...GetSend.payloadSchema.fields }),
  "requests.curl.parse": Schema.Struct({ ...OnHost, ...ParseCurl.payloadSchema.fields }),
  "requests.curl.format": Schema.Struct({ ...OnHost, ...FormatCurl.payloadSchema.fields }),
} as const;

export interface RequestsRequestOutputs {
  /** The saved file, re-read. */
  readonly "requests.save": RequestFile;
  /** A user's send is never gated. */
  readonly "requests.send": Send;
  /** Secrets arrive masked, without a value. */
  readonly "requests.variables": ReadonlyArray<ResolvedVariable>;
  readonly "requests.sendLog.page": SendLogPage;
  readonly "requests.send.get": Send;
  readonly "requests.curl.parse": AdHocRequest;
  readonly "requests.curl.format": string;
}

export const RequestsSubscriptionInputs = {
  "requests.watch": Schema.Struct({ ...OnHost, ...WatchRequests.payloadSchema.fields }),
  "requests.sendLog.watch": Schema.Struct({ ...OnHost, ...WatchSendLog.payloadSchema.fields }),
} as const;

export interface RequestsSubscriptionItems {
  /** Each snapshot replaces the last. */
  readonly "requests.watch": RequestsSnapshot;
  /** The newest sends, up to 100; each list replaces the last. */
  readonly "requests.sendLog.watch": ReadonlyArray<Send>;
}
