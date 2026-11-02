import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  AgentSession,
  DomainEvent,
  SessionId,
  Workspace,
  WorkspaceId,
  type PermissionMode,
  type SessionOrigin,
} from "@polaris/protocol";
import { WorkspaceTrust, ApprovalPolicy } from "../../services.ts";
import { EventStore } from "../../store/EventStore.ts";
import { TraceSessions } from "../sessions.ts";
import { TraceRuntime } from "../runtime.ts";
import { TraceStore } from "../store.ts";
import { commit, seed } from "../authority.testing.ts";
import { TEST_SESSION } from "../testing.ts";
import { InspectorTargets, TargetRegistry } from "../attach/registry.ts";
import { Profiles, type ProfileOptions } from "./index.ts";

interface ProfileTestSession {
  readonly mode?: PermissionMode;
  readonly origin?: SessionOrigin;
  readonly checkout?: string;
  readonly cwd?: string;
}

export const withProfiles = async (
  run: (f: {
    root: string;
    targets: TargetRegistry;
    runtime: ManagedRuntime.ManagedRuntime<
      Profiles | EventStore | TraceStore | TraceSessions | TraceRuntime,
      never
    >;
    trust: (value: boolean) => void;
    readonly: (value: boolean) => void;
    addSession: (id: string, options?: ProfileTestSession) => Promise<SessionId>;
  }) => Promise<void>,
  options: ProfileOptions = {}
) => {
  const root = newTempDir("p4-", { short: true });
  const targets = new TargetRegistry(join(root, "bootstrap"));
  let trusted = true;
  let readOnly = false;

  await mkdir(join(root, "package"));

  const policyLayer = Layer.succeed(ApprovalPolicy)({
    readOnly: () => readOnly,
    decide: () => Effect.succeed(null),
  });

  const events = EventStore.layerSqlite(join(root, "events.sqlite"));
  const sessions = TraceSessions.layer.pipe(Layer.provideMerge(events));

  const traces = TraceRuntime.layerAt(join(root, "tokens.json")).pipe(
    Layer.provide(Layer.succeed(InspectorTargets, targets)),
    Layer.provide(policyLayer),
    Layer.provideMerge(TraceStore.layerAt(join(root, "traces.sqlite"))),
    Layer.provideMerge(sessions)
  );

  const layer = Profiles.layerAt(join(root, "profiles"), options).pipe(
    Layer.provideMerge(traces),
    Layer.provide(Layer.succeed(InspectorTargets, targets)),
    Layer.provide(policyLayer),
    Layer.provide(Layer.succeed(WorkspaceTrust)({ trusted: () => Effect.sync(() => trusted) })),
    Layer.provide(policyLayer)
  );

  const runtime = ManagedRuntime.make(layer);

  try {
    await runtime.runPromise(seed(root));
    await run({
      root,
      targets,
      runtime,
      trust: (value) => {
        trusted = value;
      },
      readonly: (value) => {
        readOnly = value;
      },
      addSession: async (id, options = {}) => {
        const permissionMode = options.mode ?? "supervised";
        const origin = options.origin;
        const checkout = options.checkout;
        const sid = SessionId.make(id);

        if (checkout !== undefined) await mkdir(checkout, { recursive: true });
        await runtime.runPromise(
          Effect.gen(function* () {
            const store = yield* EventStore;
            const session = (yield* store.model).sessions.get(TEST_SESSION)!.session;
            const workspaceId = checkout === undefined ? session.workspaceId : WorkspaceId.make(id);

            if (checkout !== undefined) {
              const original = (yield* store.model).workspaces.get(session.workspaceId)!;
              yield* commit([
                DomainEvent.cases.WorkspaceRegistered.make({
                  workspace: new Workspace({
                    ...Schema.encodeSync(Workspace)(original),
                    id: workspaceId,
                    path: checkout,
                  }),
                }),
              ]);
            }

            yield* commit([
              DomainEvent.cases.SessionCreated.make({
                session: Schema.decodeUnknownSync(AgentSession)({
                  ...Schema.encodeSync(AgentSession)(session),
                  id: sid,
                  workspaceId,
                  cwd: options.cwd ?? checkout ?? session.cwd,
                  permissionMode,
                  origin: origin ?? null,
                }),
              }),
            ]);
          })
        );

        return sid;
      },
    });
  } finally {
    await runtime.dispose();
    await targets.close();
    await removeTempDirSettled(root);
  }
};

export const cpuWork =
  "function polarisBurn(){const until=Date.now()+100; let n=0; while(Date.now()<until){for(let i=0;i<10000;i++)n+=Math.sqrt(i)} return n} polarisBurn();";
