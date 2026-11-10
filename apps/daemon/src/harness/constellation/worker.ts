import {
  type Attempt,
  type Claim,
  type ConstellationId,
  HarnessSelection,
  type HarnessKind,
  type ModelId,
  type PermissionMode,
  type ReasoningEffort,
  type ServiceTier,
  type TaskDefinition,
  type WorkspaceId,
} from "@polaris/protocol";
import { type Effect, Predicate } from "effect";
import type { HarnessError } from "../HarnessDriver.ts";
import { McpBinding } from "../../mcp/binding.ts";
import type { ConstellationAttachment } from "./attachment.ts";

export interface WorkerSelection {
  readonly harness: HarnessKind;
  readonly model: ModelId | null;
  readonly effort: ReasoningEffort | null;
  /** Null for the Harness default; always null on a Harness without tiers. */
  readonly serviceTier?: ServiceTier | null;
}

/** Only Codex has service tiers; the engine's decider clears them elsewhere too. */
export const hasServiceTier = (harness: HarnessKind) => harness === "codex";

/** A model or effort from another Harness's defaults cannot cross a Harness override. */
interface SelectionFields {
  harness: HarnessKind;
  model?: ModelId;
  effort?: ReasoningEffort;
  serviceTier?: ServiceTier | null;
}

export const selectWorker = (
  dispatch: HarnessSelection | null,
  task: HarnessSelection | null,
  defaults: HarnessSelection | null,
  user: WorkerSelection
): WorkerSelection & { readonly serviceTier: ServiceTier | null } => {
  const fallback: SelectionFields = {
    harness: user.harness,
  };

  if (user.model !== null) fallback.model = user.model;

  if (user.effort !== null) fallback.effort = user.effort;

  if (user.serviceTier != null) fallback.serviceTier = user.serviceTier;
  const choices = [dispatch, task, defaults, new HarnessSelection(fallback)];
  const harness = choices.find((choice) => choice?.harness !== undefined)?.harness ?? user.harness;

  const compatible = choices.filter(
    (choice) => choice !== null && (choice.harness === undefined || choice.harness === harness)
  );

  const serviceTier =
    compatible.find((choice) => choice?.serviceTier !== undefined)?.serviceTier ?? null;

  return {
    harness,
    model: compatible.find((choice) => choice?.model !== undefined)?.model ?? null,
    effort: compatible.find((choice) => choice?.effort !== undefined)?.effort ?? null,
    serviceTier: hasServiceTier(harness) ? serviceTier : null,
  };
};

/** The tier the Lead asked for that the chosen Harness can't run: the dispatch result names it. */
export const ignoredServiceTier = (
  dispatch: HarnessSelection | null,
  task: HarnessSelection | null,
  defaults: HarnessSelection | null,
  user: WorkerSelection
): { readonly harness: HarnessKind; readonly serviceTier: ServiceTier } | null => {
  const { harness } = selectWorker(dispatch, task, defaults, user);

  if (hasServiceTier(harness)) return null;

  const serviceTier = [dispatch, task, defaults].find(
    (choice) =>
      choice != null &&
      choice.serviceTier != null &&
      (choice.harness === undefined || choice.harness === harness)
  )?.serviceTier;

  return serviceTier == null ? null : { harness, serviceTier };
};

export interface WorkerAssignment {
  readonly constellationId: ConstellationId;
  readonly workspaceId: WorkspaceId;
  readonly task: TaskDefinition;
  readonly attempt: Attempt;
  readonly acceptedDeps: ReadonlyArray<{
    readonly taskId: TaskDefinition["id"];
    readonly claim: Claim;
  }>;
  readonly selection: WorkerSelection;
  readonly permissionMode: PermissionMode;
  readonly feedback?: string;
  readonly feedbackFrom?: "user";
  readonly rejectedClaim?: Claim;
}

export const workerBrief = (assignment: WorkerAssignment): string => {
  const { task, attempt } = assignment;

  const deps = assignment.acceptedDeps
    .map((dep) => `${dep.taskId}: ${JSON.stringify(dep.claim)}`)
    .join("\n");

  return [
    "Polaris assignment",
    `Task: ${task.id} · ${task.title}`,
    `Attempt: ${attempt.id}`,
    `Area: ${task.area.length === 0 ? "No paths declared; report paths outside the assignment." : task.area.join(", ")}`,
    `Worktree: ${attempt.worktree}`,
    `Branch: ${attempt.branch}`,
    `Base: ${attempt.base}`,
    "Accepted dependency Claims:",
    deps || "None.",
    `Criteria:\n${task.criteria.map((criterion) => `- ${criterion}`).join("\n") || "See the brief."}`,
    "How to claim: commit on the assigned branch, leave no uncommitted changes, then call claim with branch, head, commits, receipts, notDone, followups, questions, outsideArea, decisions and summary. A Claim goes to review; the lead accepts it after merging and checking its head.",
    assignment.rejectedClaim === undefined
      ? ""
      : `${Predicate.isTagged(attempt.cause, "SentBack") || Predicate.isTagged(attempt.cause, "MergeConflict") ? "Sent-back Claim" : "Previous Attempt's Claim"}:\n${JSON.stringify(assignment.rejectedClaim)}`,
    assignment.feedback === undefined
      ? ""
      : `${Predicate.isTagged(attempt.cause, "SentBack") || Predicate.isTagged(attempt.cause, "MergeConflict") ? `Review feedback${assignment.feedbackFrom === "user" ? " from the user" : ""}` : "Previous Attempt"}:\n${assignment.feedback}`,
    assignment.rejectedClaim === undefined
      ? ""
      : "A head that was sent back cannot be claimed again as corrected: commit the fix, or add a decision naming that head and why it stands.",
    "When blocked: continue independent work first; use block { on: [Task ids], reason } to wait for acceptance, or on: [] to wait for the Lead. End your Turn after blocking. Use ask for a decision or answer. Acceptance or a Lead message resumes a blocked Attempt.",
    "Brief:",
    task.brief,
  ]
    .filter((line) => line !== "")
    .join("\n\n");
};

export interface WorkerStart {
  readonly assignment: WorkerAssignment;
  readonly title: string;
  readonly prompt: string;
  readonly attachment: ConstellationAttachment;
}

export interface WorkerStartup<R = never, S = R> {
  readonly attach: (binding: McpBinding) => Effect.Effect<ConstellationAttachment, HarnessError, R>;
  /** Commit the title and submit prompt as the first Turn through the Agent Session machine. */
  readonly startSession: (start: WorkerStart) => Effect.Effect<void, HarnessError, S>;
}
