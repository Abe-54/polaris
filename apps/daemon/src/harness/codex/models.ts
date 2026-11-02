/**
 * Codex's Models and reasoning efforts, as `model/list` reports them.
 *
 * Asked of the shared app-server when it is already running; otherwise of a
 * private `codex app-server` on stdio that exits right after, so listing never
 * leaves the detached shared server behind. That costs one short process
 * (~0.5 s) plus whatever Codex fetches to answer; no thread is started.
 */
import { Model } from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";
import type { HarnessError } from "../HarnessDriver.ts";
import * as P from "./protocol.ts";
import { connectAppServer } from "./AppServer.ts";
import {
  codexError,
  codexNotInstalled,
  connectStdio,
  type RpcConnection,
} from "./RpcConnection.ts";

const decodePage = Schema.decodeUnknownOption(P.ModelListResponse);

type CodexModel = (typeof P.ModelListResponse.Type)["data"][number];

export const toModel = (model: CodexModel): Model =>
  new Model({
    id: model.model,
    name: model.displayName,
    description: model.description === "" ? null : model.description,
    efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    defaultEffort: model.defaultReasoningEffort,
    isDefault: model.isDefault,
  });

/** Every page of `model/list`, without the Models Codex hides from its own picker. */
const listPages = (conn: RpcConnection) =>
  Effect.gen(function* () {
    const models: Array<Model> = [];
    let cursor: string | null = null;

    do {
      const params: P.ClientParams["model/list"] = { cursor, includeHidden: false };
      const page = decodePage(yield* conn.request("model/list", params));

      if (Option.isNone(page))
        return yield* codexError("Unexpected model/list response from Codex");
      models.push(...page.value.data.filter((m) => !m.hidden).map(toModel));
      cursor = page.value.nextCursor;
    } while (cursor !== null);

    return models;
  });

export interface ListingConfig {
  readonly codexPath: string | null;
  readonly socketPath: string;
  readonly clientVersion: string;
}

/**
 * Runs `use` on an initialized connection: the shared app-server when it is
 * running, else a private one on stdio that exits with the scope.
 */
export const askAppServer = <A>(
  config: ListingConfig,
  what: string,
  use: (conn: RpcConnection) => Effect.Effect<A, HarnessError>
): Effect.Effect<A, HarnessError> => {
  const { codexPath } = config;

  if (codexPath === null) {
    return Effect.fail(codexNotInstalled());
  }

  return Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* connectAppServer(config.socketPath).pipe(
        Effect.catch(() => connectStdio(codexPath))
      );

      yield* conn.request("initialize", {
        clientInfo: { name: "polaris", title: "Polaris", version: config.clientVersion },
        capabilities: { experimentalApi: false, requestAttestation: false },
      } satisfies P.ClientParams["initialize"]);
      yield* conn.notify("initialized");

      return yield* use(conn);
    })
  ).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(codexError(`Codex took too long to list its ${what}`)),
    })
  );
};

export const listCodexModels = (
  config: ListingConfig
): Effect.Effect<ReadonlyArray<Model>, HarnessError> => askAppServer(config, "Models", listPages);
