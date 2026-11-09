/** A walkthrough uses the Reviewer's read-only policy in its own Agent Session. */
import {
  Command,
  CommandId,
  DomainEvent,
  ReviewerChoice,
  type ReviewerSettings,
  type RiskSummary,
  RiskSummaryRef,
  type SessionId,
  Walkthrough,
} from "@polaris/protocol";
import { Cause, Clock, Effect, Result } from "effect";
import { interruptibleGitPromise } from "../git/interrupt.ts";
import { Engine } from "../engine/Engine.ts";
import { EventStore } from "../store/EventStore.ts";
import { reviewerCost } from "./cost.ts";
import { previousSummary } from "./merge.ts";
import { readDiff } from "./diff.ts";
import { generatedPaths } from "./generated.ts";
import { parseGroups, splitGroups } from "./groups.ts";
import { readInstructions } from "./instructions.ts";
import { reviewerShell } from "./policy.ts";
import { type ReviewRange, resolveRange } from "./range.ts";
import { continueReviewerSession, startReviewerSession } from "./session.ts";
import { groupsRepairPrompt, walkthroughProblem, walkthroughPrompt } from "./walkthroughPrompt.ts";

export const walkthroughChoice = (
  settings: ReviewerSettings,
  reviewer: ReviewerChoice | null
): ReviewerChoice | null => {
  const separate = settings.walkthrough;
  const harness = separate?.harness ?? reviewer?.harness;

  if (harness === undefined) return null;

  return ReviewerChoice.make({
    harness,
    model: separate?.model ?? reviewer?.model ?? null,
    effort: separate?.effort ?? reviewer?.effort ?? null,
  });
};

export const initialWalkthrough = (
  head: string,
  choice: ReviewerChoice | null,
  options: {
    readonly off: boolean;
    readonly waiting: boolean;
    readonly lines: number;
    readonly files: number;
    readonly fromHead?: string | null;
  }
) =>
  Walkthrough.make({
    state: options.off
      ? "off"
      : choice === null
        ? "failed"
        : options.waiting
          ? "waiting"
          : "writing",
    markdown: "",
    head,
    fromHead: options.fromHead ?? null,
    fullSummaryId: null,
    harness: choice?.harness ?? null,
    model: choice?.model ?? null,
    effort: choice?.effort ?? null,
    sessionId: null,
    lines: options.lines,
    tokensEstimate: null,
    filesRead: 0,
    filesTotal: options.files,
    startedAt: null,
    durationMs: null,
    tokens: null,
    reason:
      !options.off && choice === null ? "No walkthrough Harness is available on this Host." : null,
    evidence: null,
  });

export const storeWalkthrough = (summary: RiskSummary, value: Walkthrough, delta: boolean) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const metadata = delta ? { deltaWalkthrough: value } : { walkthrough: value };

    const atHead = yield* store.review.riskSummariesAt(summary.key.repo, summary.key.head, 30);

    const targets = atHead.filter(
      (candidate) =>
        candidate.key.mergeBase === summary.key.mergeBase &&
        (!delta || candidate.key.since === summary.key.since)
    );

    if (!targets.some((candidate) => candidate.id === summary.id)) targets.push(summary);

    const events = targets.map((candidate) =>
      DomainEvent.cases.RiskSummaryLayerChanged.make({
        summaryId: candidate.id,
        layer: "agent",
        run: candidate.layers.agent,
        ...metadata,
      })
    );

    yield* store
      .commit({ commandId: null, decide: () => Effect.succeed(events) })
      .pipe(Effect.orDie);
  });

const changed = (value: Walkthrough, change: Partial<Walkthrough>) =>
  Walkthrough.make({
    state: value.state,
    markdown: value.markdown,
    head: value.head,
    fromHead: value.fromHead,
    fullSummaryId: value.fullSummaryId,
    harness: value.harness,
    model: value.model,
    effort: value.effort,
    sessionId: value.sessionId,
    lines: value.lines,
    tokensEstimate: value.tokensEstimate,
    filesRead: value.filesRead,
    filesTotal: value.filesTotal,
    startedAt: value.startedAt,
    durationMs: value.durationMs,
    tokens: value.tokens,
    reason: value.reason,
    evidence: value.evidence,
    ...change,
  });

/** `change` applied, keeping the groups unless it replaces them. */
export const changeWalkthrough = (value: Walkthrough, change: Partial<Walkthrough>) =>
  value.groups === undefined
    ? changed(value, change)
    : changed(value, { groups: value.groups, ...change });

const latestSummary = (summary: RiskSummary) =>
  Effect.flatMap(EventStore, (store) =>
    store.review.riskSummary(RiskSummaryRef.cases.ById.make({ summaryId: summary.id }))
  );

export const walkthroughKey = (summary: RiskSummary, value: Walkthrough, delta: boolean) =>
  `${summary.key.repo}:${summary.key.mergeBase}:${value.head}:${delta ? value.fromHead : "full"}`;

/** One repair Turn for groups that didn't decode or cover the change; null when it fails too. */
const repairGroups = (sessionId: SessionId, problem: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repaired = yield* continueReviewerSession(sessionId, groupsRepairPrompt(problem));
    const text = repaired.reply ?? "";
    const again = parseGroups(splitGroups(text).block ?? text, paths);

    return Result.isSuccess(again) ? again.success : null;
  }).pipe(Effect.catchCause(() => Effect.succeed(null)));

const runOne = (
  summary: RiskSummary,
  range: ReviewRange,
  initial: Walkthrough,
  context: string,
  delta: boolean,
  active: Set<string>
) =>
  Effect.gen(function* () {
    if (initial.state !== "writing" || initial.harness === null) return;
    const key = walkthroughKey(summary, initial, delta);

    if (active.has(key)) return;
    active.add(key);
    const choice = { harness: initial.harness, model: initial.model, effort: initial.effort };
    const store = yield* EventStore;
    const engine = yield* Engine;
    const started = yield* Clock.currentTimeMillis;
    let current = changeWalkthrough(initial, { startedAt: new Date(started).toISOString() });
    let sections = 0;

    const save = (next: Walkthrough) =>
      Effect.gen(function* () {
        const latest = yield* latestSummary(summary);
        const stored = delta ? latest?.deltaWalkthrough : latest?.walkthrough;

        if (stored?.state === "failed" && stored.reason === "The walkthrough was stopped.") return;
        current = next;
        yield* storeWalkthrough(summary, next, delta);
      });

    const before = yield* latestSummary(summary);
    const stored = delta ? before?.deltaWalkthrough : before?.walkthrough;

    if (stored?.state === "failed" && stored.reason === "The walkthrough was stopped.") {
      active.delete(key);

      return;
    }

    yield* save(current);

    const work = Effect.gen(function* () {
      const diff = yield* interruptibleGitPromise(() =>
        readDiff(range.cwd, range.base, range.head)
      );

      yield* save(changeWalkthrough(current, { filesTotal: diff.files.length }));

      const instructions = yield* interruptibleGitPromise(() =>
        readInstructions({ cwd: range.cwd, head: range.head, repo: range.key.repo })
      );

      const generated = yield* interruptibleGitPromise(() =>
        generatedPaths({
          root: range.cwd,
          at: range.rulesAt,
          repo: range.key.repo,
          paths: diff.files.map((f) => f.path),
        })
      );

      const fresh = yield* latestSummary(summary);
      const previous = yield* previousSummary(range);
      const open = [...(fresh?.findings ?? []), ...(previous?.findings ?? [])];

      const prompt = walkthroughPrompt({
        title: range.title,
        base: range.base,
        head: range.head,
        fromHead: initial.fromHead,
        diff,
        generated,
        context,
        findings: open,
        instructions: instructions.text ?? "",
        shell: reviewerShell(choice.harness),
      });

      const outcome = yield* startReviewerSession({
        workspaceId: range.workspaceId,
        checkoutId: range.checkoutId,
        choice,
        title: `Walkthrough · ${range.title}${delta ? " · new commits" : ""}`,
        origin: "walkthrough",
        subject: summary.subject,
        prompt,
        onStarted: (sessionId) =>
          Effect.gen(function* () {
            const latest = yield* latestSummary(summary);
            const stored = delta ? latest?.deltaWalkthrough : latest?.walkthrough;

            if (stored?.state === "failed" && stored.reason === "The walkthrough was stopped.") {
              yield* (yield* Engine)
                .dispatch({
                  commandId: CommandId.make(`cmd_${crypto.randomUUID()}`),
                  command: Command.cases.Interrupt.make({ sessionId }),
                  deviceLabel: "Walkthrough",
                })
                .pipe(Effect.ignore);

              return;
            }

            yield* save(changeWalkthrough(current, { sessionId }));
          }).pipe(Effect.provideService(EventStore, store), Effect.provideService(Engine, engine)),
        onAssistant: (markdown) => {
          const count = [...markdown.matchAll(/^## /gm)].length;

          if (count <= sections) return Effect.void;
          sections = count;

          return save(
            changeWalkthrough(current, { markdown: splitGroups(markdown).markdown })
          ).pipe(Effect.provideService(EventStore, store));
        },
      });

      const reply = splitGroups(outcome.reply ?? "");

      const problem =
        outcome.status === "completed"
          ? walkthroughProblem(reply.markdown)
          : (outcome.error ?? "The walkthrough Turn did not complete.");

      if (problem !== null) {
        yield* save(
          changeWalkthrough(current, {
            state: "failed",
            reason: problem,
            evidence: outcome.error,
            sessionId: outcome.sessionId,
          })
        );

        return;
      }

      const cost = yield* reviewerCost(
        choice.harness,
        outcome.sessionId,
        current.startedAt ?? summary.startedAt
      ).pipe(Effect.catchCause(() => Effect.succeed(null)));

      const finished = yield* Clock.currentTimeMillis;
      const paths = diff.files.map((f) => f.path);
      const first = parseGroups(reply.block, paths);

      const ready = changeWalkthrough(current, {
        state: "ready",
        markdown: reply.markdown,
        sessionId: outcome.sessionId,
        durationMs: finished - started,
        tokens: cost?.tokens ?? null,
      });

      if (Result.isSuccess(first)) {
        yield* save(changeWalkthrough(ready, { groups: first.success }));

        return;
      }

      yield* save(ready);
      const groups = yield* repairGroups(outcome.sessionId, first.failure, paths);

      if (groups !== null) yield* save(changeWalkthrough(current, { groups }));
    });

    yield* work.pipe(
      Effect.catchCause((cause) =>
        save(
          changeWalkthrough(current, {
            state: "failed",
            reason: String(Cause.squash(cause)),
            evidence: null,
          })
        )
      ),
      Effect.ensuring(Effect.sync(() => active.delete(key)))
    );
  });

export const runWalkthroughs = (
  summary: RiskSummary,
  range: ReviewRange,
  context: string,
  active: Set<string>
) =>
  Effect.gen(function* () {
    const full = summary.walkthrough;
    const delta = summary.deltaWalkthrough;

    const fullRange =
      range.key.since === null
        ? range
        : yield* resolveRange(summary.subject, summary.checkoutId, null);

    yield* Effect.all(
      [
        full === undefined ? Effect.void : runOne(summary, fullRange, full, context, false, active),
        delta === undefined
          ? Effect.void
          : runOne(
              summary,
              { ...range, base: delta.fromHead ?? range.base, head: range.key.head },
              delta,
              context,
              true,
              active
            ),
      ],
      { concurrency: "unbounded" }
    );
  });

export const stopWalkthroughs = (summary: RiskSummary) =>
  Effect.gen(function* () {
    const engine = yield* Engine;

    for (const [value, delta] of [
      [summary.walkthrough, false],
      [summary.deltaWalkthrough, true],
    ] as const) {
      if (value?.state !== "writing") continue;

      if (value.sessionId !== null)
        yield* engine
          .dispatch({
            commandId: CommandId.make(`cmd_${crypto.randomUUID()}`),
            command: Command.cases.Interrupt.make({ sessionId: value.sessionId }),
            deviceLabel: "Walkthrough",
          })
          .pipe(Effect.ignore);
      yield* storeWalkthrough(
        summary,
        changeWalkthrough(value, {
          state: "failed",
          reason: "The walkthrough was stopped.",
          evidence: null,
        }),
        delta
      );
    }
  });

/** Explicit Write / Retry starts an unfinished walkthrough; a ready head remains cached. */
export const requestWalkthroughs = (
  summary: RiskSummary,
  choice: ReviewerChoice | null,
  active: ReadonlySet<string>
) =>
  Effect.gen(function* () {
    for (const [value, delta] of [
      [summary.walkthrough, false],
      [summary.deltaWalkthrough, true],
    ] as const) {
      if (delta && summary.key.since === null) continue;

      if (
        value?.state === "ready" ||
        (value?.state === "writing" && active.has(walkthroughKey(summary, value, delta)))
      )
        continue;

      const next = initialWalkthrough(summary.key.head, choice, {
        off: false,
        waiting: false,
        lines: value?.lines ?? 0,
        files: value?.filesTotal ?? 0,
        fromHead: delta ? summary.key.since : null,
      });

      yield* storeWalkthrough(summary, next, delta);
    }

    return (yield* latestSummary(summary)) ?? summary;
  });

/** Interrupted by a Daemon restart: keep partial Markdown, require an explicit Retry. */
export const recoverWalkthroughs = () =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const interrupted = yield* store.review.writingWalkthroughs();

    for (const summary of interrupted) {
      for (const [value, delta] of [
        [summary.walkthrough, false],
        [summary.deltaWalkthrough, true],
      ] as const) {
        if (value?.state !== "writing") continue;

        yield* storeWalkthrough(
          summary,
          changeWalkthrough(value, {
            state: "failed",
            reason: "The Daemon restarted before the walkthrough finished. Retry to continue.",
            evidence: null,
          }),
          delta
        );
      }
    }
  });
