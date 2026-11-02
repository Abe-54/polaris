/**
 * The Reviewer end to end for tests: the real Engine, store and Review Checkout git over a local
 * code host, with a fake Harness answering as the bench Reviewer does. The Rules are stubbed.
 */
import { join } from "node:path";
import {
  Command,
  HarnessAvailability,
  HostHarnesses,
  PullRequestRef,
  type RiskSummary,
  type RiskSummaryId,
  ReviewCheckoutId,
  ReviewContext,
  ReviewSubject,
  RiskSummaryRef,
  RequestId,
  TurnItem,
  type Workspace,
} from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { Engine } from "../engine/Engine.ts";
import {
  cid,
  completesTurns,
  engineLayer,
  type FakeDriver,
  type FakeHarnessSession,
  tempDir,
  waitFor,
} from "../engine/testing.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- test support: the Engine's fakes have no Layer.
import { makeFakeDriver, makeFakes } from "../engine/testing.ts";
import { CheckpointsLive } from "../git/Checkpoints.ts";
import { ReviewCheckoutGitLive } from "../git/ReviewCheckoutGit.ts";
import {
  BASE_REPO,
  contributor,
  createForge,
  publishPullRequest,
  userClone,
} from "../git/review/testing.ts";
import { commitAll, removeTempDirSettled, write } from "../git/testing.ts";
import { Availability } from "../harness/availability/index.ts";
import { benchReviewReply, isReviewerPrompt } from "../harness/bench/review.ts";
import { HarnessEvent, type HarnessDriver, type TurnInput } from "../harness/HarnessDriver.ts";
import { Rules } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { Reviewer, ReviewerLive, ReviewerPolicyLive, ReviewerSessions } from "./index.ts";

export type Env = Engine | EventStore | Reviewer;

const cleanup: Array<string> = [];

/** Removes what the tests made; run it after each test. */
export const cleanupReviewerTests = async () => {
  for (const dir of cleanup.splice(0)) await removeTempDirSettled(dir);
};

/** A command the Reviewer ran: what it printed and how it exited. */
export interface ReviewerCommand {
  readonly output: string;
  readonly exitCode: number;
}

const commandRan = (input: TurnInput, { output, exitCode }: ReviewerCommand, i: number) =>
  HarnessEvent.ItemCompleted({
    turnId: input.turnId,
    item: TurnItem.cases.CommandExecution.make({
      id: `cmd-${input.turnId}-${i}`,
      command: "git log --oneline -5",
      cwd: "/repo",
      output,
      exitCode,
      status: exitCode === 0 ? "completed" : "failed",
    }),
  });

/**
 * The Reviewer's Turn: two approvals (one allowed, one not), then the bench reply; `commands`
 * ran before it.
 */
export const reviewerTurn = (input: TurnInput, commands: ReadonlyArray<ReviewerCommand> = []) => [
  HarnessEvent.CursorAssigned({ cursor: "reviewer-cursor" }),
  HarnessEvent.TurnStarted({ turnId: input.turnId, prompt: input.prompt }),
  ...commands.map((command, i) => commandRan(input, command, i)),
  HarnessEvent.ApprovalRequested({
    turnId: input.turnId,
    requestId: RequestId.make(`ok-${input.turnId}`),
    kind: "command",
    title: "Show the diff",
    detail: "git diff HEAD~1 --stat",
    options: [],
  }),
  HarnessEvent.ApprovalRequested({
    turnId: input.turnId,
    requestId: RequestId.make(`no-${input.turnId}`),
    kind: "file-change",
    title: "Edit a file",
    detail: "feature.txt",
    options: [],
  }),
  HarnessEvent.ItemCompleted({
    turnId: input.turnId,
    item: TurnItem.cases.AssistantMessage.make({
      id: `msg-${input.turnId}`,
      text: benchReviewReply(input.prompt),
    }),
  }),
  HarnessEvent.TurnEnded({ turnId: input.turnId, status: "completed", error: null }),
];

export const availability = (ready: boolean) =>
  Layer.succeed(Availability)({
    get: () =>
      Effect.succeed(
        HostHarnesses.make({
          harnesses: [
            HarnessAvailability.make({
              harness: "claude",
              status: ready ? "ready" : "not-installed",
              version: null,
              minVersion: "0.0.0",
              olderThanTested: null,
              signInKind: null,
              signInArgv: [],
              detail: null,
            }),
          ],
          checkedAt: new Date(0).toISOString(),
        })
      ),
    changes: Stream.empty,
  });

export const noRules = Layer.succeed(Rules)({
  run: () => Effect.succeed({ findings: [], notes: [], ok: true }),
});

/** A user's Turn: "write <file>" writes it in the session's directory first. */
export const userTurn = (input: TurnInput, session: FakeHarnessSession) => {
  const file = /^write (\S+)/.exec(input.prompt)?.[1];

  if (file !== undefined) write(session.options.cwd, file, `written by ${input.turnId}\n`);

  return completesTurns()(input);
};

export const reviewerLayer = (options: {
  readonly ready: boolean;
  readonly checkpoints?: boolean;
  readonly rules?: Layer.Layer<Rules>;
  /** The Reviewer's Turns fail with this error. */
  readonly reviewerFails?: string;
  /** Commands the Reviewer runs before it replies as usual. */
  readonly reviewerCommands?: ReadonlyArray<ReviewerCommand>;
  /** Opens sessions in place of the fake's: another driver's, which may fail. */
  readonly open?: HarnessDriver["open"];
}) => {
  const dir = tempDir();
  cleanup.push(dir);

  const fake = makeFakeDriver("claude", {
    onTurn: (input, session) =>
      isReviewerPrompt(input.prompt)
        ? options.reviewerFails === undefined
          ? reviewerTurn(input, options.reviewerCommands)
          : [
              HarnessEvent.TurnStarted({ turnId: input.turnId, prompt: input.prompt }),
              HarnessEvent.TurnEnded({
                turnId: input.turnId,
                status: "failed",
                error: options.reviewerFails,
              }),
            ]
        : userTurn(input, session),
  });

  const driver: FakeDriver =
    options.open === undefined ? fake : { ...fake, driver: { ...fake.driver, open: options.open } };

  const base = {
    filename: join(dir, "state.sqlite"),
    fakes: makeFakes(),
    drivers: [driver],
    reviewCheckoutGit: ReviewCheckoutGitLive,
  };

  const engine = (
    options.checkpoints === true
      ? engineLayer({ ...base, checkpoints: CheckpointsLive })
      : engineLayer(base)
  ).pipe(Layer.provide(ReviewerPolicyLive), Layer.provideMerge(ReviewerSessions.layer));

  const layer = ReviewerLive({ settingsPath: join(dir, "reviewer-settings.json") }).pipe(
    Layer.provideMerge(engine),
    Layer.provide(
      Layer.mergeAll(options.rules ?? noRules, ReviewCheckoutGitLive, availability(options.ready))
    )
  );

  return { layer, driver };
};

export const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

export const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "MacBook" })
  );

/** A Turn or a checkout here runs real git (a Turn's checkpoints, ~25 calls on first contact). */
export const GIT_WORK_MS = 15_000;

export const checkoutId = ReviewCheckoutId.make("rc-7");

export const subject = ReviewSubject.cases.PullRequest.make({
  pullRequest: new PullRequestRef({ repo: BASE_REPO, number: 7 }),
  baseRef: "main",
});

export const context = ReviewContext.make({ title: "Add the feature", body: "Adds feature.txt." });

export const scenario = async () => {
  const forge = await createForge();
  const author = await contributor(forge, forge.mainCommits[1] ?? "main");
  write(author, "feature.txt", "v1\n");
  await commitAll(author, "feature v1");
  const v1 = await publishPullRequest(forge, author, 7);
  const user = await userClone(forge);
  cleanup.push(forge.root, user, `${user}.worktrees`, author);

  return { forge, author, user, v1 };
};

export const openReview = (user: string, head: string) =>
  Effect.gen(function* () {
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: user, name: null }));

    const model = yield* waitFor(
      (m) => [...m.workspaces.values()].some((w) => w.path === user),
      GIT_WORK_MS
    );

    // SAFETY: waitFor returned once a Workspace at `user` was registered.
    const workspace = [...model.workspaces.values()].find((w) => w.path === user) as Workspace;
    yield* dispatch(
      Command.cases.OpenReviewCheckout.make({
        checkoutId,
        workspaceId: workspace.id,
        subject,
        head,
        base: "",
      })
    );
    yield* waitFor((m) => m.reviewCheckouts.get(checkoutId)?.state === "ready", GIT_WORK_MS);

    return workspace;
  });

/** The summary once `done` holds, polled from the store. */
export const summaryWhen = (summaryId: RiskSummaryId, done: (summary: RiskSummary) => boolean) =>
  Effect.gen(function* () {
    const store = yield* EventStore;

    for (let i = 0; i < 750; i++) {
      const summary = yield* store.review.riskSummary(
        RiskSummaryRef.cases.ById.make({ summaryId })
      );

      if (summary !== null && done(summary)) return summary;
      yield* Effect.sleep("20 millis");
    }

    return yield* Effect.die(new Error(`summary ${summaryId} never got there`));
  });

export const ended = (summary: RiskSummary) => summary.status !== "running";

export const walked = (summary: RiskSummary) =>
  ended(summary) && summary.walkthrough?.state === "ready";
