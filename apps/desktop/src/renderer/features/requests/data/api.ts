/**
 * Requests' boundary (ADR 0098): the `requests.*` calls this view makes, typed by the protocol
 * alone. `liveRequestsApi` goes over IPC (shared/requestsContract.ts); fixtures swap in only in
 * previews and tests.
 */
import type {
  AdHocRequest,
  HttpRequest,
  RequestFile,
  RequestsSnapshot,
  RequestTarget,
  ResolvedVariable,
  Send,
} from "@polaris/protocol";
import type { IpcError, Result } from "../../../../shared/api.ts";
import { polaris } from "../../bridge.ts";
import type { RequestsSessionKey } from "../model/session.ts";

export interface Watch<A> {
  /** The latest snapshot; each one replaces the last. */
  readonly next: (snapshot: A) => void;
  readonly end?: (error: IpcError | null) => void;
}

export interface SendInput {
  readonly target: RequestTarget;
  readonly environment: string | null;
}

export interface RequestsApi {
  /** The checkout's `.http` files and environments; the returned function stops watching. */
  readonly watch: (at: RequestsSessionKey, on: Watch<RequestsSnapshot>) => () => void;
  /** Writes a Request to its file; `previousName` renames the one saved under it. */
  readonly save: (
    at: RequestsSessionKey,
    request: HttpRequest,
    previousName: string | null
  ) => Promise<Result<RequestFile>>;
  readonly send: (at: RequestsSessionKey, input: SendInput) => Promise<Result<Send>>;
  readonly variables: (
    at: RequestsSessionKey,
    input: SendInput
  ) => Promise<Result<ReadonlyArray<ResolvedVariable>>>;
  readonly parseCurl: (at: RequestsSessionKey, text: string) => Promise<Result<AdHocRequest>>;
  readonly formatCurl: (at: RequestsSessionKey, input: SendInput) => Promise<Result<string>>;
}

const session = (at: RequestsSessionKey) => ({ hostKey: at.hostKey, sessionId: at.sessionId });

const withEnvironment = (at: RequestsSessionKey, { target, environment }: SendInput) =>
  environment === null ? { ...session(at), target } : { ...session(at), target, environment };

export const liveRequestsApi: RequestsApi = {
  watch: (at, on) =>
    polaris().subscribe("requests.watch", session(at), {
      items: (items) => {
        const last = items.at(-1);

        if (last !== undefined) on.next(last);
      },
      end: (error) => on.end?.(error),
    }),
  save: (at, request, previousName) =>
    polaris().request(
      "requests.save",
      previousName === null || previousName === request.name
        ? { ...session(at), request }
        : { ...session(at), request, previousName }
    ),
  send: (at, input) => polaris().request("requests.send", withEnvironment(at, input)),
  variables: (at, input) => polaris().request("requests.variables", withEnvironment(at, input)),
  parseCurl: (at, text) => polaris().request("requests.curl.parse", { ...session(at), text }),
  formatCurl: (at, input) => polaris().request("requests.curl.format", withEnvironment(at, input)),
};
