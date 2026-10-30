/**
 * One Agent Session's view of one Codex thread on the shared app-server.
 *
 * Each session opens its own connection, starts or rejoins its thread
 * (`thread/start` / `thread/resume`), and translates that thread's
 * notifications and server→client requests into `HarnessEvent`s. Because the
 * thread lives in the shared app-server, a `codex --remote` TUI can attach to
 * it at the same time; Turns the TUI starts show up here too.
 */
import {
  ApprovalDecision,
  type Attachment,
  type PermissionMode,
  RequestId,
  SECRET_REQUEST_MAX_TIMEOUT_MS,
  TurnId,
  TurnItem,
} from "@polaris/protocol";
import {
  type Cause,
  Data,
  Deferred,
  Effect,
  Option,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect";
import {
  type HarnessError,
  HarnessEvent,
  type HarnessSession,
  type OpenOptions,
  type TurnInput,
} from "../HarnessDriver.ts";
import { ItemClock } from "../itemClock.ts";
import { type AppServer, remoteTuiArgv } from "./AppServer.ts";
import {
  type CodexPlanLimits,
  onRateLimitsUpdated,
  RATE_LIMITS_UPDATED,
  readRateLimits,
} from "./planLimits.ts";
import {
  policyFor,
  readableError,
  sandboxPolicyFor,
  toPlanItem,
  toTurnItem,
  turnInput,
  userMessageText,
} from "./mapping.ts";
import * as P from "./protocol.ts";
import { type ApprovalPrompt, approvalPrompts } from "./approvalPrompts.ts";
import { codexError, Incoming, type RpcConnection } from "./RpcConnection.ts";
import { ReasoningTimes } from "./reasoning.ts";
import { CodexProcesses, terminateProcess } from "./processes.ts";
import { CodexCompaction } from "./compaction.ts";
import { CodexSteers } from "./steers.ts";
import { CodexSubagents } from "./subagents.ts";
import { requestCompat } from "./compat.ts";
import { collaborationFor, setCollaboration } from "./collaboration.ts";
import { threadSandboxing } from "./confinement.ts";
import { polarisInstructions } from "../../constellation/skills/preamble.ts";
import type { ConstellationAttachment } from "../constellation/attachment.ts";
import { type HarnessCall, harnessCallOf } from "./slash.ts";
import { logStart } from "../startLog.ts";
import type { BrowserMcp } from "../browser/index.ts";
import { codexBrowserConfig } from "./browser.ts";

export interface SessionConfig {
  readonly appServer: AppServer;
  readonly codexPath: string;
  readonly clientVersion: string;
  /** Where the account's Plan Limits go; null, they aren't read. */
  readonly planLimits: CodexPlanLimits | null;
  /** The Browser's MCP server for each thread that isn't read-only. */
  readonly browser?: BrowserMcp["Service"] | undefined;
}

type PendingRequest = Data.TaggedEnum<{
  Rpc: {
    readonly rpcId: P.RpcId;
    readonly respond: (decision: ApprovalDecision) => P.ServerRequestResponse;
  };
  /** An async question in an agent message; answered with a new user message. */
  AsyncQuestion: { readonly title: string };
}>;

const PendingRequest = Data.taggedEnum<PendingRequest>();

/** Above Codex's 60 s default, so a Secret Request can wait its full hour (ADR 0089). */
export const POLARIS_TOOL_TIMEOUT_SECONDS = SECRET_REQUEST_MAX_TIMEOUT_MS / 1000 + 60;

const isRpc = PendingRequest.$is("Rpc");

/** Hoisted: the taggedEnum accessor builds a new constructor on every property read. */
const { ItemDelta } = HarnessEvent;

const decode = <S extends Schema.Decoder<unknown>>(schema: S) => {
  const decodeOption = Schema.decodeUnknownOption(schema);

  return (input: P.RpcPayload): S["Type"] | null => Option.getOrNull(decodeOption(input));
};

/** A Polaris MCP server's config; `visualize` runs unasked under every policy, plan included. */
const polarisServer = (attachment: ConstellationAttachment) => {
  const server = { url: attachment.url, tool_timeout_sec: POLARIS_TOOL_TIMEOUT_SECONDS };

  return attachment.tools.some((t) => t.name === "visualize")
    ? { ...server, tools: { visualize: { approval_mode: "approve" } } }
    : server;
};

const decodeInitialize = decode(P.InitializeResponse);

const decodeThread = decode(P.ThreadResponse);

const decodeTurnStart = decode(P.TurnStartResponse);

const decodeReviewStart = decode(P.ReviewStartResponse);

const decodeTurnStarted = decode(P.TurnStartedNotification);

const decodeTurnCompleted = decode(P.TurnCompletedNotification);

const decodeItem = decode(P.ItemNotification);

const decodeDelta = decode(P.DeltaNotification);

const decodePlan = decode(P.TurnPlanUpdatedNotification);

const decodeTokenUsage = decode(P.ThreadTokenUsageUpdatedNotification);

const decodeResolved = decode(P.ServerRequestResolvedNotification);

const decodeError = decode(P.ErrorNotification);

const decodeName = decode(P.ThreadNameUpdatedNotification);

const newTurnId = () => TurnId.make(crypto.randomUUID());

const newRequestId = () => RequestId.make(crypto.randomUUID());

/** Items whose text streams as deltas; the others show live progress while running. */
const isStreamedText = TurnItem.isAnyOf(["AssistantMessage", "Reasoning"]);

const isCommand = Schema.is(P.CommandExecutionItem);

type ItemNotification = typeof P.ItemNotification.Type;

type AgentMessage = typeof P.AgentMessageItem.Type;

/** The questions of an async agent message, which the user may answer later. */
const asyncQuestions = (item: P.ThreadItem): AgentMessage["questions"] =>
  item.type === "agentMessage" && "delivery" in item && item.delivery === "async"
    ? item.questions
    : null;

export const openSession = (
  config: SessionConfig,
  options: OpenOptions
): Effect.Effect<HarnessSession, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<HarnessEvent, Cause.Done>();
    const clock = new ItemClock();

    const emit = (event: HarnessEvent) => {
      Queue.offerUnsafe(events, clock.stamp(event));
    };

    yield* logStart(options.sessionId, `connecting to the Codex app-server (${config.codexPath})`);
    const conn: RpcConnection = yield* config.appServer.connect;

    const initialized = yield* conn.request("initialize", {
      clientInfo: { name: "polaris", title: "Polaris", version: config.clientVersion },
      capabilities: { experimentalApi: false, requestAttestation: false },
    } satisfies P.ClientParams["initialize"]);

    yield* conn.notify("initialized");

    if (config.planLimits) yield* Effect.forkScoped(readRateLimits(conn, config.planLimits));

    let permissionMode: PermissionMode = options.permissionMode;
    const policy = policyFor(permissionMode, options.readOnly);

    const sandboxing = yield* threadSandboxing({
      readOnly: options.readOnly,
      sandbox: policy.sandbox,
      userAgent: decodeInitialize(initialized)?.userAgent ?? "",
      cwd: options.cwd,
      readConfig: conn.request("config/read", { cwd: options.cwd, includeLayers: false }),
    });

    const common: Pick<
      P.ClientParams["thread/start"],
      | "cwd"
      | "approvalPolicy"
      | "approvalsReviewer"
      | "sandbox"
      | "model"
      | "serviceTier"
      | "developerInstructions"
      | "config"
    > = {
      cwd: options.cwd,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      ...sandboxing.mode,
    };

    const attachments =
      options.constellations ??
      (options.constellation === undefined ? [] : [options.constellation]);

    if (attachments.length > 0 && options.readOnly !== true) {
      if (attachments.some((a) => a.sessionId !== options.sessionId))
        return yield* codexError("Constellation attachment belongs to another session");
      common.config = Object.fromEntries(
        attachments.map((a, index) => [
          `mcp_servers.polaris${index === 0 ? "" : `_${index}`}`,
          polarisServer(a),
        ])
      );
    }

    const browser = yield* codexBrowserConfig(config.browser, options);

    common.developerInstructions = polarisInstructions(options);

    if (
      options.environment !== undefined &&
      Object.keys(options.environment).length > 0 &&
      options.readOnly !== true
    )
      common.config = { ...common.config, "shell_environment_policy.set": options.environment };

    const extra = { ...browser, ...sandboxing.config };

    if (Object.keys(extra).length > 0) common.config = { ...common.config, ...extra };

    if (options.model !== null) common.model = options.model;

    if (options.serviceTier != null) common.serviceTier = options.serviceTier;

    // Without the fields an older app-server may refuse (compat.ts): approvals go to the user.
    const { approvalsReviewer: _reviewer, ...olderCommon } = common;

    const threadResult =
      options.resumeCursor === null
        ? yield* requestCompat(
            conn,
            "thread/start",
            { ...common, serviceName: "polaris" } satisfies P.ClientParams["thread/start"],
            olderCommon satisfies P.ClientParams["thread/start"]
          )
        : yield* requestCompat(
            conn,
            "thread/resume",
            {
              ...common,
              threadId: options.resumeCursor,
              excludeTurns: true,
            } satisfies P.ClientParams["thread/resume"],
            {
              ...olderCommon,
              threadId: options.resumeCursor,
            } satisfies P.ClientParams["thread/resume"]
          );

    const thread = decodeThread(threadResult);

    if (thread === null) return yield* codexError("Unexpected thread/start response from Codex");
    const threadId = thread.thread.id;
    const threadModel = thread.model ?? null;
    /** The collaboration mode the thread was last left in. */
    let collaboration = thread.collaborationMode?.mode ?? "default";
    yield* logStart(
      options.sessionId,
      `Codex thread ${threadId} ${options.resumeCursor === null ? "started" : "resumed"}; ready`
    );
    emit(HarnessEvent.CursorAssigned({ cursor: threadId }));

    // --- Turn bookkeeping -------------------------------------------------
    const turns = new Map<string, TurnId>(); // Codex turn id → Polaris TurnId
    /** Codex turns whose `TurnStarted` was emitted. */
    const announced = new Set<string>();
    const plans = new Map<string, typeof P.TurnPlanUpdatedNotification.Type>();
    const reasoning = new ReasoningTimes();
    let activeCodexTurn: string | null = null;
    /** A Turn Polaris is starting (`turn/start` in flight), with the prompt it sent. */
    let pendingLocalTurn: { readonly turnId: TurnId; readonly prompt: string } | null = null;
    const endedTurns = new Set<string>();
    /** A review's Codex turn: Codex runs it under a second turn id, whose events join it. */
    let reviewTurn: string | null = null;
    const compaction = new CodexCompaction();
    let errorCount = 0;
    const subagents = new CodexSubagents();
    const steers = new CodexSteers();
    const processes = new CodexProcesses();

    const backgroundChanged = (changed: boolean) => {
      if (changed) emit(HarnessEvent.BackgroundTasksChanged({ tasks: processes.tasks() }));
    };

    const announce = (codexTurnId: string, prompt: string | null) => {
      const turnId = turns.get(codexTurnId);

      if (turnId === undefined || announced.has(codexTurnId)) return;
      announced.add(codexTurnId);

      for (const [other, bound] of turns)
        if (bound === turnId && other !== codexTurnId && announced.has(other)) return;
      emit(HarnessEvent.TurnStarted({ turnId, prompt }));
    };

    /**
     * Maps a Codex turn to a Polaris Turn. Turns Polaris started are announced with
     * their prompt at once. A Turn started elsewhere (the TUI) is announced when its
     * user message arrives, so it carries what was typed; with `announce` (anything
     * else happening in the Turn, e.g. when rejoining mid-Turn) it is announced
     * without one.
     */
    const turnFor = (codexTurnId: string, options?: { readonly announce: boolean }): TurnId => {
      let turnId = turns.get(codexTurnId);

      if (turnId === undefined) {
        const local = pendingLocalTurn;
        pendingLocalTurn = null;
        turnId = local?.turnId ?? newTurnId();
        turns.set(codexTurnId, turnId);

        if (!endedTurns.has(codexTurnId)) activeCodexTurn = codexTurnId;

        if (local !== null) announce(codexTurnId, local.prompt);
      }

      if (options?.announce !== false) announce(codexTurnId, null);

      return turnId;
    };

    /** Live progress for items with a visible running state; text streams as deltas instead. */
    const progressOf = (item: P.ThreadItem) => {
      const mapped = toTurnItem(item);

      return mapped === null || isStreamedText(mapped) ? null : mapped;
    };

    // --- Approvals --------------------------------------------------------
    const pending = new Map<RequestId, PendingRequest>();
    const byRpcId = new Map<string, RequestId>();

    /**
     * The Polaris Turn a server request belongs to. A Subagent's request names its
     * own thread's turn, never a Turn of ours: it goes to the Turn that spawned the
     * Subagent, or the one in flight when the parent hasn't reported it yet.
     */
    const requestTurn = (requestThread: string, codexTurnId: string | null): TurnId => {
      if (requestThread === threadId) return turnFor(codexTurnId ?? activeCodexTurn ?? "");
      const scope = subagents.scopeOf(requestThread);

      if (scope !== undefined) return scope.turnId;
      const known = codexTurnId === null ? undefined : turns.get(codexTurnId);

      return known ?? turnFor(activeCodexTurn ?? codexTurnId ?? "");
    };

    const openRequest = (rpcId: P.RpcId, turnId: TurnId, prompt: ApprovalPrompt) => {
      const requestId = newRequestId();
      pending.set(requestId, PendingRequest.Rpc({ rpcId, respond: prompt.respond }));
      byRpcId.set(String(rpcId), requestId);
      emit(
        HarnessEvent.ApprovalRequested({
          turnId,
          requestId,
          kind: prompt.kind,
          title: prompt.title,
          detail: prompt.detail,
          options: prompt.options,
          questions: prompt.questions ?? [],
        })
      );
    };

    const handleRequest = (id: P.RpcId, method: string, params: P.RpcPayload) => {
      const toPrompt = approvalPrompts.get(method);

      // Dynamic tools, attestation and ChatGPT token refresh are never enabled by Polaris,
      // and Polaris never handles credentials.
      if (toPrompt === undefined)
        return conn.respondError(id, -32601, `Polaris does not handle ${method}`);
      const request = toPrompt(params);

      if (request === null)
        return conn.respondError(id, -32602, `Polaris could not read ${method}`);

      if (options.readOnly === true)
        return conn.respond(
          id,
          request.prompt.respond(
            ApprovalDecision.cases.Deny.make({ reason: "The Reviewer never requests permission." })
          )
        );
      openRequest(id, requestTurn(request.threadId, request.turnId), request.prompt);

      return Effect.void;
    };

    // --- Notifications ----------------------------------------------------
    const ours = <T extends { readonly threadId: string }>(p: T | null): p is T =>
      p !== null && p.threadId === threadId;

    const onUserMessage = (p: ItemNotification) => {
      turnFor(p.turnId, { announce: false });
      const text = userMessageText(p.item);
      announce(p.turnId, text);
      steers.fromItem(p.turnId, p.item.id ?? `text:${text}`, text);
    };

    /** Steers the model has now read land just before what it does next. */
    const landSteers = (turnId: TurnId, landed: ReadonlyArray<TurnItem>) => {
      for (const item of landed) emit(HarnessEvent.ItemCompleted({ turnId, item }));
    };

    const openAsyncQuestions = (turnId: TurnId, item: P.ThreadItem) => {
      for (const question of asyncQuestions(item) ?? []) {
        const requestId = newRequestId();
        pending.set(requestId, PendingRequest.AsyncQuestion({ title: question.title }));
        emit(
          HarnessEvent.ApprovalRequested({
            turnId,
            requestId,
            kind: "question",
            title: question.title,
            detail: null,
            options: question.options ?? [],
          })
        );
      }
    };

    /** An item on a Subagent's thread: the Subagent's own (what it was asked is skipped). */
    const onSubagentItem = (p: ItemNotification, completed: boolean) => {
      const scope = subagents.scopeOf(p.threadId);
      const item = scope && (completed ? toTurnItem(p.item) : progressOf(p.item));

      if (!scope || !item) return;
      emit((completed ? HarnessEvent.ItemCompleted : HarnessEvent.ItemUpdated)({ ...scope, item }));
    };

    const onItemStarted = (params: P.RpcPayload) => {
      const p = decodeItem(params);

      if (p === null) return;

      if (p.threadId !== threadId) return onSubagentItem(p, false);

      if (p.item.type === "userMessage") return onUserMessage(p);

      if (p.item.type === "contextCompaction") compaction.started();
      const turnId = turnFor(p.turnId);
      landSteers(turnId, steers.take(p.turnId));
      backgroundChanged(
        isCommand(p.item)
          ? processes.commandStarted(p.item.id, p.item.command, p.item.processId ?? null)
          : processes.itemStarted(p.item.id ?? "")
      );

      const item =
        p.item.type === "reasoning" && p.item.id !== undefined
          ? reasoning.start(p.item.id, p.startedAtMs)
          : progressOf(p.item);

      if (item !== null) emit(HarnessEvent.ItemUpdated({ turnId, item }));

      for (const event of subagents.fromParentItem(turnId, p.item)) emit(event);
    };

    const onItemCompleted = (params: P.RpcPayload) => {
      const p = decodeItem(params);

      if (p === null) return;

      if (p.threadId !== threadId) return onSubagentItem(p, true);

      if (p.item.type === "userMessage") return onUserMessage(p);

      if (p.item.type === "contextCompaction") {
        const report = compaction.completed();

        if (report !== null) emit(report);
      }

      const turnId = turnFor(p.turnId);
      const item = toTurnItem(p.item);

      if (item !== null)
        emit(HarnessEvent.ItemCompleted({ turnId, item: reasoning.finish(item, p.completedAtMs) }));

      if (isCommand(p.item)) backgroundChanged(processes.completed(p.item.id));

      for (const event of subagents.fromParentItem(turnId, p.item)) emit(event);
      openAsyncQuestions(turnId, p.item);
    };

    const onDelta = (field: "text" | "output") => (params: P.RpcPayload) => {
      const p = decodeDelta(params);

      if (p === null) return;

      const scope =
        p.threadId === threadId ? { turnId: turnFor(p.turnId) } : subagents.scopeOf(p.threadId);

      if (scope) emit(ItemDelta({ ...scope, itemId: p.itemId, field, text: p.delta }));
    };

    const onTurnCompleted = (params: P.RpcPayload) => {
      const p = decodeTurnCompleted(params);

      if (!ours(p)) return;
      const turnId = turnFor(p.turn.id);
      const plan = plans.get(p.turn.id);

      if (plan !== undefined) {
        emit(HarnessEvent.ItemCompleted({ turnId, item: toPlanItem(`${p.turn.id}:plan`, plan) }));
        plans.delete(p.turn.id);
      }

      endedTurns.add(p.turn.id);
      landSteers(turnId, steers.end(p.turn.id));
      backgroundChanged(processes.turnEnded());

      if (activeCodexTurn === p.turn.id) activeCodexTurn = null;

      if (reviewTurn === p.turn.id) reviewTurn = null;
      emit(
        HarnessEvent.TurnEnded({
          turnId,
          status: p.turn.status === "inProgress" ? "completed" : p.turn.status,
          error: p.turn.error ? readableError(p.turn.error.message) : null,
          // The reset comes from Codex's Plan Limits, read by the engine.
          limit:
            p.turn.error?.codexErrorInfo === "usageLimitExceeded" ? { resetsAt: null } : undefined,
        })
      );
    };

    const notificationHandlers = new Map<string, (params: P.RpcPayload) => void>([
      [
        "thread/name/updated",
        (params) => {
          const p = decodeName(params);

          if (ours(p) && p.threadName) emit(HarnessEvent.TitleSuggested({ title: p.threadName }));
        },
      ],
      [
        "turn/started",
        (params) => {
          const p = decodeTurnStarted(params);

          if (p === null) return;

          if (p.threadId !== threadId) {
            // A Subagent's own turn belongs to the Polaris Turn that spawned it (its approvals too).
            const scope = subagents.scopeOf(p.threadId);

            if (scope) {
              turns.set(p.turn.id, scope.turnId);
              announced.add(p.turn.id);
            }

            return;
          }

          if (reviewTurn !== null && p.turn.id !== reviewTurn) {
            turns.set(p.turn.id, turnFor(reviewTurn, { announce: false }));
            announced.add(p.turn.id);
            activeCodexTurn = reviewTurn;

            return;
          }

          activeCodexTurn = p.turn.id;
          // A Turn started elsewhere is announced with its user message, which comes next.
          turnFor(p.turn.id, { announce: false });
        },
      ],
      ["item/started", onItemStarted],
      ["item/agentMessage/delta", onDelta("text")],
      ["item/plan/delta", onDelta("text")],
      ["item/reasoning/summaryTextDelta", onDelta("text")],
      ["item/reasoning/textDelta", onDelta("text")],
      ["item/commandExecution/outputDelta", onDelta("output")],
      ["item/completed", onItemCompleted],
      [
        "turn/plan/updated",
        (params) => {
          const p = decodePlan(params);

          if (!ours(p)) return;
          plans.set(p.turnId, p);
          emit(
            HarnessEvent.ItemUpdated({
              turnId: turnFor(p.turnId),
              item: toPlanItem(`${p.turnId}:plan`, p),
            })
          );
        },
      ],
      [
        "error",
        (params) => {
          const p = decodeError(params);

          if (!ours(p) || p.willRetry) return;
          emit(
            HarnessEvent.ItemCompleted({
              turnId: turnFor(p.turnId),
              item: TurnItem.cases.Error.make({
                id: `${p.turnId}:error:${++errorCount}`,
                message: readableError(p.error.message),
              }),
            })
          );
        },
      ],
      [
        "serverRequest/resolved",
        (params) => {
          const p = decodeResolved(params);

          if (p === null) return;
          const requestId = byRpcId.get(String(p.requestId));

          if (requestId === undefined) return;
          byRpcId.delete(String(p.requestId));

          // Still pending means someone else (the TUI, or Codex itself) resolved it.
          if (pending.delete(requestId)) emit(HarnessEvent.ApprovalWithdrawn({ requestId }));
        },
      ],
      ["turn/completed", onTurnCompleted],
      [
        "thread/tokenUsage/updated",
        (params) => {
          const p = decodeTokenUsage(params);

          if (!ours(p)) return;
          const { last, modelContextWindow } = p.tokenUsage;
          compaction.usageReported(last.totalTokens, modelContextWindow);
          emit(
            HarnessEvent.ContextUsed({
              usedTokens: last.totalTokens,
              windowTokens: modelContextWindow,
            })
          );
        },
      ],
    ]);

    if (config.planLimits)
      notificationHandlers.set(RATE_LIMITS_UPDATED, onRateLimitsUpdated(config.planLimits));

    const handle = Incoming.$match({
      Request: (message) => handleRequest(message.id, message.method, message.params),
      Notification: (message) =>
        Effect.sync(() => notificationHandlers.get(message.method)?.(message.params)),
    });

    let closing = false;
    let finished = false;

    const finish = (error: string | null) => {
      if (finished) return;
      finished = true;
      emit(HarnessEvent.Exited({ error }));
      Queue.endUnsafe(events);
    };

    // Ends on its own when the connection closes (the app-server exited or dropped us).
    yield* Stream.fromQueue(conn.incoming).pipe(
      Stream.runForEach((message) => handle(message).pipe(Effect.ignore)),
      Effect.andThen(Deferred.await(conn.closed)),
      Effect.tap((reason) => Effect.sync(() => finish(closing ? null : reason))),
      Effect.forkScoped
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closing = true;
        yield* conn
          .request("thread/unsubscribe", {
            threadId,
          } satisfies P.ClientParams["thread/unsubscribe"])
          .pipe(Effect.timeout("2 seconds"), Effect.ignore);
        finish(null);
      })
    );

    // --- Commands ---------------------------------------------------------
    /** The Model and effort of the latest Turn Polaris sent; answers to async questions reuse them. */
    let chosen: Pick<TurnInput, "model" | "effort" | "serviceTier"> = {
      model: options.model,
      effort: options.effort,
      serviceTier: options.serviceTier ?? null,
    };

    /** Plan mode (or leaving it) before a Turn; failing leaves the Turn supervised, which still asks. */
    const applyCollaboration = Effect.suspend(() => {
      const mode = collaborationFor(permissionMode, options.readOnly);
      const model = chosen.model ?? threadModel;

      if ((mode === "default" && collaboration === "default") || model === null) return Effect.void;

      return setCollaboration(config.appServer, config.clientVersion, {
        threadId,
        collaborationMode: {
          mode,
          settings: { model, reasoning_effort: chosen.effort, developer_instructions: null },
        },
      }).pipe(
        Effect.andThen(Effect.sync(() => (collaboration = mode))),
        Effect.catch((error) =>
          Effect.logWarning(`codex: couldn't set the ${mode} collaboration mode`, error.message)
        )
      );
    });

    /** Binds the Codex turn a request started to the Polaris Turn, and announces it. */
    const bindStarted = (codexTurnId: string, turnId: TurnId, prompt: string) => {
      if (!turns.has(codexTurnId)) turns.set(codexTurnId, turnId);
      announce(codexTurnId, prompt);

      if (!endedTurns.has(codexTurnId)) activeCodexTurn ??= codexTurnId;
    };

    /** `/compact` and `/review` (`slash.ts`): Codex's own calls, each running as a Turn. */
    const startHarnessCall = (turnId: TurnId, prompt: string, call: HarnessCall) =>
      Effect.gen(function* () {
        compaction.request(call.method === "thread/compact/start");

        const result = yield* conn.request(call.method, call.params).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              pendingLocalTurn = null;
              compaction.request(false);
            })
          )
        );

        // Compaction's Turn arrives as `turn/started` and takes the pending Turn there.
        if (call.method === "thread/compact/start") return;
        pendingLocalTurn = null;
        const started = decodeReviewStart(result);

        if (started === null)
          return yield* codexError("Unexpected review/start response from Codex");
        bindStarted(started.turn.id, turnId, prompt);

        if (endedTurns.has(started.turn.id)) return;
        // Its inner turn may have started first and taken the Turn; the review's id is the one that ends.
        reviewTurn = started.turn.id;
        activeCodexTurn = started.turn.id;
      });

    const startTurn = (turnId: TurnId, prompt: string, input: ReturnType<typeof turnInput>) =>
      Effect.gen(function* () {
        if (activeCodexTurn !== null || pendingLocalTurn !== null)
          return yield* codexError("A Turn is already in progress; steer or interrupt it");
        const policy = policyFor(permissionMode, options.readOnly);
        pendingLocalTurn = { turnId, prompt };
        yield* applyCollaboration;
        const call = harnessCallOf(prompt, threadId);

        if (call !== null) return yield* startHarnessCall(turnId, prompt, call);

        const params: P.ClientParams["turn/start"] = {
          threadId,
          input,
          approvalPolicy: policy.approvalPolicy,
          approvalsReviewer: policy.approvalsReviewer,
        };

        // A legacy policy here would replace a read-only thread's profile for good.
        if (options.readOnly !== true) params.sandboxPolicy = sandboxPolicyFor(policy.sandbox);

        // Codex keeps a Turn's overrides for the thread's later Turns; null leaves them as they are.
        if (chosen.model !== null) params.model = chosen.model;

        if (chosen.effort !== null) params.effort = chosen.effort;

        if (chosen.serviceTier != null) params.serviceTier = chosen.serviceTier;

        const { approvalsReviewer: _reviewer, effort: _effort, ...older } = params;

        const result = yield* requestCompat(conn, "turn/start", params, older).pipe(
          Effect.ensuring(Effect.sync(() => (pendingLocalTurn = null)))
        );

        const started = decodeTurnStart(result);

        if (started === null) return yield* codexError("Unexpected turn/start response from Codex");
        bindStarted(started.turn.id, turnId, prompt);
      });

    const steerText = (text: string, attachments: ReadonlyArray<Attachment> = []) =>
      Effect.gen(function* () {
        const codexTurnId = activeCodexTurn;

        if (codexTurnId === null) return yield* codexError("No Turn is in progress to steer");
        const input = turnInput(text, attachments);
        yield* conn.request("turn/steer", {
          threadId,
          input,
          expectedTurnId: codexTurnId,
        } satisfies P.ClientParams["turn/steer"]);
        // What Codex echoes: its text inputs, the files' note included.
        const sent = input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
        steers.fromResponse(
          codexTurnId,
          sent,
          attachments.length === 0 ? null : { text, attachments }
        );
      });

    const session: HarnessSession = {
      events: Stream.fromQueue(events),
      sendTurn: (input: TurnInput) =>
        Effect.suspend(() => {
          chosen = {
            model: input.model,
            effort: input.effort,
            serviceTier: input.serviceTier ?? null,
          };

          return startTurn(input.turnId, input.prompt, turnInput(input.prompt, input.attachments));
        }),
      steer: steerText,
      stopBackground: (taskIds) =>
        Effect.forEach(
          taskIds.flatMap((id) => processes.processOf(id) ?? []),
          (processId) =>
            terminateProcess(config.appServer, config.clientVersion, threadId, processId),
          { discard: true }
        ),
      interrupt: Effect.suspend(() =>
        activeCodexTurn === null
          ? Effect.void
          : conn
              .request("turn/interrupt", {
                threadId,
                turnId: activeCodexTurn,
              } satisfies P.ClientParams["turn/interrupt"])
              .pipe(Effect.asVoid)
      ),
      respond: (requestId, decision) =>
        Effect.gen(function* () {
          const request = pending.get(requestId);

          if (request === undefined)
            return yield* codexError(
              `No open Codex request ${requestId}; it may have been resolved`
            );
          pending.delete(requestId);

          if (isRpc(request)) {
            yield* conn.respond(request.rpcId, request.respond(decision));

            return;
          }

          // Async questions are answered with a new user message, never an RPC response.
          if (!ApprovalDecision.guards.Answer(decision)) return;

          if (activeCodexTurn !== null) yield* steerText(decision.text);
          else yield* startTurn(newTurnId(), decision.text, turnInput(decision.text, []));
        }),
      setPermissionMode: (mode) =>
        Effect.sync(() => {
          // Applied with the next `turn/start`, whose overrides persist on the thread.
          permissionMode = mode;
        }),
      terminalCommand: Effect.sync(() =>
        remoteTuiArgv(config.appServer, config.codexPath, threadId)
      ),
    };

    return session;
  });
