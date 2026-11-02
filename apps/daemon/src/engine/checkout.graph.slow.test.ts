/**
 * Model-based tests generated from the Review Checkout machine: `xstate/graph`
 * walks the test model (checkout.testing.ts) and every path is replayed
 * against the real Engine, with a fake `ReviewCheckoutGit` answering from the
 * same world as the model. After every step the Engine's checkout and the
 * fake's world must equal the model's, and a refused command must be refused
 * with the model's reason.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Command, ReviewCheckoutBlocker, type WorkspaceId } from "@polaris/protocol";
import { type Context, Effect, Exit, Layer, Scope } from "effect";
import { CheckoutBlocked, ReviewCheckoutGit } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import {
  CHECKOUT,
  checkoutPaths,
  FETCH_ERROR,
  headName,
  initialWorld,
  MAX_HEAD,
  MERGE_BASE,
  type ModelSnapshot,
  type Observed,
  observe,
  type Step,
  stepModel,
  SUBJECT,
  type World,
} from "./checkout.testing.ts";
import { Engine } from "./Engine.ts";
import { cid, engineLayer, fakeRepo, makeFakeDriver, makeFakes, tempDir } from "./testing.ts";

type Env = Engine | EventStore;

/** The fake's world, changed by the test's steps and by the reactor's git calls. */
const fakeGit = (world: { current: World }) =>
  Layer.succeed(ReviewCheckoutGit)({
    fetchPullRequest: () =>
      world.current.fetchBroken
        ? Effect.fail(
            new CheckoutBlocked({
              blocker: ReviewCheckoutBlocker.cases.FetchFailed.make({ message: FETCH_ERROR }),
            })
          )
        : Effect.succeed({ head: headName(world.current.hostHead), mergeBase: MERGE_BASE }),
    pinCommits: () => Effect.die(new Error("no Agent Session subjects in this model")),
    ensure: () =>
      Effect.sync(() => {
        world.current = { ...world.current, worktree: true, dirty: false };
      }),
    inspect: () =>
      Effect.sync(() => ({
        present: world.current.worktree,
        dirtyPaths: world.current.dirty ? ["feature.txt"] : [],
        localCommits: 0,
      })),
    move: () =>
      Effect.sync(() => {
        world.current = { ...world.current, dirty: false };
      }),
    remove: () =>
      Effect.sync(() => {
        world.current = { ...world.current, worktree: false, dirty: false };
      }),
    markReviewed: () => Effect.void,
    interdiff: () => Effect.die(new Error("no interdiff in this model")),
  });

const worldStep = (step: Step, world: World): World => {
  if (step.type === "push") return { ...world, hostHead: Math.min(world.hostHead + 1, MAX_HEAD) };

  if (step.type === "breakFetch") return { ...world, fetchBroken: true };

  if (step.type === "fixFetch") return { ...world, fetchBroken: false };

  return step.type === "edit" ? { ...world, dirty: world.worktree } : world;
};

const describeSteps = (steps: ReadonlyArray<Step>) => steps.map((s) => s.type).join(" → ");

const replay = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const world = { current: initialWorld };

    const layer = engineLayer({
      filename: join(tempDir(), "state.sqlite"),
      fakes: makeFakes(),
      drivers: [makeFakeDriver("claude")],
      reviewCheckoutGit: fakeGit(world),
    });

    const scope = yield* Scope.make();
    const services: Context.Context<Env> = yield* Layer.buildWithScope(layer, scope);
    const inEngine = <A, E>(effect: Effect.Effect<A, E, Env>) => Effect.provide(effect, services);

    const dispatch = (command: Command) =>
      inEngine(
        Effect.flatMap(Engine, (engine) =>
          engine.dispatch({ commandId: cid("model"), command, deviceLabel: "model" })
        )
      );

    const observed = () =>
      inEngine(Effect.flatMap(EventStore, (store) => store.model)).pipe(
        Effect.map((model) => ({
          checkout: observe(model.reviewCheckouts.get(CHECKOUT)),
          world: world.current,
        }))
      );

    const settle = (expected: { checkout: Observed; world: World }, done: ReadonlyArray<Step>) =>
      Effect.gen(function* () {
        const deadline = Date.now() + 3000;

        while (true) {
          const actual = yield* observed();

          if (Bun.deepEquals(actual, expected)) return;

          if (Date.now() > deadline) {
            return yield* Effect.die(
              new Error(
                `after ${describeSteps(done)}: the Engine shows ${JSON.stringify(actual)}, the model ${JSON.stringify(expected)}`
              )
            );
          }

          yield* Effect.sleep(2);
        }
      });

    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: fakeRepo(), name: null }));

    const workspaceId: WorkspaceId = yield* inEngine(
      Effect.flatMap(EventStore, (store) => store.model)
    ).pipe(Effect.map((model) => [...model.workspaces.keys()][0]!));

    const commandFor = (step: Step): Command | null => {
      switch (step.type) {
        case "open":
          return Command.cases.OpenReviewCheckout.make({
            checkoutId: CHECKOUT,
            workspaceId,
            subject: SUBJECT,
            head: headName(world.current.hostHead),
            base: "",
          });
        case "push":
          return Command.cases.ReportReviewHead.make({
            checkoutId: CHECKOUT,
            head: headName(world.current.hostHead),
            base: "",
          });
        case "update":
        case "updateDiscarding":
          return Command.cases.UpdateReviewCheckout.make({
            checkoutId: CHECKOUT,
            discardChanges: step.type === "updateDiscarding",
          });
        case "remove":
          return Command.cases.RemoveReviewCheckout.make({ checkoutId: CHECKOUT, reason: "user" });
        default:
          return null;
      }
    };

    let model: ModelSnapshot = {
      status: "active",
      output: undefined,
      error: undefined,
      checkout: undefined,
      world: initialWorld,
    };

    for (const [i, step] of steps.entries()) {
      const done = steps.slice(0, i + 1);
      const { next, rejection } = stepModel(model, step);
      world.current = worldStep(step, world.current);
      const command = commandFor(step);

      if (command !== null) {
        const refused = yield* dispatch(command).pipe(
          Effect.as(null),
          Effect.catchTag("CommandRejected", (error) => Effect.succeed(error.reason)),
          Effect.catchTag("NotFound", () => Effect.succeed("not found"))
        );

        expect(refused, describeSteps(done)).toBe(rejection);
      }

      yield* settle({ checkout: observe(next.checkout), world: next.world }, done);
      model = next;
    }

    yield* Scope.close(scope, Exit.void);
  });

describe("Review Checkout machine, model-based against the Engine", () => {
  const { states, transitions } = checkoutPaths();

  test("the model reaches every checkout state", () => {
    expect(states.length).toBeGreaterThan(10);
    expect(transitions.length).toBeGreaterThan(states.length);
  });

  test("every path to every model state", async () => {
    for (const steps of states) await Effect.runPromise(replay(steps));
  }, 120_000);

  test("every state-changing transition", async () => {
    for (const steps of transitions) await Effect.runPromise(replay(steps));
  }, 300_000);
});
