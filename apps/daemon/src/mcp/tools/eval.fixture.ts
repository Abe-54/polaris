import { expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSession,
  Attempt,
  AttemptCause,
  AttemptId,
  CheckReceipt,
  Claim,
  CommandId,
  ConstellationCommand,
  ConstellationId,
  DomainEvent,
  HostId,
  SessionId,
  TaskId,
  ToolCallReference,
  TurnId,
  type TurnItem,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Predicate, Schema, Stream } from "effect";
import { CONSTELLATION_SKILL_VERSION } from "../../constellation/skills/index.ts";
import { type ConstellationRuntimeService } from "../../constellation/runtime.ts";
import { decideSession, type SessionInput } from "../../engine/session.ts";
import { HarnessEvent, type HarnessDriver } from "../../harness/HarnessDriver.ts";
import {
  attachConstellation,
  type ConstellationAttachment,
} from "../../harness/constellation/attachment.ts";
import { startWorker } from "../../harness/constellation/start.ts";
import { EventStore } from "../../store/EventStore.ts";
import type { ReadModel } from "../../store/model.ts";
import { McpBinding } from "../binding.ts";
import { McpTokens } from "../tokens.ts";
import { revokeMcpBindings } from "../revoke.ts";
import type { BoundTool, ConstellationCommands, McpToolResult } from "./index.ts";

export const CID = ConstellationId.make("eval");

export const HOST = HostId.make("eval-host");

export const LEAD = SessionId.make("eval-lead");

export const WS = WorkspaceId.make("eval-workspace");

const AT = "2026-10-01T00:00:00.000Z";

export const leadBinding = McpBinding.cases.Lead.make({ constellationId: CID, sessionId: LEAD });

export const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Constellation eval",
      "-c",
      "user.email=eval@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();

export const repo = (root: string, taskId: string) => join(root, taskId);

const session = (root: string, id: SessionId, taskId: string) =>
  new AgentSession({
    id,
    workspaceId: WS,
    harness: "codex",
    title: taskId === "G1" ? "Lead" : `worker-${taskId}`,
    cwd: repo(root, taskId),
    worktreeId: null,
    state: "idle",
    permissionMode: "supervised",
    model: null,
    effort: null,
    parentSessionId: null,
    forkedFromTurnId: null,
    harnessCursor: null,
    turnCount: 0,
    contextUsage: null,
    lastError: null,
    createdAt: AT,
    updatedAt: AT,
  });

export const seed = (root: string) =>
  Effect.gen(function* () {
    const store = yield* EventStore;

    for (const id of ["A1", "A2", "A3", "G1"]) {
      const cwd = repo(root, id);
      mkdirSync(cwd);
      git(cwd, "init", "--initial-branch", `polaris/eval/${id}`);
      writeFileSync(join(cwd, "work.txt"), "initial\n");
      git(cwd, "add", "work.txt");
      git(cwd, "commit", "-m", "Initial fixture");
    }

    yield* store.commit({
      commandId: CommandId.make("seed"),
      decide: () =>
        Effect.succeed([
          DomainEvent.cases.WorkspaceRegistered.make({
            workspace: new Workspace({
              id: WS,
              path: root,
              name: "Eval",
              isGitRepo: true,
              worktreeRoot: root,
              hidden: false,
              registeredAt: AT,
            }),
          }),
          DomainEvent.cases.SessionCreated.make({ session: session(root, LEAD, "G1") }),
          ...["A1", "A2", "A3"].map((id) =>
            DomainEvent.cases.SessionCreated.make({
              session: session(root, SessionId.make(`worker-${id}`), id),
            })
          ),
        ]),
    });
  });

const preparedAttempt = (root: string, model: ReadModel, taskId: TaskId, sessionId: SessionId) => {
  const count =
    model.constellations.get(CID)?.graph.attempts.filter((item) => item.taskId === taskId).length ??
    0;

  const cwd = repo(root, taskId);

  return new Attempt({
    id: AttemptId.make(`${taskId}-${count + 1}`),
    taskId,
    sessionId,
    hostId: HOST,
    by: LEAD,
    revision: 0,
    cause: AttemptCause.cases.Initial.make({}),
    worktree: cwd,
    branch: git(cwd, "branch", "--show-current"),
    base: git(cwd, "rev-parse", "HEAD"),
    state: "working",
    claimedAt: null,
    approvedByUserAt: null,
    handedUpAt: null,
    handedUpReason: null,
    nudgedAt: null,
    startedAt: AT,
  });
};

const probeClaim = (command: ConstellationCommand, model: ReadModel) => {
  let claimProbe = null;
  const record = model.constellations.get(CID);

  if (Predicate.isTagged(command, "WorkerClaim")) {
    const attempt = record?.graph.attempts.find((item) => item.id === command.attemptId);

    if (attempt !== undefined)
      claimProbe = {
        branch: git(attempt.worktree, "branch", "--show-current"),
        head: git(attempt.worktree, "rev-parse", "HEAD"),
        dirtyPaths: git(attempt.worktree, "status", "--porcelain").split("\n").filter(Boolean),
      };
  }

  return claimProbe;
};

const prepare = (root: string, command: ConstellationCommand, model: ReadModel) => {
  const record = model.constellations.get(CID);
  const attempts: Attempt[] = [];
  let claimProbe = null;

  if (Predicate.isTagged(command, "Dispatch")) {
    for (const placement of command.tasks) {
      const sessionId = Predicate.isTagged(placement.worker, "Existing")
        ? placement.worker.sessionId
        : SessionId.make(`worker-${placement.taskId}`);

      attempts.push(preparedAttempt(root, model, placement.taskId, sessionId));
    }
  }

  if (Predicate.isTagged(command, "Review") && Predicate.isTagged(command.action, "SendBack")) {
    const previous = record?.graph.attempts.find((item) => item.id === command.attemptId);

    if (previous !== undefined) {
      const sessionId = Predicate.isTagged(command.action.worker, "Existing")
        ? command.action.worker.sessionId
        : SessionId.make(`worker-${previous.taskId}`);

      attempts.push(preparedAttempt(root, model, previous.taskId, sessionId));
    }
  }

  claimProbe = probeClaim(command, model);

  return { attempts, claimProbe, newLeadSessionId: null, recordedChecks: [] };
};

/** Provisioning is the test boundary; decisions, persisted receipts and revocation use production code. */
export const runtime = (root: string, starts: Attempt[]) =>
  Effect.gen(function* () {
    const tokens = yield* McpTokens;

    return {
      prepare: (_binding, command, model) => Effect.sync(() => prepare(root, command, model)),
      resumeWorking: () => Effect.void,
      afterCommit: (_binding, _command, envelopes) =>
        Effect.forEach(
          envelopes,
          (envelope) =>
            Effect.gen(function* () {
              yield* revokeMcpBindings(envelope.event).pipe(
                Effect.provideService(McpTokens, tokens),
                Effect.orDie
              );

              if (Predicate.isTagged(envelope.event, "AttemptStarted"))
                starts.push(envelope.event.attempt);
            }),
          { discard: true }
        ),
    } satisfies ConstellationRuntimeService;
  });

const signal = (store: typeof EventStore.Service, sessionId: SessionId, input: SessionInput) =>
  store.commit({
    commandId: null,
    decide: (model) => {
      const decision = decideSession(model.sessions.get(sessionId), input);
      expect(decision.rejection).toBeNull();

      return Effect.succeed(decision.events);
    },
  });

export const runBenchTurn = Effect.fnUntraced(function* (
  attachment: ConstellationAttachment,
  cwd: string,
  prompt: string,
  driver: HarnessDriver
) {
  const store = yield* EventStore;

  const session = yield* driver.open({
    sessionId: attachment.sessionId,
    cwd,
    permissionMode: "supervised",
    model: null,
    effort: null,
    resumeCursor: null,
    constellation: attachment,
  });

  const turnId = TurnId.make(crypto.randomUUID());
  const seen: TurnItem[] = [];
  yield* session.sendTurn({ turnId, prompt, attachments: [], model: null, effort: null });
  yield* session.events.pipe(
    Stream.takeUntil(HarnessEvent.$is("TurnEnded")),
    Stream.runForEach((event) =>
      HarnessEvent.$match(event, {
        TurnStarted: (event) =>
          signal(store, attachment.sessionId, {
            type: "harness.turnStarted",
            trigger: null,
            turnId: event.turnId,
            prompt: event.prompt ?? prompt,
            at: AT,
          }),
        ItemCompleted: (event) => {
          seen.push(event.item);

          return store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.TurnItemCompleted.make({
                  sessionId: attachment.sessionId,
                  turnId,
                  subagentId: null,
                  item: event.item,
                }),
              ]),
          });
        },
        TurnEnded: (event) =>
          signal(store, attachment.sessionId, {
            type: "harness.turnEnded",
            turnId,
            status: event.status,
            error: event.error,
            checkpoint: null,
            at: AT,
          }),
        CursorAssigned: () => Effect.void,
        ItemDelta: () => Effect.void,
        ItemUpdated: () => Effect.void,
        ContextUsed: () => Effect.void,
        BackgroundTasksChanged: () => Effect.void,
        SubagentStarted: () => Effect.void,
        SubagentEnded: () => Effect.void,
        ApprovalRequested: () => Effect.void,
        ApprovalWithdrawn: () => Effect.void,
        TitleSuggested: () => Effect.void,
        ReplySuggested: () => Effect.void,
        WorktreeCreated: () => Effect.void,
        Exited: () => Effect.void,
      }).pipe(Effect.asVoid)
    )
  );
  expect(seen).toHaveLength(5);
  const command = seen.find((item) => Predicate.isTagged(item, "CommandExecution"))!;

  return CheckReceipt.cases.Verified.make({
    label: "bench scripted command",
    item: new ToolCallReference({
      hostId: HOST,
      sessionId: attachment.sessionId,
      turnId,
      itemId: command.id,
    }),
  });
});

export const runAttempt = Effect.fnUntraced(function* (
  attempt: Attempt,
  commands: ConstellationCommands,
  driver: HarnessDriver
) {
  const store = yield* EventStore;
  const model = yield* store.model;
  const graph = model.constellations.get(CID)!.graph;
  const task = graph.tasks.find((item) => item.id === attempt.taskId)!;
  let attachment: ConstellationAttachment | undefined;
  let receipt: CheckReceipt | undefined;
  yield* startWorker(
    {
      constellationId: CID,
      workspaceId: WS,
      task,
      attempt,
      permissionMode: "supervised",
      selection: { harness: "codex", model: null, effort: null },
      acceptedDeps: task.deps.map((taskId) => ({
        taskId,
        claim: graph.attempts.filter((item) => item.taskId === taskId).at(-1)!.claim!,
      })),
    },
    {
      attach: (binding) =>
        attachConstellation(binding, "http://127.0.0.1:12345", commands).pipe(Effect.orDie),
      startSession: Effect.fnUntraced(function* (start) {
        expect(start.prompt).toContain(`Task: ${task.id}`);
        expect(start.attachment.instructions).toContain(`v${CONSTELLATION_SKILL_VERSION}`);
        attachment = start.attachment;
        receipt = yield* runBenchTurn(
          start.attachment,
          attempt.worktree,
          start.prompt,
          driver
        ).pipe(Effect.orDie);
      }),
    }
  );
  writeFileSync(join(attempt.worktree, `${attempt.taskId}.txt`), `${attempt.id}\n`);
  git(attempt.worktree, "add", `${attempt.taskId}.txt`);
  git(attempt.worktree, "commit", "-m", `Complete ${attempt.id}`);

  if (attachment === undefined || receipt === undefined) throw new Error("Worker did not start");
  const head = git(attempt.worktree, "rev-parse", "HEAD");

  const claim = new Claim({
    branch: attempt.branch,
    head,
    commits: [head],
    receipts: [receipt],
    notDone: [],
    followups: [],
    questions: [],
    outsideArea: [],
    decisions: [],
    summary: `Bench ${attempt.id} completed`,
  });

  return { attempt, attachment, claim };
});

const sessionToolNames = new Set([
  "read_worker",
  "wait_for_command",
  "notify",
  "request_secret",
  "sessions",
  "search_history",
  "read_history",
]);

export const toolCounter = () => {
  const calls: string[] = [];
  const findings: string[] = [];
  const stats = { calls: 0, errors: 0 };

  const call = async <A>(
    tools: ReadonlyArray<BoundTool>,
    name: string,
    input: A,
    expected?: string
  ): Promise<McpToolResult> => {
    const tool = tools.find((item) => item.name === name);

    if (tool === undefined) throw new Error(`Missing ${name}`);

    const result = await tool.call(
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(input))
    );

    calls.push(name);
    stats.calls++;
    // Session tools read sessions, not the graph: they end in Next without a Revision.
    expect(result.content[0]?.text).toMatch(
      sessionToolNames.has(name) ? /\nNext: .+$/ : /Revision: \d+\n[\s\S]*Next: .+$/
    );

    if (expected === undefined) expect(result.isError).not.toBe(true);
    else {
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.findings?.map((item) => item.code)).toContain(expected);
    }

    if (result.isError) {
      stats.errors++;
      findings.push(...(result.structuredContent?.findings?.map((item) => item.code) ?? []));
    }

    return result;
  };

  return { call, calls, findings, stats };
};
