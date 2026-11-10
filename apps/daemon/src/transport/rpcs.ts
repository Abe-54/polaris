/**
 * The RPC group as the Daemon serves it: `DaemonRpcs` behind the Grant gate,
 * plus a server-only middleware that gives every handler the `BlobChannel` of
 * the connection the request arrived on. Clients keep using `DaemonRpcs`; the
 * middlewares have no client side, so the wire is unchanged.
 *
 * Handler modules build their layers from `ServerRpcs`, e.g.
 *
 *   export const ReadFileLive = ServerRpcs.toLayerHandler("files.read", (req) =>
 *     Effect.gen(function* () {
 *       const blobs = yield* BlobChannel
 *       ...
 *     }))
 *
 * and `serve` composes them in one place (see `server.ts`).
 */
import { ExtensionDaemonRpcs } from "@polaris/protocol";
import { RpcMiddleware } from "effect/rpc";
import type { BlobChannel } from "../services.ts";
import type { CurrentLanguageConnection } from "./currentLanguageConnection.ts";
import type { LanguageConnectionLifetime } from "./languageConnectionLifetime.ts";

export class ConnectionBlobs extends RpcMiddleware.Service<
  ConnectionBlobs,
  { provides: BlobChannel | CurrentLanguageConnection | LanguageConnectionLifetime }
>()("polaris/daemon/transport/ConnectionBlobs") {}

/** Every RPC also passes the Grant gate (`extensions/connection.ts`) and the user gate (`userAccess.ts`). */
export const ServerRpcs = ExtensionDaemonRpcs.middleware(ConnectionBlobs);

export type ServerRpcs = typeof ServerRpcs;
