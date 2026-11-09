/**
 * The Requests tab's list (DESIGN.md, Requests → Sidebar; Paper Q1): "IN THIS CHECKOUT", then a
 * collapsible group per file of 28px rows, the method in a fixed lane, the name, and a tan dot
 * for unsaved edits.
 */
import type { HttpRequest } from "@polaris/protocol";
import { cn, DisclosureChevron } from "@polaris/ui";
import type { KeyboardEvent } from "react";
import type { FileGroup } from "../../model/sidebar.ts";
import { filesLabel } from "../../model/sidebar.ts";

const RequestRow = ({
  request,
  open,
  unsaved,
  onOpen,
}: {
  readonly request: HttpRequest;
  readonly open: boolean;
  readonly unsaved: boolean;
  readonly onOpen: () => void;
}) => (
  <button
    type="button"
    data-testid="requests-row"
    data-request
    aria-current={open ? "true" : undefined}
    aria-label={`${request.method} ${request.name}${unsaved ? ", unsaved edits" : ""}`}
    onClick={onOpen}
    className={cn(
      "h-tree-row hover:bg-fill-hover focus-visible:ring-starlight flex w-full shrink-0 cursor-default items-center gap-2 rounded-full pr-2.5 pl-[26px] text-left outline-none focus-visible:ring-2",
      open && "bg-raised ring-hairline hover:bg-raised ring-1 ring-inset"
    )}
  >
    <span className="text-micro text-text-subtle w-10 shrink-0 font-mono">{request.method}</span>
    <span
      className={cn(
        "text-body min-w-0 flex-1 truncate",
        open ? "text-text-strong" : "text-text-default"
      )}
      title={request.name}
    >
      {request.name}
    </span>
    {unsaved ? (
      <span
        className="bg-git-modified size-1.5 shrink-0 rounded-full"
        data-testid="requests-unsaved"
        aria-hidden
      />
    ) : null}
  </button>
);

const FileHeader = ({
  group,
  closed,
  onToggle,
}: {
  readonly group: FileGroup;
  readonly closed: boolean;
  readonly onToggle: () => void;
}) => (
  <button
    type="button"
    aria-expanded={!closed}
    onClick={onToggle}
    className="hover:bg-fill-hover focus-visible:ring-starlight flex h-[26px] w-full shrink-0 cursor-default items-center gap-1.5 rounded-full px-2.5 text-left outline-none focus-visible:ring-2"
  >
    <span className="text-text-faint flex w-2.5 shrink-0 justify-center">
      <DisclosureChevron open={!closed} size={10} />
    </span>
    <span
      className="text-caption text-text-subtle min-w-0 flex-1 truncate font-mono"
      title={group.path}
    >
      {group.path}
    </span>
    {closed ? (
      <span className="text-micro text-text-faint tabular font-mono">{group.requests.length}</span>
    ) : null}
    {group.parseErrors > 0 ? (
      <span
        className="text-micro text-text-faint shrink-0 font-mono"
        title={`${group.parseErrors} unreadable in this file; Open in Edit to fix`}
      >
        {`${group.parseErrors} unread`}
      </span>
    ) : null}
  </button>
);

/** Up and Down move between Requests; Enter or Space opens one, as a button does. */
const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-request]")];
  const at = rows.findIndex((row) => row === document.activeElement);
  const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];

  if (next === undefined) return;
  event.preventDefault();
  next.focus();
};

export interface RequestListProps {
  readonly groups: ReadonlyArray<FileGroup>;
  /** Every file, unfiltered, for the kicker's count. */
  readonly fileCount: number;
  readonly openKey: string | null;
  readonly keyOf: (request: HttpRequest) => string;
  readonly isUnsaved: (request: HttpRequest) => boolean;
  readonly isClosed: (path: string) => boolean;
  readonly onOpen: (request: HttpRequest) => void;
  readonly onToggle: (path: string) => void;
}

export const RequestList = ({
  groups,
  fileCount,
  openKey,
  keyOf,
  isUnsaved,
  isClosed,
  onOpen,
  onToggle,
}: RequestListProps) => (
  <div className="flex flex-col gap-0.5" onKeyDown={moveFocus}>
    <h2 className="flex h-8 shrink-0 items-center justify-between pt-2 pr-2.5 pl-2 font-mono">
      <span className="text-micro text-text-subtle font-medium tracking-[0.06em]">
        IN THIS CHECKOUT
      </span>
      <span className="text-micro text-text-faint">{filesLabel(fileCount)}</span>
    </h2>
    {groups.map((group) => {
      const closed = isClosed(group.path);

      return (
        <section
          key={group.path}
          aria-label={group.path}
          className="flex flex-col gap-0.5"
          data-testid="requests-file"
        >
          <FileHeader group={group} closed={closed} onToggle={() => onToggle(group.path)} />
          {closed
            ? null
            : group.requests.map((request) => (
                <RequestRow
                  key={request.name}
                  request={request}
                  open={keyOf(request) === openKey}
                  unsaved={isUnsaved(request)}
                  onOpen={() => onOpen(request)}
                />
              ))}
        </section>
      );
    })}
  </div>
);
