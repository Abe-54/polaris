/**
 * ENG-587 on the real Host stream: the Engine's stream never carries `LeadNotified`, so the
 * notifier must learn a digest's Turn from the store model. Fakes only at the relay's wake.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  Command,
  ConstellationSettings,
  DomainEvent,
  PlanOperation,
  SessionId,
  SessionPlacement,
  Turn,
  TurnId,
  type Workspace,
} from "@polaris/protocol";
import type { PushMessage } from "@polaris/protocol/relay";
import { Effect, Layer, Predicate, Stream } from "effect";
import { C, CID, ctx, task } from "../engine/constellation.testing.ts";
import { decideConstellation } from "../engine/constellation.ts";
import { Engine } from "../engine/Engine.ts";
import {
  cid,
  completesTurns,
  engineLayer,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "../engine/testing.ts";
import { RelayRoute } from "../linkedDevices/route.ts";
import type { PushTarget } from "../linkedDevices/store.ts";
import { HostPresence } from "../presence/index.ts";
import { EventStore } from "../store/EventStore.ts";
import { PushHostEvents, PushNotifier } from "./notifier.ts";
import { SETTLE_MS } from "./plan.ts";

const LEAD = SessionId.make("lead");

const OTHER = SessionId.make("other");

const unused = Effect.die("not used by the notifier");

// SAFETY: the notifier reads only `registration.automatic`; `wake` below never looks at it.
const target = { device: {}, registration: {} } as PushTarget;

const relay = (woken: Array<PushMessage>) =>
  RelayRoute.of({
    status: unused,
    enable: () => unused,
    disable: unused,
    startLink: unused,
    awaitLink: () => unused,
    cancelLink: () => unused,
    add: () => unused,
    list: unused,
    watch: Stream.empty,
    unlink: () => unused,
    unlinkSelf: () => unused,
    registerPush: () => unused,
    unregisterPush: () => unused,
    pushTargets: () => [target],
    watchPush: () => () => {},
    registerLiveActivity: () => unused,
    unregisterLiveActivity: () => unused,
    liveTargets: () => [],
    watchLive: () => () => {},
    sendLive: () => false,
    host: { hostId: "host-1", hostName: "studio" },
    wake: (_, message) => Effect.sync(() => (woken.push(message), "sent" as const)),
  });

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "MacBook" })
  );

const startSession = (sessionId: SessionId, workspace: Workspace) =>
  Effect.gen(function* () {
    yield* dispatch(
      Command.cases.StartSession.make({
        sessionId,
        workspaceId: workspace.id,
        harness: "claude",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: "Plan the work",
        attachments: [],
      })
    );
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");
  });

const turnOf = (sessionId: SessionId, id: string, index: number, reply: string | null) =>
  new Turn({
    id: TurnId.make(id),
    sessionId,
    index,
    prompt: "Digest",
    replyPreview: reply,
    attachments: [],
    model: null,
    effort: null,
    status: reply === null ? "working" : "completed",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: "2026-11-09T12:00:00.000Z",
    endedAt: reply === null ? null : "2026-11-09T12:00:01.000Z",
  });

const commit = (events: (revision: number) => ReadonlyArray<DomainEvent>) =>
  Effect.flatMap(EventStore, (store) =>
    store.commit({
      commandId: null,
      decide: (model) => Effect.succeed(events(model.constellations.get(CID)?.graph.revision ?? 0)),
    })
  );

test("a digest's Lead Turn ends without a push; another session's finished Turn pushes", async () => {
  const woken: Array<PushMessage> = [];
  const claude = makeFakeDriver("claude", { onTurn: completesTurns("c-1") });

  const engine = engineLayer({
    filename: join(tempDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [claude],
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repo = fakeRepo();
        yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));

        const model = yield* waitFor((m) =>
          [...m.workspaces.values()].some((w) => w.path === repo)
        );

        const workspace = [...model.workspaces.values()].find((w) => w.path === repo)!;
        yield* startSession(LEAD, workspace);
        yield* startSession(OTHER, workspace);

        const started = decideConstellation(
          undefined,
          C.Plan.make({
            constellationId: CID,
            start: {
              name: "Build",
              workspaceId: workspace.id,
              leadSessionId: LEAD,
              settings: new ConstellationSettings({}),
            },
            operations: [PlanOperation.cases.Add.make({ task: task() })],
          }),
          ctx()
        );

        expect(started.rejection).toBeNull();

        yield* commit(() => started.events);

        let synchronized = false;
        // The Engine's Host stream, noting when it goes live.

        const hostEvents = Layer.effect(
          PushHostEvents,
          Effect.map(PushHostEvents, (events) =>
            PushHostEvents.of({
              ...events,
              subscribe: () =>
                events.subscribe().pipe(
                  Stream.tap((item) =>
                    Effect.sync(() => {
                      synchronized ||= Predicate.isTagged(item, "Synchronized");
                    })
                  )
                ),
            })
          )
        ).pipe(Layer.provide(PushHostEvents.engine));

        yield* Layer.build(
          PushNotifier.pipe(
            Layer.provide(
              Layer.mergeAll(
                hostEvents,
                Layer.succeed(RelayRoute)(relay(woken)),
                Layer.succeed(HostPresence)(HostPresence.make({ leaseMs: 60_000 }))
              )
            )
          )
        );
        yield* waitUntil(() => synchronized, 2_000, "the notifier follows the Host stream");

        // As `delivery/local.ts` commits a digest: its Turn and `LeadNotified` together.
        yield* commit((revision) => [
          DomainEvent.cases.TurnStarted.make({
            turn: turnOf(LEAD, "t-digest", 1, null),
            actor: null,
          }),
          DomainEvent.cases.LeadNotified.make({
            constellationId: CID,
            revision: revision + 1,
            leadSessionId: LEAD,
            items: [],
            turnId: TurnId.make("t-digest"),
            steered: false,
            audit: null,
          }),
        ]);
        yield* commit(() => [
          DomainEvent.cases.TurnStarted.make({
            turn: turnOf(OTHER, "t-user", 1, null),
            actor: null,
          }),
        ]);
        // The digest's Turn settles first, so its push would precede the user's.
        yield* commit(() => [
          DomainEvent.cases.TurnEnded.make({ turn: turnOf(LEAD, "t-digest", 1, "Dispatched A") }),
        ]);
        yield* commit(() => [
          DomainEvent.cases.TurnEnded.make({ turn: turnOf(OTHER, "t-user", 1, "Merged A") }),
        ]);

        yield* waitUntil(
          () => woken.some((m) => m.sessionId === OTHER),
          SETTLE_MS + 2_000,
          "the user's Turn pushes"
        );
        expect(woken.map((m) => [m.kind, m.sessionId, m.body])).toEqual([
          ["turn-ended", OTHER, "Merged A"],
        ]);
      })
    ).pipe(Effect.provide(engine))
  );
}, 15_000);
