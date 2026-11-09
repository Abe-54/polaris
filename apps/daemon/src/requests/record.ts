/** A Send as the Send Log keeps it: resolved secrets masked, sensitive headers hidden, bodies capped. */
import {
  SEND_BODY_CAP_BYTES,
  Send,
  type HttpHeader,
  type HttpMethod,
  type RequestRef,
  type SendAuthor,
  type SendOutcome,
} from "@polaris/protocol";
import { redactText, redactUrls, sensitive } from "../traces/redact.ts";
import { MASK, maskSecrets } from "./format/index.ts";
import type { WireResponse } from "./transmit.ts";

export interface Masker {
  readonly text: (text: string) => string;
  readonly url: (url: string) => string;
  readonly headers: (headers: ReadonlyArray<HttpHeader>) => HttpHeader[];
}

/** Resolved secrets become the mask; then the trace redactor's URL and header-name rules run. */
export const masker = (secrets: ReadonlyArray<string>): Masker => {
  const text = (value: string) => maskSecrets(value, secrets);

  return {
    text,
    url: (url) => redactUrls(text(url)),
    headers: (headers) =>
      headers.map(({ name, value }) => ({
        name,
        value: sensitive(name) && value !== "" ? MASK : text(value),
      })),
  };
};

/** At most `cap` bytes of UTF-8; a split character becomes U+FFFD. */
export const capText = (text: string, cap = SEND_BODY_CAP_BYTES) => {
  const bytes = Buffer.from(text);

  return bytes.byteLength <= cap ? text : bytes.subarray(0, cap).toString("utf8");
};

export interface SendFacts {
  readonly id: string;
  readonly checkout: string;
  readonly ref: RequestRef | null;
  readonly environment?: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: ReadonlyArray<HttpHeader>;
  readonly body?: string;
  readonly response?: WireResponse;
  readonly outcome: SendOutcome;
  readonly errorMessage?: string;
  readonly traceId: string | null;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly by: SendAuthor;
}

const responseFields = (response: WireResponse | undefined, mask: Masker) => {
  if (response === undefined) return { responseHeaders: [], responseTruncated: false };

  return {
    status: response.status,
    statusText: response.statusText,
    responseHeaders: mask.headers(response.headers),
    responseBody: mask.text(response.body),
    ...(response.truncated ? { responseBytes: response.bytes } : undefined),
    responseTruncated: response.truncated,
  };
};

export const sendRecord = (facts: SendFacts, mask: Masker) =>
  new Send({
    id: facts.id,
    checkout: facts.checkout,
    requestRef: facts.ref,
    ...(facts.environment === undefined ? undefined : { environment: facts.environment }),
    method: facts.method,
    url: mask.url(facts.url),
    requestHeaders: mask.headers(facts.headers),
    ...(facts.body === undefined ? undefined : { requestBody: capText(mask.text(facts.body)) }),
    ...responseFields(facts.response, mask),
    durationMs: Math.max(0, facts.durationMs),
    traceId: facts.traceId,
    startedAt: facts.startedAt.toISOString(),
    by: facts.by,
    outcome: facts.outcome,
    ...(facts.errorMessage === undefined
      ? undefined
      : { errorMessage: redactText(mask.text(facts.errorMessage)) }),
  });
