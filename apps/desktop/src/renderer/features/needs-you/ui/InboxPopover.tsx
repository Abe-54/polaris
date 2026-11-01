/**
 * The Needs You popover (Paper X-F 09): the title bar's badge opens the inbox as an instrument
 * card, one row per item with its answers. Tab walks every action; the arrows move between
 * items (up, down) and an item's actions (left, right); Escape closes back to the badge.
 */
import {
  Button,
  Celestial,
  InstrumentPopoverContent,
  Kicker,
  Popover,
  PopoverTrigger,
} from "@polaris/ui";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { useSelection, useShellActions } from "../../../shell/hooks.ts";
import { menuShortcut } from "../../../shell/menu/index.ts";
import { useNow } from "../../../shell/useNow.ts";
import { openSessionReview } from "../../../routes/review.ts";
import { useConstellationInbox, useInboxView, withoutConstellations } from "../hooks.ts";
import type { ConstellationGroup, ConstellationItem } from "../model/constellation.ts";
import type { AlsoWaiting, WaitingSession } from "../model/inbox.ts";
import {
  alsoCopy,
  constellationApproval,
  constellationCopy,
  popoverStatus,
  type RowCopy,
  type Waited,
  waitingCopy,
  who,
} from "../model/popover.ts";
import { approve, deny } from "../respond.ts";
import { useOpen } from "./ConstellationGroups.tsx";
import { useAlsoAction } from "./Inbox.tsx";

const PILL = "rounded-full px-3";

interface RowProps {
  readonly copy: RowCopy;
  readonly children: ReactNode;
  /** A key hint at the end of the actions ("⌘⇧A"). */
  readonly hint?: string | undefined;
}

const Row = ({ copy, children, hint }: RowProps) => (
  <li
    data-row
    className="rounded-row hover:bg-fill-hover focus-within:bg-fill-hover flex gap-3 px-3 pt-2.5 pb-3"
  >
    <Celestial body={copy.body} harness={copy.harness} size={24} className="shrink-0" />
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Kicker parts={copy.kicker} className="truncate" />
      <p className="text-body text-text-default line-clamp-4 wrap-anywhere">{copy.text}</p>
      {copy.code === null ? null : (
        // Never clamped: what Approve answers is always there in full, scrolling if long.
        <pre
          className="text-caption text-text-strong max-h-32 overflow-y-auto font-mono wrap-anywhere whitespace-pre-wrap"
          data-testid="needs-you-request"
        >
          {copy.code}
        </pre>
      )}
      <div className="flex items-center gap-1.5 pt-1">
        {children}
        {hint === undefined ? null : (
          <span className="text-text-subtle ml-auto font-mono text-[11px] leading-[14px]">
            {hint}
          </span>
        )}
      </div>
    </div>
  </li>
);

interface Answers {
  readonly onApprove: () => void;
  readonly onDeny: () => void;
}

const ApproveDeny = ({ onApprove, onDeny }: Answers) => (
  <>
    <Button size="sm" variant="primary" className={PILL} onClick={onApprove}>
      Approve
    </Button>
    <Button size="sm" className={PILL} onClick={onDeny}>
      Deny
    </Button>
  </>
);

interface ItemProps {
  readonly now: number;
  /** Closes the popover, before an action that moves elsewhere. */
  readonly close: () => void;
}

const WaitingRow = ({ item, now, close }: ItemProps & { readonly item: WaitingSession }) => {
  const { selectSession } = useShellActions();
  const selection = useSelection();
  const copy = waitingCopy(item, now);
  const request = item.requests[0];

  if (copy === null || request === undefined) return null;
  const sessionId = item.entry.session.id;
  const target = { hostKey: item.hostKey, sessionId, request };

  const open = () => {
    close();
    selectSession({ hostKey: item.hostKey, sessionId });
  };

  // A question is answered, and a secret typed, only in the session's own card.
  if (request.kind === "question" || request.kind === "secret") {
    return (
      <Row copy={copy}>
        <Button size="sm" className={PILL} onClick={open}>
          {request.kind === "secret" ? "Open" : "Reply"}
        </Button>
      </Row>
    );
  }

  // ⌘⇧A answers the selected session, so its hint shows only there.
  const here = selection.pane === "session" && selection.sessionId === sessionId;

  return (
    <Row copy={copy} hint={here ? menuShortcut("approval.approve") : undefined}>
      <ApproveDeny
        onApprove={() => void approve(target, false, open)}
        onDeny={() => void deny(target, open)}
      />
    </Row>
  );
};

const AlsoRow = ({ item, now, close }: ItemProps & { readonly item: AlsoWaiting }) => {
  const { label, run, open, setupFailed } = useAlsoAction(item);

  const opening = () => {
    close();
    open();
  };

  return (
    <Row copy={alsoCopy(item, now)}>
      <Button size="sm" className={PILL} onClick={setupFailed ? opening : run}>
        {label}
      </Button>
      {setupFailed ? null : (
        <Button size="sm" variant="ghost" className={PILL} onClick={opening}>
          Open session
        </Button>
      )}
    </Row>
  );
};

interface ConstellationRowProps extends ItemProps {
  readonly group: ConstellationGroup;
  readonly item: ConstellationItem;
}

const ConstellationRow = ({ group, item, now, close }: ConstellationRowProps) => {
  const actions = useShellActions();
  const openLead = useOpen(group, item);
  const attempt = item.worker?.attempt;
  const sessionId = item.entry?.session.id;

  const opening = (go: () => void) => () => {
    close();
    go();
  };

  if (
    constellationApproval(item) &&
    item.hostKey !== null &&
    sessionId !== undefined &&
    item.request !== undefined
  ) {
    const target = { hostKey: item.hostKey, sessionId, request: item.request };

    return (
      <Row copy={constellationCopy(group, item, now)}>
        <ApproveDeny
          onApprove={() =>
            void approve(
              target,
              false,
              opening(() => actions.selectSession(target))
            )
          }
          onDeny={() =>
            void deny(
              target,
              opening(() => actions.selectSession(target))
            )
          }
        />
      </Row>
    );
  }

  const { hostKey } = item;

  const review =
    item.kind === "claim" && hostKey !== null && attempt !== undefined
      ? () => openSessionReview(actions, hostKey, attempt.sessionId)
      : null;

  return (
    <Row copy={constellationCopy(group, item, now)}>
      {review === null ? null : (
        <Button size="sm" className={PILL} onClick={opening(review)}>
          Open review
        </Button>
      )}
      <Button
        size="sm"
        variant={review === null ? "secondary" : "ghost"}
        className={PILL}
        onClick={opening(openLead)}
      >
        Open {who(item)}
      </Button>
    </Row>
  );
};

const enabledIn = (row: Element) => [
  ...row.querySelectorAll<HTMLElement>("button:not(:disabled), textarea, input"),
];

const STEP = new Map([
  ["ArrowDown", 1],
  ["ArrowUp", -1],
  ["ArrowRight", 1],
  ["ArrowLeft", -1],
]);

/** Up and down move to the next item's first action; left and right within the item. */
const moveFocus = (event: KeyboardEvent<HTMLUListElement>) => {
  const step = STEP.get(event.key);
  const from = event.target;

  if (step === undefined || !(from instanceof HTMLElement)) return;
  const row = from.closest("[data-row]");

  if (row === null) return;
  event.preventDefault();

  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const buttons = enabledIn(row);
    buttons[buttons.indexOf(from) + step]?.focus();

    return;
  }

  const rows = [...event.currentTarget.querySelectorAll("[data-row]")];
  const next = rows[rows.indexOf(row) + step];

  if (next !== undefined) enabledIn(next)[0]?.focus();
};

const useItems = () => {
  const { inbox: all } = useInboxView();
  const constellations = useConstellationInbox();
  const inbox = withoutConstellations(all, constellations);

  const pairs = constellations.groups.flatMap((group) =>
    group.items.map((item) => ({ group, item }))
  );

  const waited: ReadonlyArray<Waited> = [
    ...inbox.waiting.map((w) => ({ hostKey: w.hostKey, since: w.since })),
    ...pairs.map(({ group, item }) => ({
      hostKey: item.hostKey ?? group.leadHostKey,
      since: item.since,
    })),
    ...inbox.also.map((a) => ({ hostKey: a.hostKey, since: a.entry.session.updatedAt })),
  ];

  return { inbox, pairs, waited };
};

/** The card's slots: the header count, the items' well, and the footer's status line. */
const useCardSlots = (close: () => void) => {
  const now = useNow(30_000);
  const { inbox, pairs, waited } = useItems();
  const { showSidebar, setMode } = useShellActions();

  const all = () => {
    close();
    setMode("orchestrate");
    showSidebar("needs-you");
  };

  return {
    header: { title: "Needs you", state: waited.length },
    wells: [
      waited.length === 0 ? (
        <p key="empty" className="text-body text-text-subtle px-3 py-6 text-center">
          Nothing needs you
        </p>
      ) : (
        <ul key="items" aria-label="Needs you" className="flex flex-col p-1" onKeyDown={moveFocus}>
          {inbox.waiting.map((item) => (
            <WaitingRow key={item.key} item={item} now={now} close={close} />
          ))}
          {pairs.map(({ group, item }) => (
            <ConstellationRow key={item.key} group={group} item={item} now={now} close={close} />
          ))}
          {inbox.also.map((item) => (
            <AlsoRow key={item.key} item={item} now={now} close={close} />
          ))}
        </ul>
      ),
    ] as const,
    footer: {
      status: popoverStatus(waited, now),
      action: (
        <Button size="xs" variant="ghost" onClick={all}>
          Open inbox
        </Button>
      ),
    },
  };
};

const Card = ({ close }: { readonly close: () => void }) => (
  <InstrumentPopoverContent
    align="start"
    sideOffset={8}
    data-testid="needs-you-inbox"
    aria-label="Needs you"
    className="w-[380px]"
    {...useCardSlots(close)}
  />
);

/** Wraps the Needs You badge: it opens the popover by click, Enter or Space. */
export const NeedsYouPopover = ({ children }: { readonly children: ReactElement }) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        role="button"
        tabIndex={0}
        data-testid="needs-you-trigger"
        // The badge sits in the Orchestrate segment; the popover opens without switching modes.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          setOpen((was) => !was);
        }}
      >
        {children}
      </PopoverTrigger>
      {open ? <Card close={close} /> : null}
    </Popover>
  );
};
