/**
 * The Claude Code Harness driver.
 *
 * One Agent SDK `query()` per active Agent Session, in-process in the Daemon,
 * driving the user's own `claude` binary (`pathToClaudeCodeExecutable`), so the
 * binary uses its own sign-in. Polaris never reads, copies or forwards Claude
 * credentials. Turns flow into the one live query through streaming input.
 *
 * Design follows pingdotgg/t3code@de251fc (MIT) `ClaudeAdapter.ts` (streaming input,
 * `canUseTool` awaiting a deferred, `resume`, the permission-mode mapping); no code
 * was copied.
 */

import { childEnv } from "../../service/childEnv.ts";
import { join } from "node:path";
import {
  type CanUseTool,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ApprovalDecision,
  type PermissionMode,
  RequestId,
  TurnId,
  TurnTrigger,
  TurnItem,
} from "@polaris/protocol";
import {
  type Cause,
  Deferred,
  Effect,
  Fiber,
  Inspectable,
  Option,
  Queue,
  Scope,
  Stream,
} from "effect";
import { paths } from "../../paths.ts";
import { polarisInstructions } from "../../constellation/skills/preamble.ts";
import {
  type HarnessDriver,
  HarnessError,
  HarnessEvent,
  type HarnessProbe,
  type HarnessSession,
  type OpenOptions,
  type TurnInput,
} from "../HarnessDriver.ts";
import { steerItem } from "../userMessage.ts";
import { ItemClock } from "../itemClock.ts";
import { backgroundControls } from "./backgroundTasks.ts";
import { breakdownOf } from "./context.ts";
import { emptyClaudeLimitContext } from "../limits/claude.ts";
import type { PlanLimitReporter } from "../limits/PlanLimitReporter.ts";
import { ClaudeHookReceiver } from "./hooks.ts";
import { contextWindowOf } from "./payloads.ts";
import { titleHooks } from "./title.ts";
import { Inbox } from "./inbox.ts";
import { buildUserMessage, landedSteer, type SteerInput, type SteerSent } from "./input.ts";
import { shellCommandMessage } from "./shellInput.ts";
import { CLAUDE_CAPABILITIES } from "./capabilities.ts";
import { listClaudeCommands } from "./commands.ts";
import { isEffortLevel, listClaudeModels } from "./models.ts";
import {
  approvalKind,
  describeToolCall,
  isQuestionTool,
  leavesPlan,
  parseQuestions,
  toClaudePermissionMode,
  type ToolUseInput,
  toPermissionResult,
} from "./permissions.ts";
import { type ClaudePlanLimits, claudePlanLimitReader } from "./planLimits.ts";
import { usageLimitWatch } from "./usageLimit.ts";
import { ClaudeTranslator } from "./translate.ts";
import { readConfinement } from "../confinement.ts";
import { readOnlyEnv, readOnlyOptions } from "./readOnly.ts";
import type { BrowserMcp } from "../browser/index.ts";
import { claudeBrowserOptions } from "./browser.ts";
import { withoutShadowedWarning } from "./sdkWarnings.ts";
import { claudeStartLog } from "./startLog.ts";
import { logStart } from "../startLog.ts";
import { type ClaudeSandbox, describeSandboxFailure, probeClaudeSandbox } from "./sandbox.ts";
import { shortHostName } from "../../service/hostName.ts";
import { which } from "../../service/userPath.ts";
import {
  messageAutoFallback,
  validateRequestedAuto,
  validateClaudePermissionMode,
} from "./autoMode.ts";
import { claudeExecutable } from "./executable.ts";

export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

export interface ClaudeDriverOptions {
  /** The SDK's `query`; injectable so tests can script a fake Claude. */
  readonly query?: QueryFn;
  /** Absolute path to `claude`; default: resolved on PATH. */
  readonly claudePath?: () => string | null;
  /** Runs `claude --version`; injectable for tests. */
  readonly runVersion?: (path: string) => Promise<{ exitCode: number; stdout: string }>;
  /** Present when the Daemon runs the hook listener for In Terminal sessions. */
  readonly hookReceiver?: ClaudeHookReceiver["Service"];
  /** Directory of staged attachments, granted read access; default `~/.polaris/staging`. */
  readonly stagingDir?: string;
  /** Read a staged attachment; injectable for tests. */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  /** Identifier Claude Code reports for this client. */
  readonly clientApp?: string;
  /** Receives the `claude` child's stderr lines (for the Daemon log). */
  readonly onStderr?: (line: string) => void;
  /** Receives the account's Plan Limits as Claude Code reports them. */
  readonly planLimits?: PlanLimitReporter["Service"];
  /** Whether Claude Code's sandbox can start here; injectable for tests. */
  readonly sandbox?: () => ClaudeSandbox;
  /** The Host's name in error messages; default the machine's short hostname. */
  readonly hostName?: string;
  /** The Browser's MCP server for each session that isn't read-only. */
  readonly browser?: BrowserMcp["Service"];
}

const HARNESS = "claude";

const harnessError = (message: string, cause?: unknown) =>
  new HarnessError(
    cause === undefined ? { harness: HARNESS, message } : { harness: HARNESS, message, cause }
  );

const unknownEffort = (effort: string) =>
  harnessError(`Claude Code has no "${effort}" effort level`);

const defaultRunVersion = async (path: string) => {
  const proc = Bun.spawn([path, "--version"], {
    env: childEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
  });

  const stdout = await new Response(proc.stdout).text();

  return { exitCode: await proc.exited, stdout };
};

/** `2.1.283 (Claude Code)` → `2.1.283`. */
export const parseVersion = (stdout: string): string | null =>
  /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout)?.[1] ?? null;

/** How a Turn ends when every message sent for it is answered. */
interface TurnOutcome {
  readonly status: "completed" | "failed";
  readonly error: string | null;
}

const resultOutcome = (result: SDKResultMessage): TurnOutcome => {
  if (result.subtype === "success")
    return result.is_error
      ? { status: "failed", error: result.result || "Claude reported an error" }
      : { status: "completed", error: null };

  return {
    status: "failed",
    error: result.errors.length > 0 ? result.errors.join("\n") : result.subtype,
  };
};

interface PendingApproval {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly input: ToolUseInput;
  readonly suggestions: ReadonlyArray<PermissionUpdate>;
  readonly deferred: Deferred.Deferred<PermissionResult>;
}

interface ActiveTurn {
  readonly autonomous: boolean;
  readonly turnId: TurnId;
  /** Uuids of user messages sent for this Turn that Claude has not yet answered. */
  readonly pending: Set<string>;
  interrupting: boolean;
  outcome: TurnOutcome;
  resultArrived: boolean;
}

/** Starts the query; the SDK's expected shadowed-`canUseTool` warning becomes one debug line. */
const startQuery = Effect.fnUntraced(function* (
  query: QueryFn,
  params: Parameters<QueryFn>[0],
  sessionId: string
) {
  const started = yield* Effect.try({
    try: () => withoutShadowedWarning(() => query(params)),
    catch: (cause) => harnessError("Could not start Claude Code", cause),
  });

  if (started.shadowed !== null)
    yield* Effect.logDebug(`session ${sessionId}: ${started.shadowed}`);
  yield* logStart(sessionId, "Claude Code started; waiting for it to be ready");

  return started.value;
});

const openSession = Effect.fnUntraced(function* (
  driver: Required<Pick<ClaudeDriverOptions, "query" | "claudePath">> &
    ClaudeDriverOptions & { readonly limits: ClaudePlanLimits | null },
  options: OpenOptions
) {
  const claudePath = driver.claudePath();

  if (claudePath === null)
    return yield* harnessError("Claude Code is not installed: `claude` was not found on PATH");
  yield* logStart(options.sessionId, `starting Claude Code at ${claudePath}`);
  const context = yield* Effect.context<never>();
  const startLog = claudeStartLog(options.sessionId, (log) => Effect.runForkWith(context)(log));

  const scope = yield* Scope.Scope;
  const sandbox = driver.sandbox ?? (() => probeClaudeSandbox());

  // The sandbox is Polaris's in a read-only session, else the user's own setting.
  const human = (error: string) =>
    describeSandboxFailure(error, {
      host: driver.hostName ?? shortHostName(),
      sandbox: sandbox(),
      own: options.readOnly !== true,
    }) ?? error;

  const events = yield* Queue.unbounded<HarnessEvent, Cause.Done>();
  const clock = new ItemClock();
  const emit = (event: HarnessEvent) => Queue.offerUnsafe(events, clock.stamp(event));
  const usageLimit = usageLimitWatch();

  const emitAll = (list: ReadonlyArray<HarnessEvent>) => {
    for (const e of list) emit(e);
  };

  const translator = new ClaudeTranslator(options.cwd, options.resumeCursor);
  const inbox = new Inbox<SDKUserMessage>();
  const approvals = new Map<RequestId, PendingApproval>();
  /** Steer messages an interrupt cancelled; if Claude starts on one anyway, interrupt again. */
  const cancelled = new Set<string>();
  /** Steers sent that Claude Code hasn't folded into the Turn yet, by uuid. */
  const steers = new Map<string, SteerSent>();

  /** Claude Code took the steer in: it shows in its Turn from here. */
  const landSteer = (uuid: string) => {
    const steer = steers.get(uuid);

    if (steer === undefined) return;
    steers.delete(uuid);
    emit(landedSteer(uuid, steer));
  };

  let active: ActiveTurn | null = null;
  let permissionMode: PermissionMode = options.permissionMode;
  /** An approved ExitPlanMode took Claude out of plan mode; the next Turn re-enters it. */
  let leftPlan = false;
  let closing = false;
  let exited = false;

  const settle = (requestId: RequestId, result: PermissionResult) => {
    const pending = approvals.get(requestId);

    if (!pending) return;
    approvals.delete(requestId);

    if (result.behavior === "deny") translator.markDeclined(pending.toolUseId);
    Deferred.doneUnsafe(pending.deferred, Effect.succeed(result));
  };

  /** Withdraw every open approval (interrupt, close, exit) and answer Claude with a deny. */
  const withdrawAll = (message: string) => {
    for (const requestId of approvals.keys()) {
      emit(HarnessEvent.ApprovalWithdrawn({ requestId }));
      settle(requestId, { behavior: "deny", message, interrupt: true });
    }
  };

  const endTurn = (status: "completed" | "interrupted" | "failed", raw: string | null) => {
    const turn = active;
    const error = raw === null ? null : human(raw);

    if (!turn) return;
    active = null;

    // Never taken in (an interrupt recalled it): it doesn't show as part of the Turn.
    for (const [uuid, steer] of steers) if (steer.turnId === turn.turnId) steers.delete(uuid);
    emitAll(translator.closeOpenTools(turn.turnId, status === "completed" ? "failed" : "declined"));
    translator.endTurn();
    const limit = usageLimit.take();
    emit(
      HarnessEvent.TurnEnded({
        turnId: turn.turnId,
        status,
        error,
        limit: status === "failed" ? limit : undefined,
      })
    );
    limits?.refresh();
    readContext();
  };

  const canUseTool: CanUseTool = async (toolName, input, context) => {
    if (options.readOnly === true)
      return { behavior: "deny", message: "The Reviewer never requests permission." };
    const turn = active;

    if (!turn || turn.interrupting || closing)
      return { behavior: "deny", message: "No Turn is in progress.", interrupt: true };
    const requestId = RequestId.make(crypto.randomUUID());
    const deferred = Deferred.makeUnsafe<PermissionResult>();
    approvals.set(requestId, {
      toolName,
      toolUseId: context.toolUseID,
      input,
      suggestions: context.suggestions ?? [],
      deferred,
    });
    const described = describeToolCall(toolName, input);
    const questions = isQuestionTool(toolName) ? parseQuestions(input) : [];
    emit(
      HarnessEvent.ApprovalRequested({
        turnId: turn.turnId,
        requestId,
        kind: approvalKind(toolName),
        title: isQuestionTool(toolName) ? described.title : (context.title ?? described.title),
        detail: described.detail ?? context.description ?? null,
        options: questions.length === 1 ? questions[0]!.options.map((o) => o.label) : [],
        questions,
      })
    );

    const onAbort = () => {
      if (!approvals.has(requestId)) return;
      emit(HarnessEvent.ApprovalWithdrawn({ requestId }));
      settle(requestId, { behavior: "deny", message: "The request was cancelled." });
    };

    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      return await Effect.runPromise(Deferred.await(deferred));
    } finally {
      context.signal.removeEventListener("abort", onAbort);
    }
  };

  const sdkOptions: Options = {
    cwd: options.cwd,
    ...claudeExecutable(claudePath),
    permissionMode: toClaudePermissionMode(options.permissionMode),
    // Only makes `bypassPermissions` selectable later (full-access); it does not enable it.
    allowDangerouslySkipPermissions: true,
    // Registered even in full-access, so prompts still work after a later mode change; the
    // SDK's CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning is expected. See this driver's README.
    canUseTool,
    includePartialMessages: true,
    // Claude Code echoes each user message when it takes it in: a steer lands then.
    extraArgs: { "replay-user-messages": null },
    // Subagents' own text and thinking, not only their tool calls (see translate.ts).
    forwardSubagentText: true,
    // Claude Code's own title for the session (title.ts); a reviewer's options replace it.
    hooks: titleHooks(emit),
    systemPrompt: { type: "preset", preset: "claude_code", append: polarisInstructions(options) },
    settingSources: ["user", "project", "local"],
    additionalDirectories: [join(driver.stagingDir ?? paths().staging, options.sessionId)],
    env: childEnv({
      ...process.env,
      ...options.environment,
      CLAUDE_AGENT_SDK_CLIENT_APP: driver.clientApp ?? "polaris-daemon",
    }),
  };

  const attachments =
    options.constellations ?? (options.constellation === undefined ? [] : [options.constellation]);

  if (attachments.length > 0 && options.readOnly !== true) {
    if (attachments.some((a) => a.sessionId !== options.sessionId))
      return yield* harnessError("Constellation attachment belongs to another session");

    const { claudeConstellationOptions } = yield* Effect.promise(
      () => import("./constellation.ts")
    );

    Object.assign(sdkOptions, claudeConstellationOptions(attachments));
  }

  Object.assign(sdkOptions, yield* claudeBrowserOptions(driver.browser, options, sdkOptions));

  if (options.readOnly === true) {
    const confinement = yield* Effect.tryPromise({
      try: () => readConfinement(options.cwd, sdkOptions.env),
      catch: (cause) => harnessError("Could not keep the reviewer to its checkout", cause),
    });

    const env = readOnlyEnv(sdkOptions.env ?? {}, confinement);
    Object.assign(sdkOptions, readOnlyOptions(sandbox(), confinement, env));
    // Claude Code runs where the confinement was checked: the checkout's real path, its env.
    sdkOptions.cwd = confinement.root;
    sdkOptions.env = env;
  }

  if (options.model !== null) sdkOptions.model = options.model;

  if (options.effort !== null) {
    if (!isEffortLevel(options.effort)) return yield* unknownEffort(options.effort);
    sdkOptions.effort = options.effort;
  }

  if (options.resumeCursor !== null) sdkOptions.resume = options.resumeCursor;

  if (driver.onStderr) sdkOptions.stderr = driver.onStderr;

  const q = yield* startQuery(
    driver.query,
    { prompt: inbox, options: sdkOptions },
    options.sessionId
  );

  const limits = driver.limits ? claudePlanLimitReader(driver.limits, q) : null;
  limits?.read();

  /** Claude Code's own count of the context (as `/context` shows it), where the SDK offers it. */
  const readContext = () => {
    // A Claude Code without it rejects, and the header shows no Context.
    void Promise.resolve()
      .then(() => q.getContextUsage({ detail: "summary" }))
      .then(
        (usage) => {
          if (!exited)
            emitAll(
              translator.onContextUsage(usage.totalTokens, usage.maxTokens, breakdownOf(usage))
            );
        },
        () => {}
      );
  };

  if (options.resumeCursor !== null) readContext();

  const finish = (error: string | null) => {
    if (exited) return;
    exited = true;
    startLog.onExit(error);
    withdrawAll("Claude Code stopped.");
    endTurn(error === null && closing ? "interrupted" : "failed", error ?? "Claude Code exited");
    emit(HarnessEvent.Exited({ error: error === null ? null : human(error) }));
    Queue.endUnsafe(events);
  };

  const continueOnReports = () => {
    if (active !== null) return;
    const tasks = translator.takeReports();

    const turnId = TurnId.make(`claude:${crypto.randomUUID()}`);
    active = {
      autonomous: true,
      turnId,
      pending: new Set(),
      interrupting: false,
      outcome: { status: "completed", error: null },
      resultArrived: false,
    };
    translator.beginTurn(turnId);
    emit(
      HarnessEvent.TurnStarted({
        turnId,
        prompt: null,
        trigger: TurnTrigger.cases.BackgroundTasksReported.make({ tasks }),
      })
    );
  };

  const onResult = (result: SDKResultMessage) => {
    const turn = active;

    if (!turn) return;

    const uuids =
      result.user_message_uuids ?? (result.user_message_uuid ? [result.user_message_uuid] : null);

    // Older CLIs don't echo uuids: then a result answers everything sent so far.
    if (uuids === null && result.origin?.kind === "task-notification" && turn.pending.size > 0)
      return;

    // CLIs that don't echo steers: what the result answered was taken in.
    for (const u of uuids ?? [...steers.keys()]) landSteer(u);

    if (uuids === null) turn.pending.clear();
    else for (const u of uuids) turn.pending.delete(u);
    turn.resultArrived = true;
    turn.outcome = resultOutcome(result);
    emitAll(translator.onContextUsage(null, contextWindowOf(result)));

    if (turn.interrupting) {
      for (const u of turn.pending) cancelled.add(u);
      endTurn("interrupted", null);
    } else if (turn.pending.size === 0) {
      endTurn(turn.outcome.status, turn.outcome.error);
    }
  };

  const onMessage = (message: SDKMessage) => {
    startLog.onMessage(message);
    const error = messageAutoFallback(permissionMode, message, options.readOnly);

    if (error !== null) {
      finish(error);
      inbox.end();
      q.close();

      return;
    }

    if (exited) return;

    if (message.type === "user" && "isReplay" in message && message.isReplay)
      landSteer(message.uuid);

    if (message.type === "result") {
      if (message.origin?.kind === "task-notification") continueOnReports();

      return onResult(message);
    }

    limits?.onMessage(message);
    usageLimit.onMessage(message);
    const echo = "user_message_uuid" in message ? message.user_message_uuid : undefined;

    if (echo !== undefined && cancelled.delete(echo)) {
      // A steer an interrupt could not recall started its own run: stop it too.
      void q.interrupt().catch(() => {});
    }

    if (
      ((message.type === "assistant" || message.type === "stream_event") &&
        message.parent_tool_use_id === null) ||
      (message.type === "system" && message.subtype === "status" && message.status === "requesting")
    ) {
      continueOnReports();
    }

    emitAll(translator.onMessage(message));
  };

  // Finalizers run in reverse: close the query, stop the reader, then report the exit.
  yield* Effect.addFinalizer(() => Effect.sync(() => finish(null)));

  const reader = yield* Stream.fromAsyncIterable(q, (cause) => cause).pipe(
    Stream.runForEach((message) => Effect.sync(() => onMessage(message))),
    Effect.matchCause({
      onSuccess: () => finish(closing ? null : "Claude Code exited unexpectedly"),
      onFailure: (cause) => finish(closing ? null : (causeMessage(cause) ?? "Claude Code failed")),
    }),
    Effect.forkIn(scope)
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true;
      withdrawAll("The session was closed.");
      inbox.end();
      q.close();
      yield* Fiber.interrupt(reader);
    })
  );

  yield* validateRequestedAuto(q, permissionMode, options.model, options.readOnly);

  const send = Effect.fnUntraced(function* (
    prompt: string,
    input: SteerInput | null,
    turn: ActiveTurn | null = null,
    uuid: NonNullable<SDKUserMessage["uuid"]> = crypto.randomUUID()
  ) {
    turn?.pending.add(uuid);

    if (input?.shellCommand !== undefined)
      return { uuid, message: shellCommandMessage(uuid, input.shellCommand) };

    const message = yield* buildUserMessage({
      uuid,
      prompt,
      attachments: input?.attachments ?? [],
      readFile: driver.readFile,
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          turn?.pending.delete(uuid);
        })
      )
    );

    return { uuid, message };
  });

  /** The Model and effort the live query runs with; a Turn that asks for others switches first. */
  const running = { model: options.model, effort: options.effort };

  /**
   * A control request an older Claude Code may not know: on failure the Turn still runs, on
   * what the query already had. See the availability README for the versions checked.
   */
  const tryControl = (what: string, request: () => Promise<void>) =>
    Effect.tryPromise(request).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning(`Claude Code: ${what} failed; the Turn runs without it`, cause).pipe(
          Effect.as(false)
        )
      )
    );

  const switchTo = Effect.fnUntraced(function* (model: string | null, effort: string | null) {
    if (model !== running.model) {
      yield* validateRequestedAuto(q, permissionMode, model, options.readOnly);

      const switched = yield* tryControl(`switching to ${model ?? "the default Model"}`, () =>
        q.setModel(model ?? undefined)
      );

      if (switched) running.model = model;
    }

    if (effort === running.effort) return;

    if (effort !== null && !isEffortLevel(effort)) return yield* unknownEffort(effort);

    // A null effortLevel goes back to the Model's default effort.
    const set = yield* tryControl(`setting the effort to ${effort ?? "default"}`, () =>
      q.applyFlagSettings({ effortLevel: effort })
    );

    if (set) running.effort = effort;
  });

  const sendTurn = Effect.fn("ClaudeSession.sendTurn")(function* (input: TurnInput) {
    if (exited || closing) return yield* harnessError("The Claude session has ended");

    if (active && (active.autonomous || active.turnId === input.turnId) && !active.interrupting)
      return yield* steerInput(input.prompt, input);

    if (active) return yield* harnessError("A Turn is already in progress; steer it instead");

    if (input.effort !== null && !isEffortLevel(input.effort))
      return yield* unknownEffort(input.effort);
    const uuid = crypto.randomUUID();

    const reserved: ActiveTurn = {
      autonomous: false,
      turnId: input.turnId,
      pending: new Set([uuid]),
      interrupting: false,
      outcome: { status: "completed", error: null },
      resultArrived: false,
    };

    active = reserved;
    translator.beginTurn(input.turnId);
    emit(HarnessEvent.TurnStarted({ turnId: input.turnId, prompt: input.prompt }));
    // Reserve the user's Turn before controls or attachment reads can yield to a native run.
    yield* Effect.gen(function* () {
      if (leftPlan && permissionMode === "plan") yield* setPermissionMode("plan");
      yield* switchTo(input.model, input.effort);
      const { message } = yield* send(input.prompt, input, reserved, uuid);
      inbox.push(message);
    }).pipe(
      Effect.onError((cause) =>
        Effect.sync(() => {
          if (active === reserved)
            endTurn("failed", causeMessage(cause) ?? "Claude input preparation failed");
        })
      )
    );
  });

  /**
   * Claude Code folds a user message sent mid-Turn into the running Turn between tool
   * rounds; if the Turn ends first, it runs next. Either way the Polaris Turn stays open
   * until every message sent for it has been answered.
   */
  const steerInput = Effect.fn("ClaudeSession.steer")(function* (
    text: string,
    input: SteerInput | null
  ) {
    const turn = active;

    if (!turn || turn.interrupting) return yield* harnessError("No Turn is in progress to steer");

    const { uuid, message } = yield* send(text, input, turn).pipe(
      Effect.onError((cause) =>
        Effect.sync(() => {
          const id = crypto.randomUUID();
          const reason = causeMessage(cause) ?? "Claude input preparation failed";
          emit(
            HarnessEvent.ItemCompleted({
              turnId: turn.turnId,
              item: steerItem(`refused:${id}`, text, input?.attachments),
            })
          );
          emit(
            HarnessEvent.ItemCompleted({
              turnId: turn.turnId,
              item: TurnItem.cases.Error.make({ id: `refusal:${id}`, message: reason }),
            })
          );

          if (active === turn && turn.resultArrived && turn.pending.size === 0)
            endTurn("failed", reason);
        })
      )
    );

    // It shows in the Turn once Claude Code folds it in (its echo), not while a tool runs.
    steers.set(uuid, { turnId: turn.turnId, text, attachments: input?.attachments ?? [] });
    inbox.push(message);
  });

  const steer = (text: string, attachments: SteerInput["attachments"] = []) =>
    steerInput(text, { attachments });

  const steerTurn = (input: TurnInput) =>
    Effect.suspend(() =>
      active === null || active.interrupting || active.turnId !== input.turnId
        ? Effect.succeed(false)
        : steerInput(input.prompt, input).pipe(Effect.as(true))
    );

  const interrupt = Effect.gen(function* () {
    const turn = active;

    if (!turn || turn.interrupting) return;
    turn.interrupting = true;
    withdrawAll("The user interrupted the Turn.");
    yield* Effect.tryPromise({
      try: () => q.interrupt(),
      catch: (cause) => harnessError("Could not interrupt Claude", cause),
    });
  }).pipe(Effect.withSpan("ClaudeSession.interrupt"));

  const respond = Effect.fn("ClaudeSession.respond")(function* (
    requestId: RequestId,
    decision: ApprovalDecision
  ) {
    const pending = approvals.get(requestId);

    if (!pending) return yield* harnessError(`No open request ${requestId}`);
    settle(requestId, toPermissionResult(decision, pending));
    leftPlan ||= leavesPlan(pending.toolName, decision);
  });

  const setPermissionMode = Effect.fn("ClaudeSession.setPermissionMode")(function* (
    mode: PermissionMode
  ) {
    yield* validateRequestedAuto(q, mode, running.model, options.readOnly);
    const previous = permissionMode;
    // Status frames can precede the control reply; compare them to the requested mode.
    permissionMode = mode;
    leftPlan = false;

    yield* Effect.tryPromise({
      try: () =>
        q.setPermissionMode(options.readOnly === true ? "dontAsk" : toClaudePermissionMode(mode)),
      catch: (cause) => harnessError("Could not change the permission mode", cause),
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          permissionMode = previous;
        })
      )
    );
  });

  const terminalCommand = Effect.gen(function* () {
    const cursor = translator.sessionCursor ?? options.resumeCursor;

    if (cursor === null)
      return yield* harnessError("Claude has not started this session yet; send a Turn first");
    const argv: Array<string> = ["claude", "--resume", cursor];
    const mode = options.readOnly === true ? "dontAsk" : toClaudePermissionMode(permissionMode);

    if (mode !== "default") argv.push("--permission-mode", mode);

    if (driver.hookReceiver) {
      const { settingsPath } = yield* driver.hookReceiver.prepare({
        sessionId: options.sessionId,
        cursor,
      });

      argv.push("--settings", settingsPath);
    }

    return argv;
  });

  const session: HarnessSession = {
    events: Stream.fromQueue(events),
    sendTurn,
    steer,
    steerTurn,
    interrupt,
    ...backgroundControls(q),
    respond,
    setPermissionMode,
    terminalCommand,
  };

  return session;
});

const causeMessage = (cause: Cause.Cause<unknown>): string | null => {
  for (const reason of cause.reasons) {
    const value = "error" in reason ? reason.error : "defect" in reason ? reason.defect : null;

    if (value instanceof Error) return value.message;

    if (value !== null && value !== undefined) return Inspectable.toStringUnknown(value);
  }

  return null;
};

export const makeClaudeDriver = (options: ClaudeDriverOptions = {}): HarnessDriver => {
  const driver = {
    ...options,
    query: options.query ?? sdkQuery,
    claudePath: options.claudePath ?? (() => which("claude")),
    limits: options.planLimits
      ? { sink: options.planLimits, context: emptyClaudeLimitContext() }
      : null,
  };

  const runVersion = options.runVersion ?? defaultRunVersion;

  const probe: Effect.Effect<HarnessProbe> = Effect.gen(function* () {
    const path = driver.claudePath();

    if (path === null)
      return { available: false, version: null, detail: "`claude` was not found on PATH" };
    const result = yield* Effect.tryPromise(() => runVersion(path)).pipe(Effect.option);

    if (Option.isNone(result) || result.value.exitCode !== 0)
      return { available: false, version: null, detail: `\`${path} --version\` failed` };

    return { available: true, version: parseVersion(result.value.stdout), detail: path };
  }).pipe(Effect.withSpan("ClaudeDriver.probe"));

  const hooks = options.hookReceiver;

  const claude: HarnessDriver = {
    kind: "claude",
    capabilities: CLAUDE_CAPABILITIES,
    probe,
    listModels: listClaudeModels(driver),
    listCommands: listClaudeCommands(driver),
    validatePermissionMode: (requested) => validateClaudePermissionMode(driver, requested),
    open: (open) => openSession(driver, open),
  };

  // While In Terminal, Polaris follows the TUI through its HTTP hooks (hooks.ts).
  return hooks
    ? { ...claude, terminalFollow: { events: hooks.events, release: hooks.release } }
    : claude;
};

/** The Claude driver with the Daemon's hook listener, for the `HarnessRegistry`. */
export const ClaudeDriver = Effect.gen(function* () {
  const hookReceiver = yield* ClaudeHookReceiver;

  return makeClaudeDriver({ hookReceiver });
});
