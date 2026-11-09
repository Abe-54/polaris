import { basename } from "node:path";
import {
  AgentSession,
  Attempt,
  AttemptCause,
  AttemptId,
  CommandId,
  type Constellation,
  DomainEvent,
  SessionId,
  Workspace,
  type HostId,
  type PermissionMode,
  type TaskDefinition,
} from "@polaris/protocol";
import { pickCelestial } from "../../store/celestial.ts";
import type { ReadModel } from "../../store/model.ts";
import { Effect, Predicate } from "effect";
import { decideSession } from "../../engine/session.ts";
import { selectWorker } from "../../harness/constellation/index.ts";
import { EventStore } from "../../store/EventStore.ts";
import { HarnessRegistry } from "../../services.ts";
import { finding, refusal } from "../decision.ts";
import { exceedsCeiling, workerMode } from "../permissionCeiling.ts";
import { WorktreeSetupService, type WorktreeSetupUntrusted } from "../setup/index.ts";
import { startupSetupIntent } from "./startupSetup.ts";
import type { WorkerPreparation } from "../transfers/prepareWorkers.ts";

export const BUILT_IN = { harness: "codex", model: null, effort: null } as const;

/** The Constellation's default selection for a Task's group (ui and design, or backend). */
export const taskDefaults = (graph: Constellation, task: TaskDefinition) =>
  task.group === "ui" || task.group === "design"
    ? (graph.settings.ui ?? graph.settings.defaults)
    : (graph.settings.backend ?? graph.settings.defaults);

/** A reused Session broader than the Lead's permission mode is refused before any Attempt. */
const withinCeiling = (
  model: ReadModel,
  input: WorkerPreparation,
  existing: AgentSession | undefined,
  ceiling: PermissionMode | null
) =>
  existing === undefined || ceiling === null || !exceedsCeiling(existing.permissionMode, ceiling)
    ? Effect.void
    : Effect.fail(
        refusal(model.constellations.get(input.graph.id), [
          finding(
            "E-PERMISSION-CEILING",
            `Session ${existing.id} runs ${existing.permissionMode}, broader than the Lead's ${ceiling}`,
            `Lower that Session's permission mode to ${ceiling} or narrower, or dispatch to a new Session.`
          ),
        ])
      );

/** No setup command runs in a Workspace the user hasn't trusted on this Host; dispatch says so. */
const untrusted = (model: ReadModel, input: WorkerPreparation, error: WorktreeSetupUntrusted) =>
  Effect.fail(
    refusal(model.constellations.get(input.graph.id), [
      finding(
        "E-SETUP-TRUST",
        `Worktree setup can't run: ${error.workspace} isn't trusted on this host`,
        `Trust ${error.workspace} from the editor (⌘⇧P), or set its worktree setup to None in Settings, then dispatch again.`
      ),
    ])
  );

/** Provision only the Session; the committed Attempt's acquired startup hook owns its first Turn. */
export const prepareSession = Effect.fn("Constellation.prepareSession")(function* (
  input: WorkerPreparation,
  hostId: HostId
) {
  const store = yield* EventStore;
  const at = new Date().toISOString();
  const model = yield* store.model;
  const lead = model.sessions.get(input.graph.leadSessionId)?.session;

  const sessionId =
    input.task.kind === "gate"
      ? input.graph.leadSessionId
      : Predicate.isTagged(input.placement, "Existing")
        ? input.placement.sessionId
        : SessionId.make(`${input.key}:worker`);

  const existing = model.sessions.get(sessionId)?.session;

  const selection = selectWorker(
    Predicate.isTagged(input.placement, "New") ? input.placement.selection : null,
    input.task.suggested,
    taskDefaults(input.graph, input.task),
    existing ?? lead ?? BUILT_IN
  );

  if (existing?.state === "archived")
    return yield* refusal(model.constellations.get(input.graph.id), [
      finding("E-SESSION", "The selected Session is archived", "Choose an active Session."),
    ]);

  const ceiling = lead?.permissionMode ?? input.leadPermissionMode ?? null;

  yield* withinCeiling(model, input, existing, ceiling);

  const session =
    existing ??
    new AgentSession({
      id: sessionId,
      workspaceId: input.graph.workspaceId,
      ...selection,
      cwd: input.worktree.worktree,
      worktreeId: null,
      title: `${input.task.id} · ${input.task.title}`,
      state: "dormant",
      permissionMode: workerMode(ceiling),
      celestial: pickCelestial(model.sessions.values(), {
        id: sessionId,
        workspaceId: input.graph.workspaceId,
      }),
      parentSessionId: null,
      forkedFromTurnId: null,
      harnessCursor: null,
      turnCount: 0,
      contextUsage: null,
      lastError: null,
      worker: { constellationId: input.graph.id },
      createdAt: at,
      updatedAt: at,
    });

  if (session.permissionMode === "auto") {
    const registry = yield* HarnessRegistry;

    const driver = yield* registry
      .get(session.harness)
      .pipe(
        Effect.mapError((error) =>
          refusal(model.constellations.get(input.graph.id), [
            finding("E-HARNESS", error.message, "Choose an available harness and retry dispatch."),
          ])
        )
      );

    yield* (driver.validatePermissionMode?.(session) ?? Effect.void).pipe(
      Effect.mapError((error) =>
        refusal(model.constellations.get(input.graph.id), [
          finding(
            "E-HARNESS-PERMISSIONS",
            error.message,
            "Choose a model that supports auto, or change the lead's permission mode."
          ),
        ])
      )
    );
  }

  if (existing === undefined)
    yield* store
      .commit({
        commandId: CommandId.make(`${input.key}:session`),
        decide: (current) => {
          if (current.sessions.has(sessionId)) return Effect.succeed([]);

          const workspace = current.workspaces.has(input.graph.workspaceId)
            ? []
            : [
                DomainEvent.cases.WorkspaceRegistered.make({
                  workspace: new Workspace({
                    id: input.graph.workspaceId,
                    path: input.worktree.repoPath,
                    name: basename(input.worktree.repoPath),
                    isGitRepo: true,
                    worktreeRoot: `${input.worktree.repoPath}.worktrees`,
                    hidden: false,
                    registeredAt: at,
                  }),
                }),
              ];

          return Effect.succeed([
            ...workspace,
            ...decideSession(undefined, { type: "session.fork", session }).events,
          ]);
        },
      })
      .pipe(Effect.orDie);

  const reusesWorktree = sameWorktree(input, existing);

  const startupSetup =
    input.task.kind !== "gate" && reusesWorktree
      ? yield* startupSetupIntent(input).pipe(
          Effect.catchTag("WorktreeSetupUntrusted", (error) => untrusted(model, input, error))
        )
      : null;

  if (input.task.kind !== "gate" && !reusesWorktree) {
    const setup = yield* (yield* WorktreeSetupService)
      .run(
        sessionId,
        input.key,
        input.worktree.worktree,
        input.worktreeSetup ?? null,
        input.graph.id,
        input.task.id,
        input.graph.workspaceId
      )
      .pipe(
        Effect.catchTags({
          CommandRejected: (error) =>
            Effect.fail(
              refusal(model.constellations.get(input.graph.id), [
                finding(
                  "E-SESSION-BUSY",
                  error.reason,
                  "Wait for the selected Session’s Turn to end before setting up its worktree, then retry."
                ),
              ])
            ),
          WorktreeSetupUntrusted: (error) => untrusted(model, input, error),
        })
      );

    if (setup?.status === "failed")
      return yield* refusal(model.constellations.get(input.graph.id), [
        finding(
          "E-SETUP",
          `Worktree setup failed: ${setup.command}`,
          `Open ${sessionId}, fix setup and dispatch again.`
        ),
      ]);
  }

  return new Attempt({
    id: AttemptId.make(`${input.key}:attempt`),
    taskId: input.task.id,
    revision: 0,
    cause:
      input.previous === null
        ? AttemptCause.cases.Initial.make({})
        : AttemptCause.cases.Followup.make({ ref: input.previous.id }),
    by: input.graph.leadSessionId,
    sessionId,
    hostId,
    worktree: input.worktree.worktree,
    branch: input.worktree.branch,
    base: input.worktree.base,
    startupSetup,
    state: "working",
    claim: null,
    mergedHead: null,
    receipts: [],
    evidence: null,
    claimedAt: null,
    approvedByUserAt: null,
    handedUpAt: null,
    handedUpReason: null,
    nudgedAt: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  });
});

const sameWorktree = (input: WorkerPreparation, session: AgentSession | undefined) =>
  session !== undefined &&
  input.previous?.sessionId === session.id &&
  input.previous.worktree === input.worktree.worktree &&
  session.cwd === input.worktree.worktree;
