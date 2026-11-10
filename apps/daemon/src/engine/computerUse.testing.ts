/**
 * Computer use through the real Engine, for tests (ENG-846): the Engine, the Host's app policy
 * and `polaris_desktop` over a fake agent-desktop and a fake Linux Host that is ready.
 */
import { join } from "node:path";
import {
  Actor,
  ApprovalDecision,
  type ApprovalRequest,
  Command,
  type Grant,
  PairingId,
  type PermissionMode,
  type SessionId,
  SessionPlacement,
} from "@polaris/protocol";
import { Effect, Layer, type Schema, type Scope } from "effect";
import { AppControl, ComputerUseHost } from "../computerUse/index.ts";
import { a11yInstalled, busctl, fakeHost, linuxDesktop } from "../computerUse/host.testing.ts";
import type { HostProbe } from "../computerUse/probe.ts";
import {
  DesktopMcp,
  type DesktopResult,
  type DesktopServer,
  storeSessions,
} from "../harness/desktop/index.ts";
import { DIA_IN_FRONT, fakeDeps, fakeRunner, ok } from "../harness/desktop/testing.ts";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { EventStore } from "../store/EventStore.ts";
import { Engine } from "./Engine.ts";
import {
  cid,
  engineLayer,
  type FakeDriver,
  fakeEngineParts,
  fakeRepo,
  tempDir,
  waitFor,
} from "./testing.ts";

/** A loaded pre-push or CI run can take longer than waitFor's 2 s default. */
const LOADED_MS = 10_000;

export type Env = Engine | EventStore | DesktopMcp | ComputerUseHost | AppControl;

export const DIA = "company.thebrowser.dia";

/** What agent-desktop lists as running: one app's name hides a shell, one only sounds like one. */
const RUNNING = ok("list-apps", {
  apps: [
    { name: "Dia", bundle_id: DIA },
    { name: "TextEdit", bundle_id: "com.apple.TextEdit" },
    { name: "Terminal", bundle_id: "com.apple.Terminal" },
    { name: "Quarterly Report", bundle_id: "com.googlecode.iterm2" },
    { name: "Passwords", bundle_id: "com.example.crossword" },
  ],
});

const readyProbe = async () => {
  const host = fakeHost();
  const probe = await linuxDesktop(host);
  a11yInstalled(host);
  busctl(host, 0);

  return { probe, file: join(host.root, "computer-use.json") };
};

export const setup = async (reuse?: { filename: string; probe: HostProbe; file: string }) => {
  const { driver, fakes } = fakeEngineParts();
  const filename = reuse?.filename ?? join(tempDir(), "state.sqlite");
  const { probe, file } = reuse ?? (await readyProbe());
  const agentDesktop = fakeRunner({ "list-apps": RUNNING, "list-windows": DIA_IN_FRONT });

  const desktop = Layer.unwrap(
    Effect.gen(function* () {
      const authorize = yield* AppControl;
      const sessions = yield* storeSessions;

      return DesktopMcp.layerWith(fakeDeps(agentDesktop.runner, { authorize, sessions }));
    })
  );

  // As `transport/serve.ts` binds it: the policy sits under the Engine it asks.
  const bound = Layer.effectDiscard(
    Effect.gen(function* () {
      const engine = yield* Engine;

      yield* (yield* AppControl).bind(engine.requestAppApproval);
    })
  );

  const layer = Layer.mergeAll(desktop, bound).pipe(
    Layer.provideMerge(AppControl.layer),
    Layer.provideMerge(ComputerUseHost.layerWith({ probe, file })),
    Layer.provideMerge(engineLayer({ filename, fakes, drivers: [driver] }))
  );

  return { driver, layer, ran: agentDesktop.calls, reuse: { filename, probe, file } };
};

export const run = <A, E>(
  layer: Layer.Layer<Env>,
  program: Effect.Effect<A, E, Env | Scope.Scope>
) => Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer)));

const raycast = Actor.cases.Extension.make({ pairingId: PairingId.make("p-1"), name: "Raycast" });

/** A command from the Desktop App, or from an Extension holding `grant`. */
export const dispatch = (command: Command, grant: Grant | null = null) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({
      commandId: cid(),
      command,
      deviceLabel: grant === null ? "Mac" : "Raycast",
      extensionGrant: grant,
      actor: grant === null ? Actor.cases.Client.make({}) : raycast,
    })
  );

/** A session with a Turn in flight and its `polaris_desktop` server, computer use on. */
export const open = (sessionId: SessionId, permissionMode: PermissionMode = "supervised") =>
  Effect.gen(function* () {
    yield* (yield* ComputerUseHost).enable;
    const repo = fakeRepo();
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));

    const model = yield* waitFor(
      (m) => [...m.workspaces.values()].some((w) => w.path === repo),
      LOADED_MS
    );

    yield* dispatch(
      Command.cases.StartSession.make({
        sessionId,
        workspaceId: [...model.workspaces.values()].find((w) => w.path === repo)!.id,
        harness: "codex",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode,
        model: null,
        effort: null,
        prompt: `Work for ${sessionId}`,
        attachments: [],
      })
    );
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "working", LOADED_MS);

    return (yield* (yield* DesktopMcp).forSession({ sessionId }))!;
  });

export const call = (server: DesktopServer, name: string, input: typeof Schema.Json.Type) =>
  server.tools.find((tool) => tool.name === name)!.call(input);

export const textOf = (result: DesktopResult) =>
  result.content.flatMap((c) => ("text" in c ? [c.text] : [])).join("\n");

export const pendingOf = (sessionId: SessionId) =>
  Effect.flatMap(EventStore, (store) => store.model).pipe(
    Effect.map((model) => [...(model.sessions.get(sessionId)?.pending.values() ?? [])])
  );

/** Starts a tool call and waits for the approval it opens. */
export const asking = (
  server: DesktopServer,
  sessionId: SessionId,
  name: string,
  input: typeof Schema.Json.Type
) =>
  Effect.gen(function* () {
    const result = call(server, name, input);

    const model = yield* waitFor(
      (m) => (m.sessions.get(sessionId)?.pending.size ?? 0) > 0,
      LOADED_MS
    );

    const request = [...model.sessions.get(sessionId)!.pending.values()][0]!;

    return { result, request };
  });

export const allow = (remember = false) => ApprovalDecision.cases.Allow.make({ remember });

export const respond = (
  request: ApprovalRequest,
  decision: ApprovalDecision,
  grant: Grant | null = null
) =>
  dispatch(
    Command.cases.RespondToApproval.make({
      sessionId: request.sessionId,
      requestId: request.id,
      decision,
    }),
    grant
  );

/** Uses an app for the first time and allows it for the session. */
export const allowed = (
  server: DesktopServer,
  sessionId: SessionId,
  name: string,
  input: typeof Schema.Json.Type
) =>
  Effect.gen(function* () {
    const { result, request } = yield* asking(server, sessionId, name, input);
    yield* respond(request, allow());

    return yield* Effect.promise(() => result);
  });

export const endTurn = (driver: FakeDriver, sessionId: SessionId) =>
  Effect.gen(function* () {
    const harness = driver.latest(sessionId)!;
    const turnId = harness.turns.at(-1)!.turnId;
    harness.emit(HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }));
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle", LOADED_MS);
  });

export const ranCommand = (ran: ReadonlyArray<ReadonlyArray<string>>, command: string) =>
  ran.filter((args) => args.includes(command)).length;
