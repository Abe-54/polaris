/**
 * The sidebar's "Needs you" view across every Host (Paper 1G2-0): a card per waiting session,
 * approvals answered inline, questions shown and answered in the conversation; then "Also
 * waiting on you" with one action each; answers another device gave, for a minute. Any
 * session item can be dismissed on this Mac until it changes (N1; Paper 10, 10b).
 */
import type { ApprovalRequest, SessionId } from "@polaris/protocol";
import {
  CloseIcon,
  cn,
  EmptyState,
  NeedsYouCard,
  PixelFailedIcon,
  PixelHandIcon,
  PixelCheckIcon,
  PixelTerminalIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  WaitingCard,
} from "@polaris/ui";
import type { ReactNode } from "react";
import { age } from "../../../shell/copy.ts";
import { useApp, useSelection, useShellActions } from "../../../shell/hooks.ts";
import { useNow } from "../../../shell/useNow.ts";
import { ReviewsGroup, useRequestedCount } from "../../pulls/index.ts";
import { dismiss, restoreDismissed } from "../dismissed.ts";
import { useConstellationInbox, useInboxView, withoutConstellations } from "../hooks.ts";
import { type CardAction, CardMenu } from "./CardMenu.tsx";
import { ConstellationGroups } from "./ConstellationGroups.tsx";
import { quietFact } from "../model/quiet.ts";
import type { Dismissible } from "../model/dismissed.ts";
import type {
  AlsoKind,
  AlsoWaiting,
  AnsweredElsewhere,
  Place,
  WaitingSession,
} from "../model/inbox.ts";
import { offersAlwaysAllow } from "../../data/approval/decide.ts";
import { DENY_PROMPT, dryRunKicker, writeName, writeWants } from "../../data/write/model.ts";
import {
  type ApprovalTarget,
  approve,
  continueTurn,
  deny,
  retryTurn,
  takeBack,
} from "../respond.ts";
import { clientCopy } from "../../../../shared/clientCopy.ts";
import { secretLine } from "../../session/model/secret.ts";

/** "Host · Workspace · age"; without `iso`, just where. */
export const where = (place: Place, iso: string | null, now: number) =>
  [place.hostLabel, place.workspace, iso === null ? null : age(iso, now)]
    .filter((part) => part !== null)
    .join(" · ");

const Title = ({
  onOpen,
  children,
}: {
  readonly onOpen: () => void;
  readonly children: string;
}) => (
  <button
    type="button"
    onClick={onOpen}
    className="hover:decoration-text-faint w-full cursor-default truncate text-left hover:underline hover:underline-offset-2"
  >
    {children || "Untitled session"}
  </button>
);

/** A card with a × that shows on hover or focus; dismissing hides it on this Mac only. */
const Dismissable = ({
  item,
  children,
}: {
  readonly item: Dismissible;
  readonly children: (reserve: string) => ReactNode;
}) => (
  <div className="group relative" data-testid="dismissable">
    {children("group-hover:pr-9 group-focus-within:pr-9")}
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Dismiss on ${clientCopy().machine}`}
          data-testid="dismiss"
          onClick={() => dismiss([item])}
          className={cn(
            "rounded-control text-text-default hover:bg-fill-selected focus-visible:bg-fill-selected absolute right-2.5 flex size-5 cursor-default items-center justify-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
            "requests" in item ? "top-3" : "top-1/2 -translate-y-1/2"
          )}
        >
          <CloseIcon size={12} />
        </button>
      </TooltipTrigger>
      <TooltipContent className="h-auto flex-col items-start gap-0.5 py-1.5">
        <span className="text-text-strong font-medium">Dismiss on {clientCopy().machine}</span>
        <span className="text-text-subtle">It comes back if the session changes</span>
      </TooltipContent>
    </Tooltip>
  </div>
);

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A question's ask; a secret's label only, its reason staying in the session's card; a write's. */
const inboxAsk = (request: ApprovalRequest) => {
  if (request.dataWrite !== undefined)
    return `${capitalize(writeWants(request.dataWrite))} · ${dryRunKicker(request.dataWrite).toLowerCase()}`;

  return request.kind === "secret" ? secretLine(request.title) : request.title;
};

/** A write is answered in its card, where its SQL and dry run are: both open it. */
const writeAnswers = (target: ApprovalTarget, open: () => void): ReadonlyArray<CardAction> => {
  const write = target.request.dataWrite;

  return write === undefined
    ? []
    : [
        { label: `Review the ${writeName(write)}`, run: open },
        {
          label: `${DENY_PROMPT}…`,
          run: () => void deny(target, open),
          command: "approval.deny",
        },
      ];
};

/** The card's answers; Always allow only where the request offers it. */
interface Answering {
  readonly command: string;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
  onAlwaysAllow?: () => void;
}

const Waiting = ({
  item,
  now,
  reserve,
}: {
  readonly item: WaitingSession;
  readonly now: number;
  readonly reserve: string;
}) => {
  const { selectSession } = useShellActions();
  const selection = useSelection();
  const { session } = item.entry;
  const request = item.requests[0];
  const open = () => selectSession({ hostKey: item.hostKey, sessionId: session.id });
  const more = item.requests.length > 1 ? ` · ${item.requests.length} waiting` : "";

  if (request === undefined) return null;
  const target = { hostKey: item.hostKey, sessionId: session.id, request };

  const answering: Answering = {
    command: request.detail ?? request.title,
    onApprove: () => void approve(target),
    onDeny: () => void deny(target),
  };

  const always = offersAlwaysAllow(request);

  if (always) answering.onAlwaysAllow = () => void approve(target, true);

  // Questions, secrets, computer use setup and a write's reason are answered in the session's card.
  const write = request.dataWrite !== undefined;
  const inSession = ["question", "secret", "computer-use"].includes(request.kind);
  const inCard = inSession || write;

  const answers: ReadonlyArray<CardAction> = inCard
    ? writeAnswers(target, open)
    : [
        { label: "Approve", run: () => void approve(target), command: "approval.approve" },
        ...(always ? [{ label: "Always allow", run: () => void approve(target, true) }] : []),
        { label: "Deny", run: () => void deny(target), command: "approval.deny" },
      ];

  return (
    <CardMenu item={item} sessionId={session.id} onOpen={open} answers={answers}>
      <NeedsYouCard
        className={reserve}
        data-testid="needs-you-card"
        data-session={session.id}
        harness={session.harness}
        selected={selection.pane === "session" && selection.sessionId === session.id}
        title={<Title onOpen={open}>{session.title}</Title>}
        where={`${where(item, item.since, now)}${more}`}
        {...(inCard ? { question: inboxAsk(request) } : { approval: answering })}
      />
    </CardMenu>
  );
};

const ALSO: Record<AlsoKind, { readonly icon: ReactNode; readonly action: string }> = {
  failed: { icon: <PixelFailedIcon size={14} />, action: "Retry" },
  "in-terminal": { icon: <PixelTerminalIcon size={14} />, action: "Take back" },
  interrupted: { icon: <PixelHandIcon size={14} className="text-needs-you" />, action: "Continue" },
};

const alsoDetail = (item: AlsoWaiting): string => {
  if (item.kind === "failed")
    return `Failed · ${item.entry.session.lastError ?? "the Turn errored"}`;

  return item.kind === "in-terminal" ? "In your terminal" : "Interrupted when the daemon stopped";
};

/** An "Also waiting" item's one action (Retry, Take back, Continue, or Open setup) and Open. */
export const useAlsoAction = (item: AlsoWaiting) => {
  const { selectSession } = useShellActions();
  const { session } = item.entry;
  const id: SessionId = session.id;

  const setupFailed =
    item.kind === "failed" &&
    session.worktreeSetup?.status === "failed" &&
    session.lastError?.startsWith("Worktree setup failed:") === true;

  const open = () => selectSession({ hostKey: item.hostKey, sessionId: id });

  const run = () => {
    if (setupFailed) open();
    else if (item.kind === "in-terminal") void takeBack(item.hostKey, id);
    else if (item.kind === "interrupted") void continueTurn(item.hostKey, id);
    // Failed with no Failed Turn (the Harness never started one): the toast says why; open it.
    else void retryTurn(item.hostKey, id).then((ok) => ok || open());
  };

  return { label: setupFailed ? "Open setup" : ALSO[item.kind].action, run, open, setupFailed };
};

const Also = ({ item, reserve }: { readonly item: AlsoWaiting; readonly reserve: string }) => {
  const { label, run, open, setupFailed } = useAlsoAction(item);
  const { session } = item.entry;
  const id: SessionId = session.id;

  return (
    <CardMenu
      item={item}
      sessionId={id}
      onOpen={open}
      answers={setupFailed ? [] : [{ label, run }]}
    >
      <WaitingCard
        className={reserve}
        data-testid="waiting-card"
        kind={item.kind}
        icon={ALSO[item.kind].icon}
        title={<Title onOpen={open}>{session.title}</Title>}
        detail={alsoDetail(item)}
        action={{ label, onAction: run }}
      />
    </CardMenu>
  );
};

const DECISIONS: Record<AnsweredElsewhere["resolution"]["decision"], string> = {
  Allow: "Approved",
  Deny: "Denied",
  Answer: "Answered",
  Provided: "Secret saved",
};

const Answered = ({ item }: { readonly item: AnsweredElsewhere }) => (
  <div
    data-testid="answered-elsewhere"
    className="rounded-card border-hairline bg-surface-raised flex flex-col gap-px border px-3 py-2.5"
  >
    <p className="text-label text-text-default truncate">
      {item.entry.session.title || "Untitled session"}
    </p>
    <p className="text-caption text-text-subtle truncate">
      {DECISIONS[item.resolution.decision]} on {item.resolution.resolvedBy} ·{" "}
      {item.resolution.request.title}
    </p>
  </div>
);

const Empty = () => {
  const hosts = useApp((s) => s.hosts);
  const models = useApp((s) => s.hostModels);

  return (
    <EmptyState
      data-testid="needs-you-empty"
      icon={<PixelCheckIcon size={24} className="text-text-strong" />}
      title="Nothing needs you"
      fact={quietFact({ hosts: hosts.length, models: Object.values(models) })}
    />
  );
};

/** "2 dismissed on this Mac · Show": what Dismiss hid, and the way back. */
const DismissedLine = ({ hidden }: { readonly hidden: number }) =>
  hidden === 0 ? null : (
    <p
      className="text-caption text-text-subtle flex items-center gap-1.5 px-1.5 pt-2"
      data-testid="dismissed-line"
    >
      {hidden} dismissed on {clientCopy().machine}
      <span className="text-text-faint">·</span>
      <button
        type="button"
        className="text-text-default cursor-default font-medium hover:underline hover:underline-offset-2"
        onClick={restoreDismissed}
      >
        Show
      </button>
    </p>
  );

export const NeedsYouInbox = () => {
  const { inbox: all, hidden } = useInboxView();
  const constellations = useConstellationInbox();
  const now = useNow(30_000);
  const reviews = useRequestedCount();

  // Constellation sessions are shown under their Lead instead.
  const inbox = withoutConstellations(all, constellations);
  const items: ReadonlyArray<Dismissible> = [...inbox.waiting, ...inbox.also];

  const nothing =
    constellations.groups.length === 0 &&
    items.length === 0 &&
    inbox.answered.length === 0 &&
    reviews === 0;

  if (nothing) {
    return (
      <div className="flex flex-col">
        <Empty />
        <div className="flex justify-center px-2">
          <DismissedLine hidden={hidden} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-2 pt-2 pb-4" data-testid="needs-you-inbox">
      {inbox.answered.map((item) => (
        <Answered key={item.key} item={item} />
      ))}
      <ConstellationGroups groups={constellations.groups} now={now} />
      {inbox.waiting.length > 0 && constellations.groups.length > 0 ? (
        <p className="text-caption text-text-subtle px-1.5 pt-2.5 pb-0.5">Sessions</p>
      ) : null}
      {inbox.waiting.map((item) => (
        <Dismissable key={item.key} item={item}>
          {(reserve) => <Waiting item={item} now={now} reserve={reserve} />}
        </Dismissable>
      ))}
      {inbox.also.length === 0 ? null : (
        <p className="text-caption text-text-subtle px-1.5 pt-2.5 pb-0.5">Also waiting on you</p>
      )}
      {inbox.also.map((item) => (
        <Dismissable key={item.key} item={item}>
          {(reserve) => <Also item={item} reserve={reserve} />}
        </Dismissable>
      ))}
      <DismissedLine hidden={hidden} />
      <ReviewsGroup />
    </div>
  );
};
