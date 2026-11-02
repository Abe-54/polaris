/**
 * The Reviewer end to end: the real Engine, store and Review Checkout git over
 * a local code host, with a fake Harness answering as the bench Reviewer does
 * (schema output on the first added line). The Rules are stubbed; their own
 * tests run the scanners.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  Command,
  DomainEvent,
  ReviewerSettings,
  ReviewSubject,
  SessionId,
  SessionPlacement,
  TurnId,
  type Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Layer, Option, Predicate, Stream } from "effect";
import { Engine } from "../engine/Engine.ts";
import { waitFor } from "../engine/testing.ts";
import { gitText } from "../git/git.ts";
import { publishPullRequest } from "../git/review/testing.ts";
import { commitAll, write } from "../git/testing.ts";
import { Rules } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { automaticRun, Reviewer } from "./index.ts";
import { REVIEWER_MARKER } from "./prompt.ts";
import { RULES_AFTER_TURN } from "./run.ts";
import { RULES_ONLY_NOTE } from "./settings.ts";
import {
  checkoutId,
  cleanupReviewerTests,
  context,
  dispatch,
  ended,
  GIT_WORK_MS,
  openReview,
  reviewerLayer,
  run,
  scenario,
  subject,
  summaryWhen,
  walked,
} from "./testing.ts";

afterEach(cleanupReviewerTests);

describe("the Reviewer", () => {
  test("reviews a pull request in its own read-only session, then answers a follow-up", async () => {
    const s = await scenario();
    const { layer, driver } = reviewerLayer({ ready: true });

    await run(
      layer,
      Effect.gen(function* () {
        const workspace = yield* openReview(s.user, s.v1);
        const reviewer = yield* Reviewer;

        const started = yield* reviewer.run({
          workspaceId: workspace.id,
          subject,
          checkoutId,
          since: null,
          refresh: false,
          context,
        });

        expect(started.status).toBe("running");

        const done = yield* summaryWhen(started.id, walked);
        expect(done.walkthrough?.head).toBe(s.v1);
        expect(done.walkthrough?.sessionId).not.toBe(done.reviewer?.sessionId);
        expect(done.walkthrough?.markdown).toContain("## Why the change");
        expect(done.walkthrough?.markdown).not.toContain("## Intent groups");
        expect(done.walkthrough?.groups?.flatMap((g) => g.paths).length).toBe(
          done.walkthrough?.filesTotal
        );
        expect(driver.latest(done.walkthrough!.sessionId!)?.options.readOnly).toBe(true);
        expect(done.deltaWalkthrough).toBeUndefined();
        expect(done.status).toBe("completed");
        expect(done.layers.rules.status).toBe("completed");
        expect(done.layers.agent.status).toBe("completed");
        expect(done.reviewer).toMatchObject({
          harness: "claude",
          model: "claude-opus-5-5",
          effort: "high",
        });
        expect(done.findings).toHaveLength(1);
        expect(done.findings[0]).toMatchObject({
          source: "agent",
          path: "feature.txt",
          lines: { start: 1, end: 1, side: "new" },
          severity: "medium",
        });

        // The session: in the checkout, titled, supervised; its approvals answered by policy.
        const sessionId = done.reviewer?.sessionId;
        expect(sessionId).toBeTruthy();
        const model = yield* (yield* EventStore).model;
        const record = model.sessions.get(sessionId!);
        expect(record?.session).toMatchObject({
          title: "Reviewer · Pull request #7",
          cwd: model.reviewCheckouts.get(checkoutId)?.path,
          permissionMode: "supervised",
          state: "idle",
        });
        const harness = driver.latest(sessionId!);
        expect(harness?.turns[0]?.prompt.startsWith(REVIEWER_MARKER)).toBe(true);
        expect(harness?.options.readOnly).toBe(true);
        expect(harness?.turns[0]?.prompt).toContain("Add the feature");
        expect(harness?.turns[0]?.prompt).toContain("+v1");
        expect(harness?.responses.map((r) => r.decision._tag).toSorted()).toEqual(["Deny", "Deny"]);

        const events = yield* (yield* EventStore).readEvents({
          after: 0,
          upTo: model.sequence,
          sessionId: sessionId!,
        });

        expect(events.some((e) => DomainEvent.guards.ApprovalRequested(e.event))).toBe(false);

        // The checkout records what was reviewed; a second run answers the cached summary.
        yield* waitFor(
          (m) => m.reviewCheckouts.get(checkoutId)?.reviewedHead === s.v1,
          GIT_WORK_MS
        );

        const again = yield* reviewer.run({
          workspaceId: workspace.id,
          subject,
          checkoutId,
          since: null,
          refresh: false,
          context,
        });

        expect(again.id).toBe(done.id);
        expect(again.walkthrough?.sessionId).toBe(done.walkthrough?.sessionId);
        const written = yield* reviewer.runWalkthrough(done.id, context);
        expect(written.walkthrough?.sessionId).toBe(done.walkthrough?.sessionId);
        expect(written.deltaWalkthrough).toBeUndefined();

        // A follow-up continues the same session and can withdraw the Finding.
        const finding = done.findings[0]!;
        const asked = yield* reviewer.ask(done.id, finding.id, "Is this real? Please withdraw it.");
        expect(asked.sessionId).toBe(sessionId!);

        const withdrawn = yield* summaryWhen(
          done.id,
          (summary) => summary.findings[0]?.status === "resolved"
        );

        expect(withdrawn.findings[0]?.resolution).toBe("withdrawn");
        expect(driver.latest(sessionId!)?.turns[1]?.prompt).toContain(finding.id);
      })
    );
  }, 60_000);

  /** Reviews v1, then pushes one more commit writing `file`, updates, and returns the incremental summary. */
  const reviewThenPush = (s: Awaited<ReturnType<typeof scenario>>, file: string, content: string) =>
    Effect.gen(function* () {
      const workspace = yield* openReview(s.user, s.v1);
      const reviewer = yield* Reviewer;

      const first = yield* reviewer.run({
        workspaceId: workspace.id,
        subject,
        checkoutId,
        since: null,
        refresh: false,
        context,
      });

      const done = yield* summaryWhen(first.id, ended);
      yield* waitFor((m) => m.reviewCheckouts.get(checkoutId)?.reviewedHead === s.v1, GIT_WORK_MS);
      const store = yield* EventStore;

      const next = yield* Effect.scoped(
        Effect.gen(function* () {
          const live = yield* store.subscribe({
            filter: (item) =>
              Predicate.isTagged(item, "Event") &&
              DomainEvent.guards.RiskSummaryStarted(item.envelope.event),
          });

          write(s.author, file, content);
          yield* Effect.promise(() => commitAll(s.author, `edit ${file}`));
          const v2 = yield* Effect.promise(() => publishPullRequest(s.forge, s.author, 7));
          yield* dispatch(Command.cases.ReportReviewHead.make({ checkoutId, head: v2, base: "" }));
          yield* dispatch(
            Command.cases.UpdateReviewCheckout.make({ checkoutId, discardChanges: false })
          );
          const item = yield* Stream.runHead(live);

          return Option.isSome(item) &&
            Predicate.isTagged(item.value, "Event") &&
            DomainEvent.guards.RiskSummaryStarted(item.value.envelope.event)
            ? item.value.envelope.event.summary
            : null;
        })
      );

      expect(next?.key.since).toBe(s.v1);

      return {
        done,
        incremental: yield* summaryWhen(
          next!.id,
          (value) => walked(value) && value.deltaWalkthrough?.state === "ready"
        ),
      };
    });

  test("new commits are reviewed on their own, in the same session, with earlier Findings carried", async () => {
    const s = await scenario();
    const { layer, driver } = reviewerLayer({ ready: true });

    await run(
      layer,
      Effect.gen(function* () {
        const { done, incremental } = yield* reviewThenPush(s, "second.txt", "added later\n");

        expect(incremental.status).toBe("completed");
        expect(incremental.findings.map((f) => [f.path, f.status, f.lines.start])).toEqual([
          ["second.txt", "open", 1],
          ["feature.txt", "open", 1],
        ]);
        expect(incremental.findings[1]?.id).toBe(done.findings[0]!.id);
        expect(incremental.reviewer?.sessionId).toBe(done.reviewer?.sessionId);
        const prompt = driver.latest(done.reviewer!.sessionId!)?.turns.at(-1)?.prompt ?? "";
        expect(prompt).toContain("Only the new changes");
        expect(prompt).not.toContain("+v1");
        const full = driver.latest(incremental.walkthrough!.sessionId!)?.turns[0]?.prompt ?? "";

        const delta =
          driver.latest(incremental.deltaWalkthrough!.sessionId!)?.turns[0]?.prompt ?? "";

        expect(full).toContain("+v1");
        expect(full).toContain("+added later");
        expect(delta).not.toContain("+v1");
        expect(delta).toContain("+added later");
        expect(delta).toContain(done.findings[0]!.id);
        expect(incremental.deltaWalkthrough?.fromHead).toBe(s.v1);
      })
    );
  }, 60_000);

  test("a Finding whose code a new commit changed is Resolved as fixed", async () => {
    const s = await scenario();
    const { layer } = reviewerLayer({ ready: true });

    await run(
      layer,
      Effect.gen(function* () {
        const { done, incremental } = yield* reviewThenPush(s, "feature.txt", "v2\n");
        const old = incremental.findings.find((f) => f.id === done.findings[0]!.id);

        expect(old).toMatchObject({ status: "resolved", resolution: "fixed" });
        expect(incremental.findings.filter((f) => f.status === "open").map((f) => f.path)).toEqual([
          "feature.txt",
        ]);
      })
    );
  }, 60_000);

  test("without a Reviewer the summary is Rules only, with a note", async () => {
    const s = await scenario();
    const { layer } = reviewerLayer({ ready: false });

    await run(
      layer,
      Effect.gen(function* () {
        const workspace = yield* openReview(s.user, s.v1);
        const reviewer = yield* Reviewer;

        const started = yield* reviewer.run({
          workspaceId: workspace.id,
          subject,
          checkoutId,
          since: null,
          refresh: false,
          context: null,
        });

        const done = yield* summaryWhen(started.id, ended);

        expect(done).toMatchObject({ status: "completed", reviewer: null, note: RULES_ONLY_NOTE });
        expect(done.layers.agent).toMatchObject({ status: "skipped", note: RULES_ONLY_NOTE });
        expect((yield* (yield* EventStore).model).sessions.size).toBe(0);
      })
    );
  }, 60_000);
});

describe("when it runs", () => {
  const openRequest = (workspace: Workspace, refresh: boolean) => ({
    workspaceId: workspace.id,
    subject,
    checkoutId,
    since: null,
    refresh,
    context,
  });

  test("over the Ask first threshold the rules run and the Reviewer waits for Run reviewer", async () => {
    const s = await scenario();
    const { layer, driver } = reviewerLayer({ ready: true });

    await run(
      layer,
      Effect.gen(function* () {
        const reviewer = yield* Reviewer;
        yield* reviewer.setSettings(
          ReviewerSettings.make({ default: null, workspaces: {}, askAboveLines: 0 })
        );
        const workspace = yield* openReview(s.user, s.v1);

        const waiting = yield* summaryWhen(
          (yield* reviewer.run(openRequest(workspace, false))).id,
          ended
        );

        expect(waiting.status).toBe("completed");
        expect(waiting.layers.rules.status).toBe("completed");
        expect(waiting.layers.agent.status).toBe("pending");
        expect(waiting.layers.agent.note).toContain("1 changed lines is over 0");
        // Waiting isn't "Reviewed by": no Reviewer is named until one runs.
        expect(waiting.reviewer).toBeNull();
        expect(waiting.walkthrough?.state).toBe("waiting");
        expect(driver.sessions).toHaveLength(0);

        // "Run reviewer": the user asks, so the threshold doesn't apply.
        const ran = yield* summaryWhen(
          (yield* reviewer.run(openRequest(workspace, true))).id,
          walked
        );

        expect(ran.id).not.toBe(waiting.id);
        expect(ran.layers.agent.status).toBe("completed");
        expect(ran.findings).toHaveLength(1);
      })
    );
  }, 60_000);

  test("a Reviewer whose Turn fails says so, and why", async () => {
    const s = await scenario();

    const { layer } = reviewerLayer({
      ready: true,
      reviewerFails: "gpt-6.1-sol isn't available on this plan",
    });

    await run(
      layer,
      Effect.gen(function* () {
        const reviewer = yield* Reviewer;
        const workspace = yield* openReview(s.user, s.v1);

        const done = yield* summaryWhen(
          (yield* reviewer.run(openRequest(workspace, false))).id,
          ended
        );

        expect(done.status).toBe("completed");
        expect(done.layers.agent.status).toBe("failed");
        expect(done.layers.agent.note).toBe(
          "The Reviewer's Turn failed: gpt-6.1-sol isn't available on this plan"
        );
        expect(done.reviewer?.sessionId).toBeTruthy();
      })
    );
  }, 60_000);

  test("with pull requests switched off the Reviewer is skipped unless asked", async () => {
    const s = await scenario();
    const { layer } = reviewerLayer({ ready: true });

    await run(
      layer,
      Effect.gen(function* () {
        const reviewer = yield* Reviewer;
        yield* reviewer.setSettings(
          ReviewerSettings.make({ default: null, workspaces: {}, onPullRequests: false })
        );
        const workspace = yield* openReview(s.user, s.v1);

        const off = yield* summaryWhen(
          (yield* reviewer.run(openRequest(workspace, false))).id,
          ended
        );

        expect(off.layers.agent.status).toBe("skipped");
        expect(off.layers.agent.note).toContain("doesn't run on pull requests by itself");
        expect(off.layers.rules.status).toBe("completed");
        expect(off.reviewer).toBeNull();

        const asked = yield* summaryWhen(
          (yield* reviewer.run(openRequest(workspace, true))).id,
          ended
        );

        expect(asked.layers.agent.status).toBe("completed");
      })
    );
  }, 60_000);
});

describe("the session's change, exactly", () => {
  test("commits landing between Turns stay out of the Rules and the Reviewer's diff", async () => {
    const s = await scenario();
    const seen: Array<string> = [];

    const rules = Layer.succeed(Rules)({
      run: (request) =>
        Effect.promise(async () => {
          seen.push(
            await gitText(request.cwd, ["diff", "--name-only", request.base, request.head])
          );

          return { findings: [], notes: [], ok: true };
        }),
    });

    const { layer, driver } = reviewerLayer({ ready: true, checkpoints: true, rules });

    await run(
      layer,
      Effect.gen(function* () {
        const reviewer = yield* Reviewer;
        yield* dispatch(Command.cases.RegisterWorkspace.make({ path: s.user, name: null }));

        const registered = yield* waitFor(
          (m) => [...m.workspaces.values()].some((w) => w.path === s.user),
          GIT_WORK_MS
        );
        // SAFETY: waitFor returned once a Workspace at `s.user` was registered.

        const workspace = [...registered.workspaces.values()].find(
          (w) => w.path === s.user
        ) as Workspace;

        const sessionId = SessionId.make("ses-scoped");

        const idle = waitFor((m) => {
          const record = m.sessions.get(sessionId);

          return record?.session.state === "idle" && record.turns.at(-1)?.status === "completed";
        }, GIT_WORK_MS);

        yield* dispatch(
          Command.cases.StartSession.make({
            sessionId,
            workspaceId: workspace.id,
            harness: "claude",
            placement: SessionPlacement.cases.InPlace.make({}),
            permissionMode: "auto",
            model: null,
            effort: null,
            prompt: "write a.txt",
            attachments: [],
          })
        );
        yield* idle;
        // Someone else commits to the branch while the session is idle.
        write(s.user, "other.ts", 'createHash("md5");\n');
        yield* Effect.promise(() => commitAll(s.user, "someone else's work"));
        yield* dispatch(
          Command.cases.SendTurn.make({ sessionId, prompt: "write b.txt", attachments: [] })
        );
        yield* waitFor((m) => (m.sessions.get(sessionId)?.turns.length ?? 0) === 2, GIT_WORK_MS);
        yield* idle;

        const summary = yield* reviewer.run({
          workspaceId: workspace.id,
          subject: ReviewSubject.cases.SessionTurns.make({
            sessionId,
            firstTurnId: null,
            lastTurnId: null,
          }),
          checkoutId: null,
          since: null,
          refresh: false,
          context: null,
        });

        const done = yield* summaryWhen(summary.id, ended);

        const prompt =
          driver.latest(done.reviewer?.sessionId ?? SessionId.make("none"))?.turns[0]?.prompt ?? "";

        // Each Turn's own Rules run, and the whole session's: never someone else's file.
        for (let i = 0; i < 100 && seen.length < 3; i++) yield* Effect.sleep("20 millis");
        expect(seen.toSorted()).toEqual(["a.txt", "a.txt\nb.txt", "b.txt"]);
        expect(prompt).toContain("+++ b/a.txt");
        expect(prompt).toContain("+++ b/b.txt");
        expect(prompt).not.toContain("other.ts");
        expect(done.findings.map((f) => f.path)).toEqual(["a.txt"]);
        expect(done.prompts?.map((entry) => entry.prompt)).toEqual(["write a.txt", "write b.txt"]);
        const complete = yield* summaryWhen(done.id, walked);
        const walkthrough = driver.latest(complete.walkthrough!.sessionId!)?.turns[0]?.prompt ?? "";
        expect(walkthrough).toContain("+++ b/a.txt");
        expect(walkthrough).toContain("+++ b/b.txt");
        expect(walkthrough).not.toContain("other.ts");
      })
    );
  }, 60_000);
});

describe("rules after every Turn", () => {
  test("a Turn that changed files gets a Rules-only summary; opening it in Review runs the Reviewer", async () => {
    const s = await scenario();
    const { layer } = reviewerLayer({ ready: true, checkpoints: true });

    await run(
      layer,
      Effect.gen(function* () {
        const store = yield* EventStore;
        const reviewer = yield* Reviewer;
        yield* dispatch(Command.cases.RegisterWorkspace.make({ path: s.user, name: null }));

        const registered = yield* waitFor(
          (m) => [...m.workspaces.values()].some((w) => w.path === s.user),
          GIT_WORK_MS
        );
        // SAFETY: waitFor returned once a Workspace at `s.user` was registered.

        const workspace = [...registered.workspaces.values()].find(
          (w) => w.path === s.user
        ) as Workspace;

        const sessionId = SessionId.make("ses-user");

        const nextSummary = (send: Effect.Effect<unknown, unknown, Engine>, within = 3_000) =>
          Effect.scoped(
            Effect.gen(function* () {
              const live = yield* store.subscribe({
                filter: (item) =>
                  Predicate.isTagged(item, "Event") &&
                  DomainEvent.guards.RiskSummaryStarted(item.envelope.event),
              });

              yield* send;
              const item = yield* Stream.runHead(live).pipe(Effect.timeoutOption(within));
              const value = Option.flatten(item);

              return Option.isSome(value) &&
                Predicate.isTagged(value.value, "Event") &&
                DomainEvent.guards.RiskSummaryStarted(value.value.envelope.event)
                ? value.value.envelope.event.summary
                : null;
            })
          );

        const first = yield* nextSummary(
          dispatch(
            Command.cases.StartSession.make({
              sessionId,
              workspaceId: workspace.id,
              harness: "claude",
              placement: SessionPlacement.cases.InPlace.make({}),
              permissionMode: "auto",
              model: null,
              effort: null,
              prompt: "write a.txt please",
              attachments: [],
            })
          ),
          GIT_WORK_MS
        );

        expect(first !== null && Predicate.isTagged(first.subject, "SessionTurns")).toBe(true);
        expect(first?.subject).toMatchObject({ sessionId });
        const rulesOnly = yield* summaryWhen(first!.id, ended);
        expect(rulesOnly.layers.rules.status).toBe("completed");
        expect(rulesOnly.layers.agent).toMatchObject({ status: "skipped", note: RULES_AFTER_TURN });

        // A Turn that changes nothing gets none.
        yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle", GIT_WORK_MS);

        const quiet = yield* nextSummary(
          dispatch(
            Command.cases.SendTurn.make({ sessionId, prompt: "just look around", attachments: [] })
          )
        );

        expect(quiet).toBeNull();

        // Opening that Turn in Review runs the Reviewer instead of answering the Rules-only summary.
        const opened = yield* reviewer.run({
          workspaceId: workspace.id,
          subject: first!.subject,
          checkoutId: null,
          since: null,
          refresh: false,
          context: null,
        });

        expect(opened.id).not.toBe(rulesOnly.id);
        const reviewed = yield* summaryWhen(opened.id, ended);
        expect(reviewed.layers.agent.status).toBe("completed");
        expect(reviewed.findings.map((f) => f.path)).toEqual(["a.txt"]);
      })
    );
  }, 60_000);
});

describe("automatic runs", () => {
  test("accepting Turns reviews the session through the accepted Turn", () => {
    const event = DomainEvent.cases.TurnsAccepted.make({
      sessionId: SessionId.make("ses-1"),
      throughTurnId: TurnId.make("turn-3"),
      throughIndex: 2,
      revertLaterTurns: false,
      acceptedBy: "MacBook",
    });

    const request = automaticRun(
      event,
      () => undefined,
      () => WorkspaceId.make("ws-1")
    );

    expect(request?.subject).toEqual(
      ReviewSubject.cases.SessionTurns.make({
        sessionId: SessionId.make("ses-1"),
        firstTurnId: null,
        lastTurnId: TurnId.make("turn-3"),
      })
    );
    expect(
      automaticRun(
        event,
        () => undefined,
        () => null
      )
    ).toBeNull();
  });
});
