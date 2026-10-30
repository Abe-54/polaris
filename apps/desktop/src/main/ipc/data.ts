/** Desktop Data requests use the Client's capability-gated, read-only Query path. */
import {
  describeData,
  queryData,
  saveDataSource,
  removeDataSource,
  labelDataSource,
  decideDataApproval,
  type LiveSession,
} from "@polaris/client";
import { Effect, Redacted } from "effect";
import type { RequestInput } from "../../shared/contract.ts";
import { HostDirectory, toIpcError } from "../hosts.ts";

const onHost = <A, E extends { readonly _tag: string; readonly message: string }>(
  hostKey: string,
  use: (session: LiveSession) => Effect.Effect<A, E>
) =>
  HostDirectory.use((dir) => dir.connection(hostKey)).pipe(
    Effect.flatMap((connection) => connection.session),
    Effect.flatMap(use),
    Effect.mapError(toIpcError)
  );

export const dataHandlers = {
  "data.describe": ({ hostKey, ...input }: RequestInput<"data.describe">) =>
    onHost(hostKey, (session) => describeData(session, input)),
  "data.query": ({ hostKey, ...input }: RequestInput<"data.query">) =>
    onHost(hostKey, (session) => queryData(session, input)),
  "data.source.save": ({ hostKey, password, ...input }: RequestInput<"data.source.save">) =>
    onHost(hostKey, (session) =>
      saveDataSource(
        session,
        password === undefined ? input : { ...input, password: Redacted.make(password) }
      )
    ),
  "data.source.remove": ({ hostKey, ...input }: RequestInput<"data.source.remove">) =>
    onHost(hostKey, (session) => removeDataSource(session, input)).pipe(Effect.as(null)),
  "data.source.label": ({ hostKey, ...input }: RequestInput<"data.source.label">) =>
    onHost(hostKey, (session) => labelDataSource(session, input)),
  "data.approval.decide": ({ hostKey, ...input }: RequestInput<"data.approval.decide">) =>
    onHost(hostKey, (session) => decideDataApproval(session, input)).pipe(Effect.as(null)),
};
