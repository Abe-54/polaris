/**
 * The Client runtime in the main process: one Effect runtime holding
 * `@polaris/client`'s HostRegistry, the local Host plus the remote Hosts from
 * the settings, and the Host list (with Connection States) the renderers see.
 */
import { hostname } from "node:os";
import {
  type ClientIdentity,
  type ConnectionStatus,
  type HostConnection,
  type HostConnectionOptions,
  type LiveSession,
  HostConnector,
  HostRegistry,
  ConstellationRelay,
  HostTarget,
  reportPresence,
} from "@polaris/client";
import { Capability, type UserPresence } from "@polaris/protocol";
import {
  Context,
  Effect,
  Equal,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import type { ConnectionStatusView, HostKind, HostView, IpcError } from "../shared/api.ts";
import type { GitHub } from "./github/index.ts";
import type { LocalDaemon } from "./local/index.ts";
import type { Machines } from "./machines/service.ts";
import type { RemoteHostSetting } from "./settings.ts";
import { clientCopy } from "../shared/clientCopy.ts";

export const LOCAL_HOST_KEY = "local";

/** The local Host by its key; any other socket target is an extra Host's. */
export const hostKind = (entry: Pick<HostEntry, "key" | "target">): HostKind =>
  HostTarget.$match(entry.target, {
    Local: (): HostKind => (entry.key === LOCAL_HOST_KEY ? "local" : "socket"),
    Ssh: (): HostKind => "ssh",
    Wsl: (): HostKind => "wsl",
  });

export class UnknownHost extends Error {
  readonly _tag = "UnknownHost";

  constructor(readonly key: string) {
    super(`no Host "${key}"`);
  }
}

/** A Host as the settings describe it, before it connects. */
export interface HostEntry {
  readonly key: string;
  readonly label: string;
  readonly colour: string | null;
  readonly alias: string | null;
  readonly proofHarness: boolean;
  readonly target: HostTarget;
  /** The remote command's argv; null for the default (`~/.polaris/bin/current/polaris bridge`). */
  readonly remoteCommand: ReadonlyArray<string> | null;
  /** Screenshots and tests only: report this round trip instead of the measured one. */
  readonly simulatedLatencyMs: number | null;
}

export const statusView = (status: ConnectionStatus): ConnectionStatusView => ({
  state: status.state,
  failure:
    status.failure === null
      ? null
      : {
          kind: status.failure.kind,
          reason: status.failure.reason,
          detail: status.failure.detail,
          older: status.failure.older,
        },
  attempt: status.attempt,
  since: status.since,
  nextAttemptAt: status.nextAttemptAt,
  host: status.host,
  capabilities: status.capabilities,
  epoch: status.epoch,
  latencyMs: status.latencyMs,
  lastSeenAt: status.lastSeenAt,
});

interface LanguageLifetimeView {
  languageConnectionEpoch?: number;
}

export const hostView = (
  entry: HostEntry,
  status: ConnectionStatus,
  languageConnectionEpoch: number | null = null
): HostView => {
  const lifetime: LanguageLifetimeView = {};

  if (languageConnectionEpoch !== null) lifetime.languageConnectionEpoch = languageConnectionEpoch;

  return {
    key: entry.key,
    label: entry.label,
    colour: entry.colour,
    alias: entry.alias,
    kind: hostKind(entry),
    proofHarness: entry.proofHarness,
    status: {
      ...statusView(status),
      ...lifetime,
      latencyMs:
        entry.simulatedLatencyMs !== null && status.state === "connected"
          ? entry.simulatedLatencyMs
          : status.latencyMs,
    },
  };
};

/** A Host on a local socket under its own name: screenshots and tests only (`POLARIS_DESKTOP_EXTRA_HOSTS`). */
export const ExtraHost = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  label: Schema.String,
  socket: Schema.String,
  /** Pretend the link has this round trip ("Slow link" in screenshots). */
  latencyMs: Schema.optionalKey(Schema.Number),
});

export type ExtraHost = typeof ExtraHost.Type;

const decodeExtras = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ExtraHost)));

export const extraHosts = (json: string | undefined): ReadonlyArray<ExtraHost> =>
  json === undefined || json === "" ? [] : Option.getOrElse(decodeExtras(json), () => []);

export interface HostEntriesInput {
  /** Null while the local Host is switched off on this machine. */
  readonly local: LocalDaemon | null;
  readonly remotes: ReadonlyArray<RemoteHostSetting>;
  readonly extras?: ReadonlyArray<ExtraHost>;
  /** The local Host's name; `clientCopy().localHost` ("This Mac") by default. */
  readonly localLabel?: string;
}

/** The local Host first, then the remote Hosts in settings order; duplicate aliases dropped. */
export const hostEntries = ({
  local,
  remotes,
  extras = [],
  localLabel = clientCopy().localHost,
}: HostEntriesInput): ReadonlyArray<HostEntry> => {
  const seen = new Set<string>([LOCAL_HOST_KEY]);

  const entries: Array<HostEntry> = local === null ? [] : [localEntry(local, localLabel)];

  for (const extra of extras) {
    if (seen.has(extra.key)) continue;
    seen.add(extra.key);
    entries.push({
      key: extra.key,
      label: extra.label,
      colour: null,
      alias: null,
      proofHarness: false,
      target: HostTarget.Local({ socketPath: extra.socket }),
      remoteCommand: null,
      simulatedLatencyMs: extra.latencyMs ?? null,
    });
  }

  for (const remote of remotes) {
    if (seen.has(remote.alias)) continue;
    seen.add(remote.alias);
    entries.push(remoteEntry(remote));
  }

  return entries;
};

export const localEntry = (local: LocalDaemon, label = clientCopy().localHost): HostEntry => ({
  key: LOCAL_HOST_KEY,
  label,
  colour: null,
  alias: null,
  proofHarness: local.benchHarness,
  target: HostTarget.Local(
    local.installedHome === null
      ? { socketPath: local.socketPath }
      : { socketPath: local.socketPath, installedHome: local.installedHome }
  ),
  remoteCommand: null,
  simulatedLatencyMs: null,
});

/** Splits a remote command line on whitespace; the remote shell parses it again anyway. */
export const remoteCommandArgv = (line: string | undefined): ReadonlyArray<string> | null => {
  const argv = (line ?? "")
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "");

  return argv.length === 0 ? null : argv;
};

/** An ssh Host's target; a Windows one also names the DefaultShell its relay speaks. */
const sshTarget = (remote: RemoteHostSetting) => {
  const ssh = { alias: remote.alias, forwardAgent: remote.forwardAgent ?? false };

  return remote.windowsShell === undefined
    ? HostTarget.Ssh(ssh)
    : HostTarget.Ssh({ ...ssh, windowsShell: remote.windowsShell });
};

export const remoteEntry = (remote: RemoteHostSetting): HostEntry => ({
  key: remote.alias,
  label: remote.label ?? remote.alias,
  colour: remote.colour ?? null,
  alias: remote.alias,
  proofHarness: false,
  target: remote.kind === "wsl" ? HostTarget.Wsl({ distro: remote.alias }) : sshTarget(remote),
  remoteCommand: remoteCommandArgv(remote.remoteCommand),
  simulatedLatencyMs: null,
});

export const clientIdentity = (version: string): ClientIdentity => ({
  name: "Polaris",
  version,
  deviceLabel: hostname().replace(/\.local$/, ""),
  capabilities: Capability.literals,
});

const replaceView = (views: ReadonlyArray<HostView>, view: HostView) => {
  const at = views.findIndex((v) => v.key === view.key);

  if (at === -1) return [...views, view];

  return views.map((v, i) => (i === at ? view : v));
};

export interface HostDirectoryInput {
  readonly ssh?: HostConnectionOptions["ssh"];
  readonly entries: ReadonlyArray<HostEntry>;
  readonly identity: ClientIdentity;
  /** Supplied by Main's explicit private credential store, never renderer Settings. */
  readonly clientIdentity?: HostConnectionOptions["clientIdentity"];
  /** Same Main allocator used by identity IPC; public epochs are freshness, never credentials. */
  readonly languageEpoch?: (hostKey: string, session: LiveSession) => number | null;
  readonly invalidateLanguage?: (hostKey: string) => void;
  /** Whether the user is at this computer; told to every Host that asks (ENG-495). */
  readonly presence?: Stream.Stream<UserPresence>;
  /** Serves the Host's Browser streams on each live session (`browserCdp/`, ENG-616). */
  readonly browserHost?: (
    hostKey: string,
    sessions: Stream.Stream<LiveSession | null>
  ) => Effect.Effect<void>;
}

/** The Hosts this app connects to, and their views for the renderers. */
export class HostDirectory extends Context.Service<
  HostDirectory,
  {
    /** The Host list, updated on every Connection State change. */
    readonly views: SubscriptionRef.SubscriptionRef<ReadonlyArray<HostView>>;
    readonly entry: (key: string) => HostEntry | undefined;
    readonly connection: (key: string) => Effect.Effect<HostConnection, UnknownHost>;
    /** Adds a Host, or replaces the one with the same key (reconnecting it). */
    readonly add: (entry: HostEntry) => Effect.Effect<void>;
    readonly remove: (key: string) => Effect.Effect<void>;
  }
>()("polaris/desktop/HostDirectory") {
  static readonly layer = ({
    entries,
    identity,
    ssh,
    clientIdentity,
    languageEpoch,
    invalidateLanguage,
    presence,
    browserHost,
  }: HostDirectoryInput) =>
    Layer.effect(
      HostDirectory,
      Effect.gen(function* () {
        const registry = yield* HostRegistry;
        yield* Layer.build(ConstellationRelay.layer);
        const views = yield* SubscriptionRef.make<ReadonlyArray<HostView>>([]);
        const byKey = new Map<string, HostEntry>();
        const trackers = new Map<string, Fiber.Fiber<void>>();
        const scope = yield* Effect.scope;

        const stop = (key: string) =>
          Effect.gen(function* () {
            invalidateLanguage?.(key);
            const tracker = trackers.get(key);
            trackers.delete(key);

            if (tracker !== undefined) yield* Fiber.interrupt(tracker);
            yield* registry.remove(key);
          });

        const remove = (key: string) =>
          Effect.gen(function* () {
            byKey.delete(key);
            yield* stop(key);
            yield* SubscriptionRef.update(views, (current) => current.filter((v) => v.key !== key));
          });

        const sameTransport = (a: HostEntry, b: HostEntry) =>
          Equal.equals(a.target, b.target) &&
          (a.remoteCommand ?? []).join(" ") === (b.remoteCommand ?? []).join(" ");

        // A replaced Host keeps its place in the list; a new name alone doesn't reconnect it.
        const add = (entry: HostEntry) =>
          Effect.gen(function* () {
            const previous = byKey.get(entry.key);

            if (
              previous !== undefined &&
              trackers.has(entry.key) &&
              sameTransport(previous, entry)
            ) {
              byKey.set(entry.key, entry);
              yield* SubscriptionRef.update(views, (current) =>
                current.map((v) =>
                  v.key === entry.key ? { ...v, label: entry.label, colour: entry.colour } : v
                )
              );

              return;
            }

            yield* stop(entry.key);
            byKey.set(entry.key, entry);

            let options: HostConnectionOptions = {
              key: entry.key,
              name: entry.label,
              target: entry.target,
              identity,
              ssh:
                entry.remoteCommand === null
                  ? { ...ssh }
                  : { ...ssh, remoteCommand: entry.remoteCommand },
            };

            if (clientIdentity !== undefined) options = { ...options, clientIdentity };

            const connection = yield* registry.add(options);

            const changes =
              connection.sessionChanges === undefined
                ? connection.changes.pipe(Stream.map(() => undefined))
                : Stream.merge(
                    connection.changes.pipe(Stream.map(() => undefined)),
                    connection.sessionChanges.pipe(Stream.map(() => undefined))
                  );

            const report =
              presence === undefined || connection.sessionChanges === undefined
                ? Effect.void
                : reportPresence(connection.sessionChanges, presence);

            const browsers =
              browserHost === undefined || connection.sessionChanges === undefined
                ? Effect.void
                : browserHost(entry.key, connection.sessionChanges);

            const track = changes.pipe(
              Stream.runForEach(() =>
                Effect.gen(function* () {
                  const status = yield* SubscriptionRef.get(connection.status);

                  const epoch = yield* connection.session.pipe(
                    Effect.match({
                      onSuccess: (session) => languageEpoch?.(entry.key, session) ?? null,
                      onFailure: () => null,
                    })
                  );

                  yield* SubscriptionRef.update(views, (current) =>
                    replaceView(current, hostView(byKey.get(entry.key) ?? entry, status, epoch))
                  );
                })
              )
            );

            const tracker = yield* Effect.all([track, report, browsers], {
              concurrency: "unbounded",
              discard: true,
            }).pipe(Effect.forkIn(scope));

            trackers.set(entry.key, tracker);
          });

        for (const entry of entries) yield* add(entry);

        const connection = (key: string) =>
          Effect.flatMap(
            registry.get(key),
            Option.match({
              onNone: () => Effect.fail(new UnknownHost(key)),
              onSome: (found) => Effect.succeed(found),
            })
          );

        return HostDirectory.of({ views, entry: (key) => byKey.get(key), connection, add, remove });
      })
    ).pipe(Layer.provide(HostRegistry.layer), Layer.provide(HostConnector.layer));
}

/** The services the IPC handlers run on. */
export type ClientServices = HostDirectory | Machines | GitHub;

export type ClientRuntime = ManagedRuntime.ManagedRuntime<ClientServices, never>;

/** Starts connecting to every Host; the runtime owns every connection until disposed. */
export const startClientRuntime = (
  input: HostDirectoryInput,
  machines: Layer.Layer<Machines, never, HostDirectory>,
  github: Layer.Layer<GitHub>
): ClientRuntime =>
  ManagedRuntime.make(
    Layer.mergeAll(Layer.provideMerge(machines, HostDirectory.layer(input)), github)
  );

/** Every failure crossing IPC becomes its tag and message; a refusal's message is its `reason`. */
export const toIpcError = (error: {
  readonly _tag: string;
  readonly message: string;
  readonly reason?: unknown;
}): IpcError => ({
  code: error._tag,
  message: Predicate.isString(error.reason) && error.message === "" ? error.reason : error.message,
});

/** Waits until the Host with `key` is first Connected. */
export const whenConnected = (key: string) =>
  HostDirectory.use((dir) =>
    SubscriptionRef.changes(dir.views).pipe(
      Stream.filter((views) => views.some((v) => v.key === key && v.status.state === "connected")),
      Stream.runHead,
      Effect.asVoid
    )
  );
