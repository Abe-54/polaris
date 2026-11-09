/** One HTTP exchange from the Daemon: a deadline, no redirects followed, the body cut at the cap. */
import { SEND_BODY_CAP_BYTES, type HttpHeader, type SendOutcome } from "@polaris/protocol";
import { Match, Option, Schema } from "effect";

export const SEND_TIMEOUT_MS = 30_000;

export interface WireRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: ReadonlyArray<HttpHeader>;
  readonly body?: string;
}

export interface WireResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<HttpHeader>;
  readonly body: string;
  /** The whole body's size; more than the cap when `truncated`. */
  readonly bytes: number;
  readonly truncated: boolean;
}

export type Transmission =
  | { readonly outcome: "ok" | "http-error"; readonly response: WireResponse }
  | {
      readonly outcome: Exclude<SendOutcome, "ok" | "http-error" | "denied">;
      readonly error: string;
      /** Present when the headers arrived but the body did not finish in time. */
      readonly response?: WireResponse;
    };

/** What a fetch rejection carries; anything that doesn't decode is a plain failure. */
const FetchFailure = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  message: Schema.optionalKey(Schema.String),
});

type FetchFailure = typeof FetchFailure.Type;

const decodeFailure = Schema.decodeUnknownOption(FetchFailure);

/** Connection refused, the deadline, or anything else (DNS, TLS, a bad URL). */
export const failureOutcome = (failure: FetchFailure): "refused" | "timeout" | "failed" => {
  if (failure.name === "TimeoutError") return "timeout";

  return Match.value(failure.code).pipe(
    Match.whenOr("ECONNREFUSED", "ConnectionRefused", () => "refused" as const),
    Match.whenOr("ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", () => "timeout" as const),
    Match.orElse(() => "failed" as const)
  );
};

const failed = (failure: FetchFailure, timeoutMs: number) => {
  const outcome = failureOutcome(failure);

  const error = Match.value(outcome).pipe(
    Match.when("timeout", () => `No response within ${timeoutMs / 1000} s`),
    Match.when("refused", () => "Connection refused"),
    Match.orElse(() => failure.message ?? "The request failed")
  );

  return { outcome, error };
};

const headerList = (headers: Headers): HttpHeader[] => {
  const list: HttpHeader[] = [];

  headers.forEach((value, name) => list.push({ name, value }));

  return list;
};

interface BodyRead {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/** Keeps the first `cap` bytes and counts the rest, so a large body never sits in memory. */
const readCapped = async (
  body: ReadableStream<Uint8Array> | null,
  cap: number,
  kept: { chunks: Uint8Array[]; bytes: number }
): Promise<BodyRead> => {
  if (body !== null)
    for await (const chunk of body) {
      const room = cap - Math.min(cap, kept.bytes);

      if (room > 0) kept.chunks.push(room >= chunk.byteLength ? chunk : chunk.subarray(0, room));
      kept.bytes += chunk.byteLength;
    }

  return decoded(kept, cap);
};

const decoded = (kept: { chunks: Uint8Array[]; bytes: number }, cap: number): BodyRead => ({
  text: new TextDecoder().decode(Buffer.concat(kept.chunks)),
  bytes: kept.bytes,
  truncated: kept.bytes > cap,
});

const responseOf = (response: Response, body: BodyRead): WireResponse => ({
  status: response.status,
  statusText: response.statusText,
  headers: headerList(response.headers),
  body: body.text,
  bytes: body.bytes,
  truncated: body.truncated,
});

export interface TransmitOptions {
  readonly timeoutMs?: number;
  readonly cap?: number;
}

/** Never throws: every failure becomes an outcome. 3xx is returned as is, not followed. */
export const transmit = async (
  request: WireRequest,
  options: TransmitOptions = {}
): Promise<Transmission> => {
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  const cap = options.cap ?? SEND_BODY_CAP_BYTES;
  let response: Response;

  // Bun's fetch also reads file: and data: URLs; a Send only ever goes over HTTP.
  if (!/^https?:\/\//i.test(request.url))
    return { outcome: "failed", error: "Only http:// and https:// URLs can be sent" };

  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers.map(({ name, value }): [string, string] => [name, value]),
      ...(request.body === undefined ? undefined : { body: request.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return failed(
      Option.getOrElse(decodeFailure(error), () => ({})),
      timeoutMs
    );
  }

  const chunks: Uint8Array[] = [];
  const kept = { chunks, bytes: 0 };

  try {
    const body = await readCapped(response.body, cap, kept);

    return {
      outcome: response.status >= 400 ? "http-error" : "ok",
      response: responseOf(response, body),
    };
  } catch (error) {
    return {
      ...failed(
        Option.getOrElse(decodeFailure(error), () => ({})),
        timeoutMs
      ),
      response: responseOf(response, decoded(kept, cap)),
    };
  }
};
