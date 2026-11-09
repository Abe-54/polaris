/** The send engine's interface (ADR 0098); the implementation loads on first build (`sends.ts`). */
import { join } from "node:path";
import type {
  HttpMethod,
  RequestRef,
  RequestTarget,
  RequestsError,
  ResolvedVariable,
  Send,
  SendAuthor,
  SendLogPage,
  SendLookup,
} from "@polaris/protocol";
import { Context, Effect, Layer, type Scope, type Stream } from "effect";
import { polarisHome } from "../paths.ts";
import type { OriginApprovalRequired } from "./approvals/service.ts";
import type { PageOptions } from "./sendLog.ts";
import type { PrepareOptions } from "./prepare.ts";

export interface SendInput {
  readonly checkout: string;
  readonly target: RequestTarget;
  readonly environment?: string;
  readonly by: SendAuthor;
}

/** What a pre-send hook sees of an agent's Send; `url` and `path` have secrets masked. */
export interface PendingSend {
  readonly checkout: string;
  readonly ref: RequestRef | null;
  readonly environment?: string;
  readonly method: HttpMethod;
  readonly write: boolean;
  /** The real origin, for matching Origin Approvals; empty when the URL doesn't parse. */
  readonly origin: string;
  readonly url: string;
  readonly path: string;
  readonly variables: ReadonlyArray<ResolvedVariable>;
  /** The checkout-relative file a `< ./file` body comes from, so a gate can see it. */
  readonly bodyFile?: string;
  readonly by: Extract<SendAuthor, { kind: "agent" }>;
}

export type PreSendVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly message: string };

/**
 * Runs before an agent's Send goes out; a user's Send never reaches it. Failing with
 * OriginApprovalRequired holds the Send: nothing is sent or recorded.
 */
export type PreSendHook = (
  send: PendingSend
) => Effect.Effect<PreSendVerdict, RequestsError | OriginApprovalRequired>;

export interface RequestSendsOptions extends PrepareOptions {
  readonly timeoutMs?: number;
}

export class RequestSends extends Context.Service<
  RequestSends,
  {
    readonly send: (
      input: SendInput
    ) => Effect.Effect<Send, RequestsError | OriginApprovalRequired>;
    readonly page: (
      checkout: string,
      options?: PageOptions
    ) => Effect.Effect<SendLogPage, RequestsError>;
    /** The newest 100 Sends now, then again after each Send in this checkout. */
    readonly watch: (checkout: string) => Stream.Stream<ReadonlyArray<Send>, RequestsError>;
    readonly get: (checkout: string, lookup: SendLookup) => Effect.Effect<Send, RequestsError>;
    /** Every registered hook must allow an agent's Send; removed when the scope closes. */
    readonly registerPreSend: (hook: PreSendHook) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("polaris/requests/RequestSends") {
  static layerAt = (filename: string, options: RequestSendsOptions = {}) =>
    Layer.unwrap(
      Effect.promise(() => import("./sends.ts")).pipe(
        Effect.map((m) => m.requestSendsLayerAt(filename, options))
      )
    );
  static readonly layer = Layer.suspend(() =>
    RequestSends.layerAt(join(polarisHome(), "requests.sqlite"))
  );
}
