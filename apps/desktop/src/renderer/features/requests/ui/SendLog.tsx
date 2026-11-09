/**
 * The send log tab (DESIGN.md, Requests → Sidebar; Paper Q2): the whole checkout's Sends grouped
 * "LAST HOUR" / "EARLIER TODAY", each with its status in a fixed lane ("—" when no response came),
 * the path cut short, the duration, and who sent it. Selecting one opens it in both panes.
 */
import type { RequestsSnapshot, Send } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { type KeyboardEvent, useMemo } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { useNow } from "../../../shell/useNow.ts";
import type { Loaded } from "../data/hooks.tsx";
import { NEW_REQUEST_FILE } from "../model/draft.ts";
import { type SendRow, sendGroups } from "../model/sendLog.ts";
import { openSend, setSendLogFilter, useSendLogView } from "../model/sendLogView.ts";
import { FilterWell } from "./sidebar/FilterWell.tsx";
import type { RequestsSlotProps } from "./slots.ts";

/** A status no response or a 5xx stands out; everything else reads plain. */
const failed = (send: Send) =>
  send.outcome === "refused" ||
  send.outcome === "timeout" ||
  send.outcome === "failed" ||
  (send.status ?? 0) >= 500;

const Quiet = ({ children }: { readonly children: string }) => (
  <p className="text-caption text-text-subtle px-2 py-2" data-testid="requests-send-log-quiet">
    {children}
  </p>
);

const Row = ({
  row,
  selected,
  onOpen,
}: {
  readonly row: SendRow;
  readonly selected: boolean;
  readonly onOpen: () => void;
}) => (
  <button
    type="button"
    data-testid="requests-send-row"
    data-send
    aria-current={selected ? "true" : undefined}
    aria-label={`${row.status === "—" ? row.send.outcome : row.status} ${row.send.method} ${row.path}, ${row.duration}, by ${row.by}`}
    onClick={onOpen}
    className={cn(
      "hover:bg-fill-hover focus-visible:ring-starlight flex w-full shrink-0 cursor-default flex-col gap-0.5 rounded-[10px] py-1.5 pr-2.5 pl-2 text-left outline-none focus-visible:ring-2",
      selected && "bg-raised ring-hairline hover:bg-raised ring-1 ring-inset"
    )}
  >
    <span className="flex w-full min-w-0 items-baseline gap-2 font-mono">
      <span
        className={cn(
          "text-micro tabular w-8 shrink-0",
          failed(row.send) ? "text-severity-critical-text" : "text-text-subtle"
        )}
        data-testid="requests-send-status"
      >
        {row.status}
      </span>
      <span
        className={cn(
          "text-caption min-w-0 flex-1 truncate",
          selected ? "text-text-strong" : "text-text-default"
        )}
        title={`${row.send.method} ${row.path}`}
      >
        {row.path}
      </span>
      <span className="text-micro text-text-subtle tabular shrink-0">{row.duration}</span>
    </span>
    <span className="text-micro text-text-faint flex min-w-0 gap-1 pl-10">
      <span className="shrink-0 font-mono">{row.send.method}</span>
      <span className="min-w-0 truncate" title={row.by}>{`· ${row.by}`}</span>
    </span>
  </button>
);

/** Up and Down move between Sends; Enter or Space opens one, as a button does. */
const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-send]")];
  const at = rows.findIndex((row) => row === document.activeElement);
  const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];

  if (next === undefined) return;
  event.preventDefault();
  next.focus();
};

const takenNames = (snapshot: Loaded<RequestsSnapshot> | undefined) =>
  new Set(
    snapshot?.status === "ready"
      ? snapshot.value.files
          .filter((f) => f.path === NEW_REQUEST_FILE)
          .flatMap((f) => f.requests.map((r) => r.name))
      : []
  );

export interface SendLogProps extends RequestsSlotProps {
  /** The checkout's Requests, so an ad-hoc Send opens under a name not taken. */
  readonly snapshot?: Loaded<RequestsSnapshot>;
  /** The checkout's latest Sends; the sidebar watches them for the tab's count. */
  readonly log: Loaded<ReadonlyArray<Send>>;
}

/** The tab's filter, in the sidebar's header where the Requests filter sits. */
export const SendLogFilter = ({ at }: RequestsSlotProps) => {
  const { filter } = useSendLogView(at);

  return (
    <FilterWell
      text={filter}
      onText={(text) => setSendLogFilter(at, text)}
      label="Filter sends by method, path, status or who sent them"
      placeholder="Filter sends"
      testId="requests-send-log-filter"
    />
  );
};

export const SendLog = ({ at, snapshot, log }: SendLogProps) => {
  const { filter, selected } = useSendLogView(at);
  const now = useNow(60_000);
  const sessions = useApp((s) => s.hostModels[at.hostKey]?.sessions);
  const sends = log.status === "ready" ? log.value : null;

  const groups = useMemo(
    () =>
      sends === null
        ? []
        : sendGroups(
            sends,
            filter,
            new Date(now),
            (id) => sessions?.get(id)?.session.title ?? null
          ),
    [sends, filter, now, sessions]
  );

  if (log.status === "loading") return null;

  if (log.status === "failed") return <Quiet>{log.error.message}</Quiet>;

  if (log.value.length === 0)
    return <Quiet>No sends from this checkout yet. Yours and agents' show here.</Quiet>;

  if (groups.length === 0) return <Quiet>No sends match the filter</Quiet>;

  return (
    <div className="flex flex-col gap-0.5" onKeyDown={moveFocus} data-testid="requests-send-log">
      {groups.map((group) => (
        <section
          key={group.id}
          aria-label={group.title}
          className="flex flex-col gap-0.5"
          data-testid="requests-send-group"
        >
          <h2 className="text-micro text-text-subtle flex h-8 shrink-0 items-center pt-2 pl-2 font-mono font-medium tracking-[0.06em]">
            {group.title}
          </h2>
          {group.rows.map((row) => (
            <Row
              key={row.send.id}
              row={row}
              selected={row.send.id === selected}
              onOpen={() => openSend(at, row.send, takenNames(snapshot))}
            />
          ))}
        </section>
      ))}
    </div>
  );
};
