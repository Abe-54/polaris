import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as P from "@polaris/protocol";
import { Context, Deferred, Effect, Layer, type Scope } from "effect";
import { EventStore } from "../../store/EventStore.ts";
import { CurrentLanguageConnection } from "../../transport/currentLanguageConnection.ts";
import { registeredCheckout } from "../registeredCheckout.ts";
import { catalog } from "../catalog/index.ts";
import { availability } from "../availability/index.ts";
import { ProjectDiscovery } from "../discovery/index.ts";
import { ExecutionTrustService, type TrustRecord, trustScopeKey } from "../trust/index.ts";
import { LanguageBroker } from "../runtime/index.ts";
import { LanguageCore } from "./core.ts";
import { ProposalProvenance } from "../preparation/provenanceService.ts";
import { LanguageAcquisitionAuthority } from "./acquisitionAuthority.ts";
import type { ObservationAdmission } from "../install/host.ts";
import {
  LanguageProviderAccess,
  LanguageTrustGrantAuthority,
  LanguageConnectionLifetime,
  languageBrokerLayer,
} from "./ports.ts";
import { scopedTempDir } from "../../platform/tempDir.testing.ts";

export const hostId = P.HostId.make("core-host");

export const fixture = (
  gate?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> },
  holdLaunch = false
) =>
  Effect.gen(function* () {
    const root = yield* scopedTempDir("m31-h1-core-", { short: true });

    const workspaceId = P.WorkspaceId.make("core-workspace");
    yield* Effect.promise(() => writeFile(join(root, "file.ts"), "saved"));
    const store = yield* EventStore;
    yield* store.commit({
      commandId: null,
      decide: () =>
        Effect.succeed([
          P.DomainEvent.cases.WorkspaceRegistered.make({
            workspace: new P.Workspace({
              id: workspaceId,
              path: root,
              name: "fixture",
              isGitRepo: false,
              worktreeRoot: join(root, "trees"),
              hidden: false,
              registeredAt: new Date().toISOString(),
            }),
          }),
        ]),
    });
    const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: root });

    const registry = async (input: P.LanguageCheckout) =>
      registeredCheckout(await Effect.runPromise(store.model), input);

    const records = new Map<string, TrustRecord>();
    let afterTrustWrite: (() => void) | undefined;

    const trust = ExecutionTrustService.layer({
      hostId,
      registry,
      authorizeGrant: async () => {},
      repository: {
        read: async (scope) => records.get(trustScopeKey(scope)) ?? null,
        compareAndSet: async (record, revision) => {
          const key = trustScopeKey(record.trust.scope);

          if ((records.get(key)?.trust.revision ?? 0) !== revision) return false;
          records.set(key, record);
          afterTrustWrite?.();

          return true;
        },
      },
    });

    let spawns = 0;
    const observations: ObservationAdmission[] = [];

    let current: P.LanguageConnectionIdentity | null = P.LanguageConnectionIdentity.make({
      hostId,
      clientId: "actual-client",
    });

    const access = Layer.succeed(LanguageProviderAccess)({
      availability: (toolId, phase, trusted, admission) =>
        Effect.sync(() => {
          if (admission !== undefined) observations.push(admission);
          const tool = catalog.tools.find((value) => value.id === toolId);

          if (tool === undefined) throw new Error("Unknown fixture tool");

          return availability({
            hostId,
            platform: { os: "darwin", arch: "arm64", libc: "none" },
            tool,
            connected: true,
            trusted,
            approved: false,
            phase,
            probes: [],
            installed: null,
            checkedAt: Date.now(),
          });
        }),
      reserveLaunch: async (request) => ({
        selectionIdentity: "fake-fixture-selection",
        validate: async () => {
          if (request.signal.aborted || !request.isCurrent()) throw new Error("Stale fake launch");
        },
        assertCurrent: () => {
          if (request.signal.aborted || !request.isCurrent()) throw new Error("Stale fake launch");
        },
        release: async () => {},
      }),
      resolveLaunch: async (_facts, _lease, request) => {
        if (holdLaunch && !request.signal.aborted)
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), { once: true })
          );
        throw new P.LanguageError({
          reason: "not-installed",
          message: "Approved installed provider unavailable",
          retryable: false,
        });
      },
    });

    const services = Layer.mergeAll(
      Layer.effect(
        ProjectDiscovery,
        Effect.gen(function* () {
          const actual = yield* ProjectDiscovery;

          return ProjectDiscovery.of({
            ...actual,
            discover: (input) =>
              Effect.gen(function* () {
                if (gate !== undefined) {
                  yield* Deferred.succeed(gate.entered, undefined);
                  yield* Deferred.await(gate.release);
                }

                return yield* actual.discover(input);
              }),
          });
        })
      ).pipe(Layer.provide(ProjectDiscovery.layer({ registry }))),
      trust,
      access,
      LanguageAcquisitionAuthority.layer,
      ProposalProvenance.layer,
      LanguageTrustGrantAuthority.denyLayer,
      Layer.succeed(LanguageConnectionLifetime)({ attach: () => Effect.void }),
      Layer.succeed(EventStore)(store)
    );

    const brokerLayer = languageBrokerLayer({
      hostId,
      graceMs: 1,
      spawn: () => {
        spawns++;
        throw new Error("Must not execute");
      },
    }).pipe(Layer.provideMerge(services));

    const coreLayer = LanguageCore.layer(hostId).pipe(Layer.provideMerge(brokerLayer));
    const servicesContext = yield* Layer.build(coreLayer);
    const core = Context.get(servicesContext, LanguageCore);
    const broker = Context.get(servicesContext, LanguageBroker);
    const connection = CurrentLanguageConnection.of({ current: () => current });

    const run = <A, E>(
      operation: Effect.Effect<
        A,
        E,
        | CurrentLanguageConnection
        | EventStore
        | LanguageProviderAccess
        | LanguageTrustGrantAuthority
        | LanguageConnectionLifetime
      >
    ) =>
      operation.pipe(
        Effect.provide(servicesContext),
        Effect.provideService(CurrentLanguageConnection, connection)
      );

    const settings = P.LanguageEffectiveSettings.make({
      revision: 0,
      settings: {},
      formatOnSave: true,
      formatter: P.LanguageFormatterSelection.cases.None.make({}),
      providers: [],
      origins: {},
    });

    const input = {
      clientId: "actual-client",
      contextId: "context",
      interestId: "file",
      checkout,
      path: join(root, "file.ts"),
      providerId: "typescript-language-server",
      settings,
    };

    return {
      root,
      servicesContext,
      core,
      broker,
      run,
      connection,
      store,
      checkout,
      input,
      settings,
      observations,
      onTrustWrite: (callback: () => void) => {
        afterTrustWrite = callback;
      },
      spawns: () => spawns,
      replace: () => {
        current = P.LanguageConnectionIdentity.make({ hostId, clientId: "actual-client" });
      },
      disconnect: () => {
        current = null;
      },
    };
  });

export const run = <A, E>(program: Effect.Effect<A, E, EventStore | Scope.Scope>) =>
  Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provide(EventStore.layerSqlite(":memory:")))
  );
