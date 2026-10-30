/** The `git.*` requests and feed in `gitContract.ts`: each forwards the Daemon RPC of that name. */
import type { LiveSession } from "@polaris/client";
import { Effect, Predicate, Stream } from "effect";
import type { GitRequestInputs, GitSubscriptionInputs } from "../../shared/gitContract.ts";
import { HostDirectory, toIpcError } from "../hosts.ts";
import type { Feed } from "./feeds.ts";
import type { Handler } from "./requests.ts";

type Failure = { readonly _tag: string; readonly message: string };

const session = (hostKey: string) =>
  HostDirectory.use((dir) => dir.connection(hostKey)).pipe(Effect.flatMap((c) => c.session));

const onLive = <A, E extends Failure>(
  hostKey: string,
  use: (session: LiveSession) => Effect.Effect<A, E>
) => session(hostKey).pipe(Effect.flatMap(use), Effect.mapError(toIpcError));

const done = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.as(effect, null);

type GitHandlers = { readonly [M in keyof typeof GitRequestInputs]: Handler<M> };

export const gitHandlers: GitHandlers = {
  "git.status": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["git.status"](payload)),
  "git.init": ({ hostKey, ...payload }) => onLive(hostKey, (s) => s.client["git.init"](payload)),
  "git.stage": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["git.stage"](payload)).pipe(done),
  "git.unstage": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["git.unstage"](payload)).pipe(done),
  "git.discard": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["git.discard"](payload)).pipe(done),
  "git.log": ({ hostKey, ...payload }) => onLive(hostKey, (s) => s.client["git.log"](payload)),
};

type GitOpeners = {
  readonly [K in keyof typeof GitSubscriptionInputs]: (
    input: (typeof GitSubscriptionInputs)[K]["Type"]
  ) => Feed<K>;
};

export const gitOpeners: GitOpeners = {
  "git.commit": ({ hostKey, ...payload }) =>
    Stream.unwrap(Effect.map(session(hostKey), (s) => s.client["git.commit"](payload))).pipe(
      Stream.mapError(toIpcError)
    ),
  "git.watch": ({ hostKey, ...payload }) =>
    Stream.unwrap(Effect.map(session(hostKey), (s) => s.client["git.watch"](payload))).pipe(
      Stream.mapError(toIpcError)
    ),
  "git.sync": ({ hostKey, ...payload }) =>
    Stream.unwrap(Effect.map(session(hostKey), (s) => s.client["git.sync"](payload))).pipe(
      Stream.mapError(toIpcError)
    ),
  /** A refusal's code is its reason (`needs-sign-in`…), so the Commit box can say what to do. */
  "commit.suggestMessage": ({ hostKey, ...payload }) =>
    Stream.unwrap(
      Effect.map(session(hostKey), (s) => s.client["commit.suggestMessage"](payload))
    ).pipe(
      Stream.mapError((error) =>
        Predicate.isTagged(error, "CommitMessageError")
          ? { code: error.reason, message: error.message }
          : toIpcError(error)
      )
    ),
};
