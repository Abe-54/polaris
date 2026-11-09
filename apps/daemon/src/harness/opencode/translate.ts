/**
 * Turns one OpenCode session's `/event` payloads into `HarnessEvent`s, and
 * keeps what that needs: the Turn in flight and the open approvals.
 *
 * OpenCode has no Turn id. A Turn is the run from a user message while the
 * session is idle to the next `session.idle`; a user message while one is in
 * flight (Polaris's `steer`, or a message typed in `opencode attach`) joins it.
 */
import { RequestId, TurnId, TurnItem } from "@polaris/protocol";
import { HarnessEvent } from "../HarnessDriver.ts";
import {
  isPlaceholderTitle,
  permissionPrompt,
  planItem,
  questionPrompt,
  toolItem,
} from "./mapping.ts";
import * as P from "./protocol.ts";
import { OpenCodeContext } from "./context.ts";

const decodeEnvelope = P.decoder(P.Envelope);

const decodeSessionUpdated = P.decoder(P.SessionUpdated);

const decodeMessageUpdated = P.decoder(P.MessageUpdated);

const decodePartUpdated = P.decoder(P.PartUpdated);

const decodePart = P.decoder(P.Part);

const decodePartDelta = P.decoder(P.PartDelta);

const decodeStatus = P.decoder(P.SessionStatusChanged);

const decodeIdle = P.decoder(P.SessionIdle);

const decodeError = P.decoder(P.SessionError);

const decodeCompacted = P.decoder(P.SessionCompacted);

const decodePermission = P.decoder(P.PermissionRequest);

const decodePermissionReplied = P.decoder(P.PermissionReplied);

const decodeQuestion = P.decoder(P.QuestionRequest);

const decodeQuestionResolved = P.decoder(P.QuestionResolved);

/** Hoisted: the taggedEnum accessor builds a new constructor on every property read. */
const { ItemDelta } = HarnessEvent;

export interface ActiveTurn {
  readonly id: TurnId;
  /** `TurnStarted` has gone out (Turns Polaris sends are announced by the engine). */
  announced: boolean;
  /** OpenCode has taken it up; a `session.idle` before that belongs to the previous run. */
  begun: boolean;
  aborted: boolean;
  error: string | null;
  plan: TurnItem | null;
  /** The Model and variant Polaris sent it with, reused when steering; null for foreign Turns. */
  readonly model: { readonly providerID: string; readonly modelID: string } | null;
  readonly variant: string | null;
}

export type OpenRequest =
  | { readonly type: "permission"; readonly openId: string }
  | { readonly type: "question"; readonly openId: string; readonly request: P.QuestionRequest };

export interface Translator {
  /** Handles one `/event` payload; payloads for other sessions are ignored. */
  readonly handle: (payload: P.Payload) => void;
  readonly setSessionId: (sessionId: string) => void;
  readonly turn: () => ActiveTurn | null;
  /** A Turn Polaris is about to send; it begins when OpenCode records its user message. */
  readonly beginLocalTurn: (turn: Pick<ActiveTurn, "id" | "model" | "variant">) => void;
  readonly abandonLocalTurn: (turnId: TurnId) => void;
  /** A local Turn OpenCode never took up failed to start: it ends `failed` with `error`. */
  readonly failLocalTurn: (turnId: TurnId, error: string) => void;
  /** OpenCode was already busy when Polaris attached (a Turn started in the terminal). */
  readonly adoptRunningTurn: () => void;
  readonly openPermission: (request: P.PermissionRequest) => void;
  readonly openQuestion: (request: P.QuestionRequest) => void;
  /** Takes an open request to answer it; its later `replied` event is then not a withdrawal. */
  readonly takeRequest: (requestId: RequestId) => OpenRequest | null;
  /** The context window's use, reported as `ContextUsed`. */
  readonly context: OpenCodeContext;
}

const newTurnId = () => TurnId.make(crypto.randomUUID());

const newRequestId = () => RequestId.make(crypto.randomUUID());

export const translatorFor = (
  cwd: string,
  emit: (event: HarnessEvent) => void,
  initialSessionId: string | null
): Translator => {
  let sessionId = initialSessionId;
  let turn: ActiveTurn | null = null;
  let title: string | null = null;
  let errors = 0;
  const userMessages = new Set<string>();
  const pending = new Map<RequestId, OpenRequest>();
  const byOpenId = new Map<string, RequestId>();
  const context = new OpenCodeContext();

  const ours = <T extends { readonly sessionID?: string | undefined }>(p: T | null): p is T =>
    p !== null && sessionId !== null && p.sessionID === sessionId;

  const newTurn = (): ActiveTurn => ({
    id: newTurnId(),
    announced: false,
    begun: true,
    aborted: false,
    error: null,
    plan: null,
    model: null,
    variant: null,
  });

  const announce = (active: ActiveTurn, prompt: string | null) => {
    active.announced = true;
    emit(HarnessEvent.TurnStarted({ turnId: active.id, prompt }));
  };

  /** The Turn an event belongs to, starting (and announcing) a foreign one if none is in flight. */
  const current = (): ActiveTurn => {
    turn ??= newTurn();

    if (!turn.announced) announce(turn, null);

    return turn;
  };

  const onUserMessage = (messageId: string) => {
    if (userMessages.has(messageId)) return;
    userMessages.add(messageId);

    if (turn === null) turn = newTurn();
    else turn.begun = true;
  };

  const onUserText = (part: typeof P.TextPart.Type) => {
    if (turn !== null && !turn.announced && part.synthetic !== true) announce(turn, part.text);
  };

  const onIdle = () => {
    const active = turn;

    if (active === null || !active.begun) return;
    turn = null;

    if (active.plan !== null)
      emit(HarnessEvent.ItemCompleted({ turnId: active.id, item: active.plan }));

    if (!active.announced) announce(active, null);
    const status = active.aborted ? "interrupted" : active.error === null ? "completed" : "failed";
    emit(
      HarnessEvent.TurnEnded({
        turnId: active.id,
        status,
        error: active.aborted ? null : active.error,
      })
    );
  };

  const onText = (part: typeof P.TextPart.Type | typeof P.ReasoningPart.Type) => {
    if (part.type === "text" && (part.synthetic === true || part.ignored === true)) return;

    if (part.time?.end === undefined || part.text.trim() === "") return;

    const item =
      part.type === "text"
        ? TurnItem.cases.AssistantMessage.make({ id: part.id, text: part.text })
        : TurnItem.cases.Reasoning.make({
            id: part.id,
            text: part.text,
            startedAt: new Date(part.time.start).toISOString(),
            endedAt: new Date(part.time.end).toISOString(),
          });

    emit(HarnessEvent.ItemCompleted({ turnId: current().id, item }));
  };

  const onTool = (part: P.ToolPart) => {
    const active = current();

    if (part.tool === "todowrite") {
      const plan = planItem(`${active.id}:plan`, part.state.input);

      if (plan === null) return;
      active.plan = plan;
      emit(HarnessEvent.ItemUpdated({ turnId: active.id, item: plan }));

      return;
    }

    const item = toolItem(part, cwd);

    if (item === null) return;
    const running = part.state.status === "running";
    emit(
      running
        ? HarnessEvent.ItemUpdated({ turnId: active.id, item })
        : HarnessEvent.ItemCompleted({ turnId: active.id, item })
    );
  };

  const onUserPart = (part: P.Part) => {
    if (part.type === "text") onUserText(part);
    else if (part.type === "compaction") context.compactionStarted(part.auto);
  };

  const onAssistantPart = (part: P.Part) => {
    if (part.type === "tool") onTool(part);
    else if (part.type === "text" || part.type === "reasoning") onText(part);
    else if (part.type === "step-finish") {
      const report = context.stepFinished(part);

      if (report !== null) emit(report);
    }
  };

  const onPart = (properties: P.Payload) => {
    const update = decodePartUpdated(properties);

    if (!ours(update)) return;
    const part = decodePart(update.part);

    if (part === null) return;

    if (userMessages.has(part.messageID)) onUserPart(part);
    else onAssistantPart(part);
  };

  const resolved = (openId: string) => {
    const requestId = byOpenId.get(openId);

    if (requestId === undefined) return;
    byOpenId.delete(openId);

    // Still pending means someone else answered it (the terminal UI), or OpenCode withdrew it.
    if (pending.delete(requestId)) emit(HarnessEvent.ApprovalWithdrawn({ requestId }));
  };

  const open = (
    request: OpenRequest,
    prompt: ReturnType<typeof questionPrompt> | ReturnType<typeof permissionPrompt>
  ) => {
    if (byOpenId.has(request.openId)) return;
    const requestId = newRequestId();
    pending.set(requestId, request);
    byOpenId.set(request.openId, requestId);
    emit(
      HarnessEvent.ApprovalRequested({
        turnId: current().id,
        requestId,
        kind: prompt.kind,
        title: prompt.title,
        detail: prompt.detail,
        options: "options" in prompt ? prompt.options : [],
        questions: "questions" in prompt ? prompt.questions : [],
      })
    );
  };

  const openPermission = (request: P.PermissionRequest) =>
    open({ type: "permission", openId: request.id }, permissionPrompt(request));

  const openQuestion = (request: P.QuestionRequest) =>
    open({ type: "question", openId: request.id, request }, questionPrompt(request));

  const onError = (properties: P.Payload) => {
    const p = decodeError(properties);

    if (!ours(p) || p.error === undefined) return;

    if (p.error.name === "MessageAbortedError") {
      if (turn !== null) turn.aborted = true;

      return;
    }

    const message = p.error.data?.message ?? p.error.name;
    const active = current();
    active.error = message;
    emit(
      HarnessEvent.ItemCompleted({
        turnId: active.id,
        item: TurnItem.cases.Error.make({ id: `${active.id}:error:${++errors}`, message }),
      })
    );
  };

  const handlers = new Map<string, (properties: P.Payload) => void>([
    [
      "session.updated",
      (properties) => {
        const p = decodeSessionUpdated(properties);

        if (!ours(p) || p.info.title === title) return;
        title = p.info.title;

        if (!isPlaceholderTitle(title)) emit(HarnessEvent.TitleSuggested({ title }));
      },
    ],
    [
      "message.updated",
      (properties) => {
        const p = decodeMessageUpdated(properties);

        if (!ours(p)) return;

        if (p.info.role === "user") onUserMessage(p.info.id);
        else {
          context.assistantMessage(p.info);
          current();
        }
      },
    ],
    ["message.part.updated", onPart],
    [
      "message.part.delta",
      (properties) => {
        const p = decodePartDelta(properties);

        if (!ours(p) || p.field !== "text" || userMessages.has(p.messageID)) return;
        emit(ItemDelta({ turnId: current().id, itemId: p.partID, field: "text", text: p.delta }));
      },
    ],
    [
      "session.status",
      (properties) => {
        const p = decodeStatus(properties);

        if (!ours(p)) return;

        if (p.status.type === "idle") onIdle();
        else if (turn === null) turn = newTurn();
        else turn.begun = true;
      },
    ],
    ["session.idle", (properties) => ours(decodeIdle(properties)) && onIdle()],
    ["session.error", onError],
    [
      "session.compacted",
      (properties) => {
        if (!ours(decodeCompacted(properties))) return;
        const report = context.compacted();

        if (report !== null) emit(report);
      },
    ],
    [
      "permission.asked",
      (properties) => {
        const p = decodePermission(properties);

        if (ours(p)) openPermission(p);
      },
    ],
    [
      "permission.replied",
      (properties) => {
        const p = decodePermissionReplied(properties);

        if (ours(p)) resolved(p.requestID);
      },
    ],
    [
      "question.asked",
      (properties) => {
        const p = decodeQuestion(properties);

        if (ours(p)) openQuestion(p);
      },
    ],
    [
      "question.replied",
      (properties) => {
        const p = decodeQuestionResolved(properties);

        if (ours(p)) resolved(p.requestID);
      },
    ],
    [
      "question.rejected",
      (properties) => {
        const p = decodeQuestionResolved(properties);

        if (ours(p)) resolved(p.requestID);
      },
    ],
  ]);

  return {
    handle: (payload) => {
      const envelope = decodeEnvelope(payload);

      if (envelope !== null) handlers.get(envelope.type)?.(envelope.properties);
    },
    setSessionId: (id) => {
      sessionId = id;
    },
    turn: () => turn,
    beginLocalTurn: ({ id, model, variant }) => {
      turn = {
        id,
        announced: true,
        begun: false,
        aborted: false,
        error: null,
        plan: null,
        model,
        variant,
      };
    },
    abandonLocalTurn: (turnId) => {
      if (turn?.id === turnId) turn = null;
    },
    failLocalTurn: (turnId, error) => {
      if (turn?.id !== turnId || turn.begun) return;
      turn = null;
      emit(HarnessEvent.TurnEnded({ turnId, status: "failed", error }));
    },
    adoptRunningTurn: () => {
      turn ??= newTurn();
    },
    openPermission,
    openQuestion,
    context,
    takeRequest: (requestId) => {
      const request = pending.get(requestId);

      if (request === undefined) return null;
      pending.delete(requestId);

      return request;
    },
  };
};
