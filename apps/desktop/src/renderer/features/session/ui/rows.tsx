/**
 * The conversation's row kinds: a folded Turn, the user's prompt, an agent
 * item (the first one carries the Harness avatar), an inline approval or
 * question, how an interrupted or failed Turn ended, and background waits.
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  CelestialBody,
  SessionId,
  SessionState,
} from "@polaris/protocol";
import {
  ApprovalCard,
  BranchIcon,
  Button,
  ChevronDownIcon,
  ChevronRightIcon,
  cn,
  CopyIcon,
  type Harness,
  harnessHue,
  Celestial,
  PixelFailedIcon,
  PixelHandIcon,
  QuestionCard,
  Tile,
} from "@polaris/ui";
import { age } from "../../../shell/copy.ts";
import { SentAttachments } from "../../attachments/index.ts";
import { useNow } from "../../../shell/useNow.ts";
import { Decisions } from "../../../commands.ts";
import { type Row, turnReceipt, turnTime } from "../model/conversation.ts";
import { totals } from "../model/diff.ts";
import { plural } from "../model/format.ts";
import { useTurnDiff } from "../turnDiff.ts";
import { answerDecision, questionSteps, questionViews } from "../model/question.ts";
import type { OutboxActions } from "../outbox.ts";
import type { Entry } from "../model/runs.ts";
import { Trigger, Waiting } from "./background.tsx";
import { SetupCard } from "./SetupCard.tsx";
import { Command } from "./command.tsx";
import { EntryView } from "./entries.tsx";
import { OutgoingMessage, Steered } from "./outgoing.tsx";
import { softWrap } from "./softWrap.tsx";
import { SessionTargetContext } from "./polarisTool/target.ts";
import { PromptMenu, TurnMenu } from "./turnMenu.tsx";
import { LimitCard, type UsageLimit } from "./LimitCard.tsx";
import { SecretCard, SettledSecretCard } from "./SecretCard.tsx";
import { SourcesPill } from "./sources.tsx";
import type { SecretOutcome } from "../model/secret.ts";
import { provideSecret } from "../secrets.ts";
import type { SessionChrome } from "../chrome.ts";

export interface RowContext {
  readonly harness: Harness | null;
  /** The session's Celestial, on the agent's Turns. */
  readonly celestial: CelestialBody;
  readonly state: SessionState;
  /** The Daemon's Turn in flight, whose avatar shimmers; null between Turns. */
  readonly liveTurnId: string | null;
  readonly where: string;
  /** Opens or folds a Turn; it stays so as newer Turns arrive. */
  readonly onSetTurnOpen: (turnId: string, open: boolean) => void;
  readonly onOpenDiff: (turnId: string) => void;
  /** Opens a Subagent in Output's Subagent tab. */
  readonly onOpenSubagent: (subagentId: string) => void;
  readonly onRespond: (request: ApprovalRequest, decision: ApprovalDecision) => void;
  readonly onContinue: () => void;
  /** The session is Limited: its last Turn ends with the usage-limit card. */
  readonly limit: UsageLimit | null;
  /** Asks again for the Turns before the first one shown, after a failure. */
  readonly onLoadOlder: () => void;
  readonly onRetry: () => void;
  /** "Opus 5 · high", as the Harness names them. */
  readonly modelLabel: (model: string | null, effort: string | null) => string;
  /** A Turn is in flight that takes steers (a failed steer retries as one). */
  readonly canSteer: boolean;
  readonly outbox: Pick<OutboxActions, "retry" | "edit">;
  /** Where a folded Turn's diff comes from, for its +/− counts. */
  readonly diff: { readonly hostKey: string; readonly cwd: string; readonly sessionId: SessionId };
  /** Polaris-authored Turns and the closing row, from the session's chrome (`chrome.ts`). */
  readonly chrome: SessionChrome;
  /** The latest finished Turn: its folded row keeps its actions at rest. */
  readonly latestDoneTurnId: string | null;
  readonly onCopyTurn: (turnId: string) => void;
  /** Forks from a Turn; null when the Host or Harness can't. */
  readonly onForkTurn: ((turnId: string) => void) | null;
}

const AVATAR = "w-6 shrink-0";

/** A folded Turn's +/− from its diff, every Turn in it (cached, so reopening a session paints them at once). */
const SummaryCounts = ({
  row,
  ctx,
}: {
  row: Extract<Row, { kind: "summary" }>;
  ctx: RowContext;
}) => {
  const state = useTurnDiff(
    ctx.diff.hostKey,
    ctx.diff.cwd,
    ctx.diff.sessionId,
    { first: row.turnId, last: row.lastTurnId },
    `${row.status}:${row.lastTurnId}`
  );

  if (state.kind !== "ready" || state.files.length === 0)
    return row.files === 0 ? null : (
      <span className="text-caption text-text-subtle tabular">{plural(row.files, "file")}</span>
    );
  const sum = totals(state.files);

  return (
    <span
      className="text-code-inline tabular flex shrink-0 gap-1.5 font-mono"
      data-testid="turn-counts"
    >
      <span className="text-diff-added-text">+{sum.added}</span>
      <span className="text-diff-removed-text">−{sum.removed}</span>
    </span>
  );
};

const ACTION =
  "text-text-subtle hover:text-text-default hover:bg-fill-hover grid size-[26px] shrink-0 cursor-default place-items-center rounded-full";

/** Shown on hover or keyboard focus within the row, and always for the latest finished Turn. */
const RECEIPT_SHOWN =
  "hidden group-hover/summary:flex group-focus-within/summary:flex group-data-[rest=true]/summary:flex";

/** Copy and fork, quiet until the row is hovered or focused; the latest finished Turn keeps them. */
const SummaryActions = ({
  row,
  ctx,
  rest,
}: {
  row: Extract<Row, { kind: "summary" }>;
  ctx: RowContext;
  rest: boolean;
}) => (
  <span className={cn("flex shrink-0 items-center gap-0.5", !rest && RECEIPT_SHOWN)}>
    <TurnTime iso={row.startedAt} />
    <button
      type="button"
      aria-label={`Copy turn ${row.number} output`}
      title="Copy turn output"
      className={cn(ACTION, "ml-2")}
      onClick={() => ctx.onCopyTurn(row.turnId)}
    >
      <CopyIcon size={13} />
    </button>
    {ctx.onForkTurn === null ? null : (
      <button
        type="button"
        aria-label={`Fork from turn ${row.number}`}
        title="Fork from this turn"
        className={ACTION}
        onClick={() => ctx.onForkTurn?.(row.lastTurnId)}
      >
        <BranchIcon size={13} />
      </button>
    )}
  </span>
);

/** A folded Turn: its summary line at rest; hovered, its receipt, time and actions (Paper X-D). */
const Summary = ({ row, ctx }: { row: Extract<Row, { kind: "summary" }>; ctx: RowContext }) => {
  const receipt = row.status === "working" ? "" : turnReceipt(row);
  const rest = row.lastTurnId === ctx.latestDoneTurnId;

  return (
    <div
      className="group/summary rounded-card text-caption text-text-subtle hover:bg-fill-hover flex h-10 w-full items-center gap-3 bg-[light-dark(#00000008,#ffffff0e)] pr-4 pl-3.5"
      data-rest={rest}
      data-testid="turn-summary"
    >
      <button
        type="button"
        onClick={() => ctx.onSetTurnOpen(row.turnId, true)}
        aria-label={`Turn ${row.number}: ${row.summary}`}
        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-3 text-left"
      >
        {ctx.harness === null ? null : (
          <Celestial body={ctx.celestial} harness={ctx.harness} size={16} dormant />
        )}
        <span className="text-body text-text-subtle tabular shrink-0 font-medium">
          Turn {row.number}
        </span>
        <span
          className={cn(
            "text-body text-text-subtle min-w-0 flex-1 truncate",
            receipt !== "" && "group-hover/summary:hidden group-focus-within/summary:hidden"
          )}
        >
          {row.summary}
        </span>
        {receipt === "" ? null : (
          <span
            className="text-caption text-text-subtle tabular hidden min-w-0 flex-1 truncate font-mono group-focus-within/summary:block group-hover/summary:block"
            data-testid="turn-receipt"
          >
            {receipt}
          </span>
        )}
        {row.status === "completed" ? null : <span className="shrink-0">{row.status}</span>}
        <span className="group-focus-within/summary:hidden group-hover/summary:hidden">
          <SummaryCounts row={row} ctx={ctx} />
        </span>
      </button>
      <SummaryActions row={row} ctx={ctx} rest={rest} />
      <ChevronRightIcon size={10} className="text-text-faint shrink-0" />
    </div>
  );
};

/** When the Turn started; the full date and time on hover. */
const TurnTime = ({ iso }: { iso: string }) => {
  const text = turnTime(iso, new Date());

  return text === "" ? null : (
    <time
      dateTime={iso}
      title={new Date(iso).toLocaleString()}
      className="tabular shrink-0"
      data-testid="turn-time"
    >
      {text}
    </time>
  );
};

/** Folds an open Turn to its summary; quiet until the row is hovered or focused. */
const FoldButton = ({ row, ctx }: { row: { turnId: string; number: number }; ctx: RowContext }) => (
  <button
    type="button"
    onClick={() => ctx.onSetTurnOpen(row.turnId, false)}
    aria-label={`Fold turn ${row.number}`}
    title="Fold this turn"
    className="rounded-control text-text-faint hover:text-text-subtle hover:bg-fill-hover focus-visible:text-text-subtle grid size-5 shrink-0 cursor-default place-items-center opacity-0 group-focus-within/turn:opacity-100 group-hover/turn:opacity-100 focus-visible:opacity-100"
    data-testid="turn-fold"
  >
    <ChevronDownIcon size={10} />
  </button>
);

const Prompt = ({ row, ctx }: { row: Extract<Row, { kind: "prompt" }>; ctx: RowContext }) => (
  <PromptMenu text={row.text} onFold={() => ctx.onSetTurnOpen(row.turnId, false)}>
    <div className="group/turn flex flex-col items-end gap-1.5" data-testid="prompt">
      <SentAttachments hostKey={ctx.diff.hostKey} attachments={row.attachments} />
      {row.shell != null ? (
        <div className="w-full max-w-[560px]" data-testid="shell-prompt">
          <Command item={row.shell} hue={ctx.harness} own />
        </div>
      ) : row.text === "" ? null : (
        <p className="rounded-card bg-fill-selected text-body text-text-strong py-row-x max-w-[340px] px-3.5 break-words whitespace-pre-wrap">
          {softWrap(row.text)}
        </p>
      )}
      <div className="text-caption text-text-subtle flex max-w-[340px] min-w-0 items-center gap-1.5">
        <FoldButton row={row} ctx={ctx} />
        <span className="min-w-0 truncate" data-testid="turn-model">
          {ctx.modelLabel(row.model, row.effort)}
        </span>
        <span aria-hidden="true">·</span>
        <TurnTime iso={row.startedAt} />
      </div>
    </div>
  </PromptMenu>
);

/**
 * A Turn the Harness started: what woke it, its Model and time. Inside a user's Turn it is a
 * quiet line between items; opening a Turn of its own it carries the fold control too.
 */
const TriggerRow = ({ row, ctx }: { row: Extract<Row, { kind: "trigger" }>; ctx: RowContext }) => {
  const time = turnTime(row.startedAt, new Date());
  const label = ctx.modelLabel(row.model, row.effort);

  return (
    <div className="group/turn flex items-center gap-1.5">
      <div className="min-w-0 flex-1">
        <Trigger text={row.text} model={[label, time].filter((p) => p !== "").join(" · ")} />
      </div>
      {row.opensTurn ? <FoldButton row={row} ctx={ctx} /> : null}
    </div>
  );
};

/** An item's kind, or "run" / "subagent" for those rows (tests and smoke read it). */
const entryKind = (entry: Entry) => (entry.kind === "item" ? entry.item.kind : entry.kind);

/** A reply's time, on hover, in the gutter left of it (under the avatar on a Turn's first). */
const ReplyTime = ({ row }: { row: Extract<Row, { kind: "item" }> }) =>
  row.startedAt === null || entryKind(row.entry) !== "message" ? null : (
    <span
      className={cn(
        "text-caption text-text-subtle pointer-events-none absolute -left-5 w-11 pr-2 text-right opacity-0 group-hover/item:opacity-100",
        row.lead ? "top-7" : "top-0.5"
      )}
      data-testid="reply-time"
    >
      <TurnTime iso={row.startedAt} />
    </span>
  );

/** The row's reply text, once it has finished streaming; null for every other item. */
const finishedMessage = (row: Extract<Row, { kind: "item" }>) =>
  row.entry.kind === "item" && row.entry.item.kind === "message" && !row.entry.item.live
    ? row.entry.item.text
    : null;

const Agent = ({ row, ctx }: { row: Extract<Row, { kind: "item" }>; ctx: RowContext }) => (
  <TurnMenu
    hostKey={ctx.diff.hostKey}
    sessionId={ctx.diff.sessionId}
    turnId={row.turnId}
    message={finishedMessage(row)}
    live={row.latest && ctx.liveTurnId !== null}
    onOpenDiff={() => ctx.onOpenDiff(row.turnId)}
  >
    <div
      className="group/item relative flex gap-3"
      data-testid="turn-item"
      data-kind={entryKind(row.entry)}
    >
      <ReplyTime row={row} />
      <div className={AVATAR}>
        {row.lead && ctx.harness !== null ? (
          <Celestial
            body={ctx.celestial}
            harness={ctx.harness}
            size={24}
            working={row.partId === ctx.liveTurnId}
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <SessionTargetContext.Provider value={ctx.diff}>
          <EntryView
            entry={row.entry}
            ctx={{
              hue: ctx.harness,
              onOpenDiff: () => ctx.onOpenDiff(row.turnId),
              onOpenSubagent: ctx.onOpenSubagent,
            }}
          />
        </SessionTargetContext.Provider>
      </div>
      {row.sources === undefined ? null : (
        <div className="shrink-0">
          <SourcesPill sources={row.sources} align="end" />
        </div>
      )}
    </div>
  </TurnMenu>
);

const KIND_WANTS: Record<Exclude<ApprovalRequest["kind"], "secret">, string> = {
  command: "wants to run a command",
  "file-change": "wants to change files",
  tool: "wants to use a tool",
  question: "has a question",
};

/** DESIGN.md Needs You: the washed header strip and numbered rows; free text goes in the composer. */
const Question = ({ request, ctx }: { request: ApprovalRequest; ctx: RowContext }) => {
  const now = useNow(60_000);
  const views = questionViews(request);

  return (
    <QuestionCard
      key={request.id}
      data-testid="question"
      harness={ctx.harness ?? ""}
      age={age(request.openedAt, now)}
      questions={questionSteps(views)}
      onAnswer={(picks) => ctx.onRespond(request, answerDecision(views, picks))}
    />
  );
};

/** A Secret Request: never approved, only answered with its value or declined (ADR 0089). */
const Secret = ({
  request,
  settled,
  ctx,
}: {
  request: ApprovalRequest;
  settled: SecretOutcome | null;
  ctx: RowContext;
}) => {
  if (settled !== null) return <SettledSecretCard request={request} outcome={settled} />;

  const target = {
    hostKey: ctx.diff.hostKey,
    sessionId: ctx.diff.sessionId,
    requestId: request.id,
  };

  return (
    <SecretCard
      key={request.id}
      request={request}
      who={ctx.harness === null ? "The agent" : harnessHue(ctx.harness).name}
      onProvide={(value) => provideSecret(target, value)}
      onDecline={() => ctx.onRespond(request, Decisions.Deny({ reason: null }))}
    />
  );
};

const Approval = ({
  request,
  settled,
  ctx,
}: {
  request: ApprovalRequest;
  settled: SecretOutcome | null;
  ctx: RowContext;
}) => {
  if (request.kind === "secret") return <Secret request={request} settled={settled} ctx={ctx} />;

  if (request.kind === "question") return <Question request={request} ctx={ctx} />;
  const who = ctx.harness === null ? "The agent" : harnessHue(ctx.harness).name;
  const respond = (decision: ApprovalDecision) => ctx.onRespond(request, decision);

  return (
    <div className="rounded-card border-hairline bg-surface-raised border" data-testid="approval">
      {ctx.harness === null ? (
        <p className="text-caption text-needs-you p-3.5">{request.title}</p>
      ) : (
        <ApprovalCard
          harness={ctx.harness}
          title={request.title}
          summary={`${who} ${KIND_WANTS[request.kind]}`}
          command={request.detail ?? request.title}
          where={ctx.where}
          onApprove={() => respond(Decisions.Allow({ remember: false }))}
          onAlwaysAllow={() => respond(Decisions.Allow({ remember: true }))}
          onDeny={() => respond(Decisions.Deny({ reason: null }))}
        />
      )}
    </div>
  );
};

const Ending = ({ row, ctx }: { row: Extract<Row, { kind: "ending" }>; ctx: RowContext }) =>
  row.canContinue && ctx.limit !== null ? (
    <LimitCard
      harness={ctx.harness}
      number={row.number}
      limit={ctx.limit}
      onContinue={ctx.onContinue}
    />
  ) : (
    <InterruptedOrFailed row={row} ctx={ctx} />
  );

const InterruptedOrFailed = ({
  row,
  ctx,
}: {
  row: Extract<Row, { kind: "ending" }>;
  ctx: RowContext;
}) => (
  <div className="flex items-center gap-3" data-testid="turn-ending">
    <div className={cn(AVATAR, "flex justify-center")}>
      {row.status === "failed" ? <PixelFailedIcon size={14} className="text-failed" /> : null}
      {row.canContinue ? (
        <Tile hue="needs-you" size={24}>
          <PixelHandIcon size={14} className="text-needs-you" />
        </Tile>
      ) : null}
    </div>
    <p className="text-body text-text-subtle flex-1">
      {row.status === "failed"
        ? `Turn ${row.number} failed`
        : `Turn ${row.number} was interrupted${row.canContinue ? " when the daemon stopped" : ""}`}
    </p>
    {row.canContinue ? (
      <Button variant="secondary" onClick={ctx.onContinue}>
        Continue
      </Button>
    ) : null}
    {row.canRetry ? (
      <Button variant="secondary" onClick={ctx.onRetry}>
        Retry
      </Button>
    ) : null}
  </div>
);

/** A folded Turn: its summary row, or the Polaris card (a digest, a brief) folded. */
const FoldedTurn = ({ row, ctx }: { row: Extract<Row, { kind: "summary" }>; ctx: RowContext }) =>
  ctx.chrome.promptCard?.({
    turnId: row.turnId,
    folded: true,
    canFold: true,
    onToggle: () => ctx.onSetTurnOpen(row.turnId, true),
  }) ?? <Summary row={row} ctx={ctx} />;

/** Opens the list while older Turns remain: they load as it comes into view. */
const Older = ({ row, onRetry }: { row: Extract<Row, { kind: "older" }>; onRetry: () => void }) => (
  <div
    className="text-caption text-text-subtle flex h-8 items-center justify-center gap-2"
    data-testid="older-turns"
    data-state={row.state}
  >
    {row.state === "failed" ? (
      <>
        Couldn't load earlier turns
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </>
    ) : (
      "Loading earlier turns…"
    )}
  </div>
);

/** One row, by kind. */
export const ConversationRow = ({ row, ctx }: { row: Row; ctx: RowContext }) => {
  switch (row.kind) {
    case "setup":
      return <SetupCard setup={row.setup} />;
    case "older":
      return <Older row={row} onRetry={ctx.onLoadOlder} />;
    case "summary":
      return <FoldedTurn row={row} ctx={ctx} />;
    case "prompt":
      return (
        ctx.chrome.promptCard?.({
          turnId: row.turnId,
          folded: false,
          canFold: true,
          onToggle: () => ctx.onSetTurnOpen(row.turnId, false),
        }) ?? <Prompt row={row} ctx={ctx} />
      );
    case "trigger":
      return <TriggerRow row={row} ctx={ctx} />;
    case "waiting":
      return (
        <Waiting waiting={row.waiting} harness={ctx.harness} onOpenSubagent={ctx.onOpenSubagent} />
      );
    case "trailer":
      return ctx.chrome.trailer ?? null;
    case "item":
      return row.entry.kind === "item" && row.entry.item.kind === "user" ? (
        (ctx.chrome.steerCard?.({
          turnId: row.partId,
          itemId: row.entry.item.id,
          text: row.entry.item.text,
        }) ?? (
          <Steered
            text={row.entry.item.text}
            above={
              <SentAttachments
                hostKey={ctx.diff.hostKey}
                attachments={row.entry.item.attachments}
              />
            }
            time={row.startedAt === null ? null : <TurnTime iso={row.startedAt} />}
          />
        ))
      ) : (
        <Agent row={row} ctx={ctx} />
      );
    case "outgoing":
      return (
        <OutgoingMessage
          entry={row.entry}
          hostKey={ctx.diff.hostKey}
          canSteer={ctx.canSteer}
          onRetry={() => ctx.outbox.retry(row.entry.id)}
          onEdit={() => ctx.outbox.edit(row.entry.id)}
        />
      );
    case "approval":
      return <Approval request={row.request} settled={row.settled} ctx={ctx} />;
    case "ending":
      return <Ending row={row} ctx={ctx} />;
  }
};
