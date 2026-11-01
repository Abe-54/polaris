import { Profiles } from "./service.ts";

export { Profiles } from "./service.ts";

import { InspectorTargets } from "../attach/registry.ts";
import { captureAttached } from "../attach/capture.ts";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { Effect, Exit, Layer, Option, PubSub, Stream } from "effect";
import {
  Profile,
  ProfileError,
  ProfileId,
  Timestamp,
  type SessionId,
  type TraceTurn,
  type TurnId,
} from "@polaris/protocol";
import { EventStore } from "../../store/EventStore.ts";
import { WorkspaceTrust, ApprovalPolicy } from "../../services.ts";

import { ownProcessGroup } from "../../platform/processes.ts";
import { repositoryEnv } from "../../service/childEnv.ts";
import { executableOf } from "../../platform/executable.ts";
import { redactText } from "../redact.ts";
import { programIn } from "../../terminal/shell.ts";
import { TraceSessions } from "../sessions.ts";
import { TraceRuntime } from "../runtime.ts";
import { traceEndpointEnvironment } from "../environment.ts";
import { profileDirectory, profileJob } from "./workerClient.ts";
import type { ProfileJob, ProfileReply } from "./workerProtocol.ts";
import { stopOwned } from "./stop.ts";

const unavailable = () =>
  new ProfileError({
    code: "E-PROFILE-UNAVAILABLE",
    message: "CPU profiling is unavailable.",
    fix: "Check the Node or Bun installation and the Daemon's storage, then retry.",
  });

const captureLimit = () =>
  new ProfileError({
    code: "E-PROFILE-UNAVAILABLE",
    message: "The limit of four active recordings on this host has been reached.",
    fix: "Wait for a recording to finish, or stop an owned command before starting another.",
  });

const refused = () =>
  new ProfileError({
    code: "E-PROFILE-PROCESS-NOT-OWNED",
    message: "Polaris didn't start this process",
    fix: "Ask the user before restarting a process they started. Use profile command to launch a new recording instead.",
  });

interface Launch {
  readonly checkout: string;
  readonly cwd: string;
  readonly argv: ReadonlyArray<string>;
  readonly source: Record<string, string | undefined>;
  readonly child: Bun.Subprocess<"ignore", "ignore", "ignore">;
  readonly profile: Profile;
  readonly done: Promise<Profile>;
}

export interface ProfileOptions {
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  /** Worker boundary for deterministic startup/shutdown tests. */
  readonly worker?: typeof profileJob;
}

export interface ProfileRecording {
  readonly profile: Profile;
  readonly directory: string;
  readonly finish: Effect.Effect<Profile, ProfileError>;
}

export type ProfileRecordingMeta = Pick<Profile, "command" | "runtime" | "pid" | "service" | "cwd">;

/** Per-Host capture service. Only retained live subprocess handles authorize a restart. */
export const profilesLayerAt = (root: string, options: ProfileOptions = {}) =>
  Layer.effect(
    Profiles,
    Effect.gen(function* () {
      const targets = yield* Effect.serviceOption(InspectorTargets);
      const sessions = yield* TraceSessions;
      const eventStore = yield* EventStore;
      const trust = yield* WorkspaceTrust;
      const policy = yield* Effect.serviceOption(ApprovalPolicy);

      const authorize = Effect.fnUntraced(function* (id: SessionId) {
        const session = (yield* eventStore.model).sessions.get(id)?.session;

        if (session === undefined || !(yield* sessions.active(id))) return yield* refused();

        if (
          session.permissionMode === "plan" ||
          session.origin === "reviewer" ||
          (Option.isSome(policy) && policy.value.readOnly(id))
        )
          return yield* new ProfileError({
            code: "E-PROFILE-RESTART-REFUSED",
            message: "This agent session is read-only.",
            fix: "Ask the user to run profiling from a writable agent session.",
          });

        if (!(yield* trust.trusted(session.workspaceId)))
          return yield* new ProfileError({
            code: "E-PROFILE-RESTART-REFUSED",
            message: "This workspace is not trusted.",
            fix: "Trust the workspace in Polaris before running repository code with profiling.",
          });
      });

      const runtime = yield* TraceRuntime;
      const changes = yield* PubSub.sliding<void>(1);
      const storageRoot = resolve(root);
      let closed = false;

      const notify = () => {
        if (!closed) Effect.runSync(PubSub.publish(changes, undefined));
      };

      const launches = new Map<number, Launch>();
      const startingChildren = new Set<Launch["child"]>();
      const recordings = new Map<string, string>();
      const parsing = new Set<string>();
      let starting = 0;
      const restarting = new Set<number>();
      let tail: Promise<unknown> = Promise.resolve();
      let queued = 0;

      const job = (
        checkout: string,
        operation: ProfileJob["operation"],
        id = "",
        profile?: Profile
      ): Promise<ProfileReply> => {
        const completion = operation === "discard" || operation === "complete";

        if (completion && queued >= 32)
          return tail.catch(() => {}).then(() => job(checkout, operation, id, profile));

        if (queued >= 32 || (closed && !completion)) return Promise.reject(unavailable());
        queued++;

        const run = tail
          .catch(() => {})
          .then(() => {
            if (closed && !completion) throw unavailable();

            return (options.worker ?? profileJob)(
              {
                root: storageRoot,
                checkout,
                operation,
                id,
                active: [
                  ...[...launches.values()].map((l) => l.profile.id),
                  ...recordings.keys(),
                  ...parsing,
                ],
                now: Date.now(),
                maxBytes: options.maxBytes ?? 200 * 1024 * 1024,
                maxAgeMs: options.maxAgeMs ?? 7 * 86400_000,
                ...(profile === undefined ? undefined : { profile }),
              },
              notify
            );
          })
          .finally(() => {
            queued--;
          });

        tail = run;

        return run;
      };

      const attempt = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (e) => (e instanceof ProfileError ? e : unavailable()),
        });

      const context = (id: SessionId) =>
        sessions.session(id).pipe(
          Effect.mapError(
            () =>
              new ProfileError({
                code: "E-PROFILE-NOT-FOUND",
                message: "The agent session or checkout is unavailable.",
                fix: "Select an existing agent session in this checkout.",
              })
          )
        );

      const directoryError = () =>
        new ProfileError({
          code: "E-PROFILE-RESTART-REFUSED",
          message: "The command directory is unavailable or outside this checkout.",
          fix: "Select an accessible directory in this checkout and run profile command again.",
        });

      const cwdInCheckout = (checkout: string, requested: string) =>
        Effect.tryPromise({
          try: async () => {
            const cwd = await realpath(requested);
            const local = relative(checkout, cwd);

            if (
              local === ".." ||
              local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
              isAbsolute(local) ||
              !(await stat(cwd)).isDirectory()
            )
              throw directoryError();

            return cwd;
          },
          catch: directoryError,
        });

      const sessionCwd = Effect.fnUntraced(function* (id: SessionId, checkout: string) {
        const session = (yield* eventStore.model).sessions.get(id)?.session;

        if (session === undefined) return yield* refused();

        return yield* cwdInCheckout(checkout, session.cwd);
      });

      // P2 adds an optional launch Turn; older runtimes safely ignore that argument.
      const environment: (
        id: SessionId,
        source: Record<string, string | undefined>,
        launchTurn?: TurnId
      ) => ReturnType<TraceRuntime["Service"]["environment"]> = runtime.environment;

      const childEnvironment = Effect.fnUntraced(function* (
        id: SessionId,
        source: Record<string, string | undefined>,
        turn: TraceTurn | null
      ) {
        const overlay = yield* environment(id, source, turn?.id).pipe(
          Effect.mapError(() => unavailable())
        );

        return repositoryEnv(source, {
          NODE_OPTIONS: source.NODE_OPTIONS,
          BUN_OPTIONS: source.BUN_OPTIONS,
          OTEL_SERVICE_NAME: source.OTEL_SERVICE_NAME,
          ...traceEndpointEnvironment(source),
          ...overlay,
        });
      });

      const list = Effect.fnUntraced(function* (id: SessionId) {
        const { checkout } = yield* context(id);

        return yield* attempt(async () => {
          const reply = await job(checkout, "list");

          if (!("profiles" in reply)) throw unavailable();

          return reply.profiles;
        });
      });

      const startOwned = async (
        sessionId: SessionId,
        checkout: string,
        cwd: string,
        argv: ReadonlyArray<string>,
        env: Record<string, string | undefined>,
        source: Record<string, string | undefined>,
        turn: TraceTurn | null,
        origin: "command" | "restart"
      ): Promise<Launch> => {
        if (closed) throw unavailable();
        const runtimeName = basename(argv[0] ?? "").replace(/\.exe$/i, "");

        if (
          (runtimeName !== "node" && runtimeName !== "bun") ||
          argv.some((arg) => /^--(?:cpu-prof|diagnostic-dir)/.test(arg))
        )
          throw new ProfileError({
            code: "E-PROFILE-INVALID",
            message: "Use a Node or Bun argv without profiling output flags.",
            fix: 'For example: command ["bun", "test", "invoice.test.ts"].',
          });
        const id = ProfileId.make(crypto.randomUUID());
        const directory = await profileDirectory(storageRoot, checkout, id);
        const key = runtimeName === "node" ? "NODE_OPTIONS" : "BUN_OPTIONS";

        if (/--(?:cpu-prof|diagnostic-dir)/.test(env[key] ?? ""))
          throw new ProfileError({
            code: "E-PROFILE-INVALID",
            message: "Runtime options already configure CPU profiling.",
            fix: "Remove the existing CPU profile options before recording.",
          });
        const program = programIn(cwd, argv[0]!, env);

        if (program === null) throw unavailable();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const preload = join(directory, "exit.cjs");
        await writeFile(preload, 'process.once("SIGINT", () => process.exit(0));\n', {
          mode: 0o600,
          flag: "wx",
        });
        await Effect.runPromise(authorize(sessionId));
        const latest = await Effect.runPromise(context(sessionId));

        if (latest.checkout !== checkout) throw refused();
        const launchCwd = await Effect.runPromise(cwdInCheckout(checkout, cwd));
        await Effect.runPromise(authorize(sessionId));

        if (closed) throw unavailable();

        const startedAt = Timestamp.make(new Date().toISOString());

        const child = Bun.spawn(
          [
            executableOf(program),
            `--cpu-prof-dir=${directory}`,
            runtimeName === "node" ? "--require" : "--preload",
            preload,
            ...argv.slice(1),
          ],
          {
            cwd: launchCwd,
            detached: ownProcessGroup(),
            env: {
              ...env,
              [key]: `${env[key] ?? ""} --cpu-prof`.trim(),
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }
        );

        startingChildren.add(child);

        if (runtime.launched !== undefined)
          await Effect.runPromise(runtime.launched(launchCwd, argv).pipe(Effect.ignore));
        const service = env.OTEL_SERVICE_NAME ?? env.POLARIS_OTEL_SERVICE_NAME;

        const profile = Profile.make({
          id,
          cwd: launchCwd,
          command: redactText(argv.join(" ")).slice(0, 4096),
          runtime: runtimeName,
          pid: child.pid,
          turn,
          startedAt,
          durationMs: 0,
          path: null,
          status: "recording",
          origin,
          ...(service ? { service: redactText(service) } : undefined),
        });

        try {
          parsing.add(profile.id);
          await job(checkout, "start", id, profile);

          if (closed) throw unavailable();
        } catch (error) {
          parsing.delete(profile.id);
          startingChildren.delete(child);
          await stopOwned(child);
          throw error;
        }

        const done = child.exited
          .then(async () => {
            parsing.add(profile.id);
            const result = await job(checkout, "complete", id);

            if (!("profile" in result)) throw unavailable();

            return result.profile;
          })
          .catch(() => {
            notify();

            return Profile.make({ ...profile, status: "failed" });
          })
          .finally(() => {
            launches.delete(child.pid);
            parsing.delete(profile.id);
          });

        const owned: Launch = {
          checkout,
          cwd: launchCwd,
          argv: [...argv],
          source: { ...source },
          child,
          profile,
          done,
        };

        launches.set(child.pid, owned);
        startingChildren.delete(child);
        parsing.delete(profile.id);

        return owned;
      };

      const reserve = (replacing?: number) => {
        if (closed) throw unavailable();

        const live = [...launches.values()].filter(
          ({ child }) =>
            child.pid !== replacing &&
            !restarting.has(child.pid) &&
            child.exitCode === null &&
            child.signalCode === null
        ).length;

        if (live + recordings.size + starting >= 4) throw captureLimit();
        starting++;
      };

      const launch = async (...args: Parameters<typeof startOwned>) => {
        reserve();

        try {
          return await startOwned(...args);
        } finally {
          starting--;
        }
      };

      const acquireRecording = Effect.fnUntraced(function* (
        id: SessionId,
        meta: ProfileRecordingMeta
      ) {
        yield* authorize(id);
        const ctx = yield* context(id);

        return yield* attempt(async () => {
          reserve();
          let pending = true;

          try {
            const verifiedCwd =
              meta.cwd === undefined
                ? undefined
                : await Effect.runPromise(cwdInCheckout(ctx.checkout, meta.cwd));

            const profile = Profile.make({
              ...meta,
              ...(verifiedCwd === undefined ? undefined : { cwd: verifiedCwd }),
              command: redactText(meta.command).slice(0, 4096),
              origin: "attach",
              id: ProfileId.make(crypto.randomUUID()),
              turn: ctx.turns.findLast((t) => t.end === null)?.turn ?? null,
              startedAt: Timestamp.make(new Date().toISOString()),
              durationMs: 0,
              path: null,
              status: "recording",
              ...(meta.service === undefined ? undefined : { service: redactText(meta.service) }),
            });

            recordings.set(profile.id, ctx.checkout);
            starting--;
            pending = false;

            try {
              await job(ctx.checkout, "start", profile.id, profile);
            } catch (error) {
              recordings.delete(profile.id);
              throw error;
            }

            const directory = await profileDirectory(storageRoot, ctx.checkout, profile.id);

            if (closed) {
              recordings.delete(profile.id);
              await job(ctx.checkout, "discard", profile.id);
              throw unavailable();
            }

            let completion: Promise<Profile> | undefined;

            const finish = attempt(() => {
              completion ??= (async () => {
                recordings.delete(profile.id);
                parsing.add(profile.id);
                const reply = await job(ctx.checkout, "complete", profile.id);

                if (!("profile" in reply)) throw unavailable();

                return reply.profile;
              })().finally(() => parsing.delete(profile.id));

              return completion;
            });

            return { profile, directory, finish, checkout: ctx.checkout };
          } finally {
            if (pending) starting--;
          }
        });
      });

      const record = (id: SessionId, meta: ProfileRecordingMeta) =>
        Effect.acquireRelease(acquireRecording(id, meta), (recording, exit) =>
          Exit.isSuccess(exit)
            ? recording.finish.pipe(Effect.ignore)
            : attempt(async () => {
                recordings.delete(recording.profile.id);
                await job(recording.checkout, "discard", recording.profile.id);
              }).pipe(Effect.ignore)
        );

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          closed = true;

          const stopping = [...launches.values()];
          await Promise.allSettled(
            stopping
              .map((l) => l.child)
              .concat([...startingChildren])
              .map(stopOwned)
          );
          await Promise.allSettled(stopping.map((l) => l.done));
          launches.clear();
          startingChildren.clear();
          await tail.catch(() => {});
          await Effect.runPromise(PubSub.shutdown(changes));
        })
      );

      return Profiles.of({
        record,
        attach: (id, pid, seconds = 5) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* authorize(id);

              if (Option.isNone(targets)) return yield* unavailable();

              return yield* captureAttached(
                id,
                pid,
                seconds,
                record,
                targets.value,
                authorize(id)
              ).pipe(Effect.provideService(EventStore, eventStore));
            })
          ),
        attachUser: (id, pid, seconds = 5) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* authorize(id);

              if (Option.isNone(targets)) return yield* unavailable();

              return yield* captureAttached(
                id,
                pid,
                seconds,
                record,
                targets.value,
                authorize(id),
                "user"
              ).pipe(Effect.provideService(EventStore, eventStore));
            })
          ),
        list,
        capture: Effect.fnUntraced(function* (id, argv, waitSeconds = 30) {
          yield* authorize(id);
          const ctx = yield* context(id);

          const cwd = yield* sessionCwd(id, ctx.checkout);
          const source = { ...process.env };
          const turn = ctx.turns.findLast((t) => t.end === null)?.turn ?? null;
          const env = yield* childEnvironment(id, source, turn);

          return yield* attempt(async () => {
            const owned = await launch(
              id,
              await realpath(ctx.checkout),
              cwd,
              argv,
              env,
              source,
              turn,
              "command"
            );

            let timer: ReturnType<typeof setTimeout> | undefined;

            try {
              return await Promise.race([
                owned.done,
                new Promise<Profile>((resolve) => {
                  timer = setTimeout(() => resolve(owned.profile), waitSeconds * 1000);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          });
        }),
        restart: Effect.fnUntraced(function* (id, pid) {
          yield* authorize(id);
          const ctx = yield* context(id);

          return yield* attempt(async () => {
            const owned = launches.get(pid);

            if (
              owned === undefined ||
              owned.checkout !== (await realpath(ctx.checkout)) ||
              owned.child.exitCode !== null ||
              owned.child.signalCode !== null
            )
              throw refused();

            await Effect.runPromise(cwdInCheckout(owned.checkout, owned.cwd));
            const turn = ctx.turns.findLast((t) => t.end === null)?.turn ?? null;
            const env = await Effect.runPromise(childEnvironment(id, owned.source, turn));
            await Effect.runPromise(authorize(id));

            if (
              launches.get(pid) !== owned ||
              owned.child.exitCode !== null ||
              owned.child.signalCode !== null
            )
              throw refused();

            if (restarting.has(pid))
              throw new ProfileError({
                code: "E-PROFILE-RESTART-REFUSED",
                message: "This process is already restarting.",
                fix: "Wait for the new recording in Traces (⌘5).",
              });
            reserve(pid);
            restarting.add(pid);

            try {
              await stopOwned(owned.child);
              await owned.done;

              return (
                await startOwned(
                  id,
                  owned.checkout,
                  owned.cwd,
                  owned.argv,
                  env,
                  owned.source,
                  turn,
                  "restart"
                )
              ).profile;
            } finally {
              starting--;
              restarting.delete(pid);
            }
          });
        }),
        get: Effect.fnUntraced(function* (id, profileId) {
          const ctx = yield* context(id);

          return yield* attempt(async () => {
            const reply = await job(ctx.checkout, "get", profileId);

            if (!("hotFunctions" in reply)) throw unavailable();

            return reply;
          });
        }),
        watch: (id) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(changes);
              const initial = yield* list(id);

              return Stream.concat(
                Stream.succeed({ profiles: initial }),
                Stream.fromSubscription(subscription).pipe(
                  Stream.mapEffect(() => Effect.map(list(id), (profiles) => ({ profiles })))
                )
              );
            })
          ),
      });
    })
  );
