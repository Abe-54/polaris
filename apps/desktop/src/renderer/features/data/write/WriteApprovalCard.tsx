/**
 * An agent's write waiting on the user (DESIGN.md, Data → Approvals; Paper D3): the source's
 * label, the SQL, the dry run's rows before and after, the agent's reason, "Deny and tell the
 * agent why" and "Run 214-row update ⌘↵". Answered, it collapses to one line.
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  DataSource,
  QueryLogEntry,
} from "@polaris/protocol";
import {
  Button,
  cn,
  Kbd,
  PixelAlertIcon,
  PixelCheckIcon,
  PixelFailedIcon,
  Textarea,
} from "@polaris/ui";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useShownApproval } from "../../../shell/approvalInView.ts";
import type { WriteOutcome } from "../../../store/sessionModel.ts";
import { decide } from "../../needs-you/respond.ts";
import { kickerText, LABEL_TONES } from "../model/source.ts";
import { BeforeAfter } from "./BeforeAfter.tsx";
import { closeDeny, openDeny, setDenyDraft, useDeny } from "./deny.ts";
import {
  DENY_PROMPT,
  type DataWrite,
  denyDecision,
  dryRunKicker,
  noteLine,
  notPreviewed,
  notPreviewedWarning,
  paramsLine,
  runDecision,
  runLabel,
  type Settled,
  settledLine,
  showingLine,
  topBarColour,
  writeWants,
} from "./model.ts";
import { cmShortcut } from "../../editor/cm/keys.ts";
import { OpenInData } from "./OpenInData.tsx";
import { SqlStatement } from "./SqlStatement.tsx";

export interface WriteApprovalCardProps {
  readonly hostKey: string;
  readonly request: ApprovalRequest;
  readonly write: DataWrite;
  /** The asking Agent Session's title, "Backfill currency". */
  readonly who: string;
  /** The listed Data Source the write targets, for its label; undefined until listed. */
  readonly source: DataSource | undefined;
  /** How it ended, once the Daemon says; null while it waits. */
  readonly outcome: WriteOutcome | null;
  /** Its run in the Query Log, for running and failed. */
  readonly entry: QueryLogEntry | undefined;
  /** Opens the write's table in Data, offered once its outcome is unknown. */
  readonly onOpenTable?: () => void;
}

const KICKER = "font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase";

const SettledIcon = ({ settled }: { readonly settled: Settled }) => {
  if (settled.kind === "failed")
    return <PixelFailedIcon size={14} className="text-failed shrink-0" aria-hidden />;

  if (settled.kind === "unknown")
    return <PixelAlertIcon size={14} className="text-needs-you shrink-0" aria-hidden />;

  if (settled.kind === "ran" || settled.kind === "allowed")
    return <PixelCheckIcon size={14} className="text-text-subtle shrink-0" aria-hidden />;

  return <span className="w-3.5 shrink-0" aria-hidden />;
};

/** The card answered: one line, plus the failure's words; an unknown outcome offers its table. */
export const SettledWrite = ({
  settled,
  onOpenTable,
}: {
  readonly settled: Settled;
  readonly onOpenTable?: (() => void) | undefined;
}) => (
  <div
    role="status"
    data-testid="data-write-settled"
    data-state={settled.kind}
    className="rounded-card border-hairline bg-surface-raised flex w-full max-w-[640px] flex-col gap-0.5 border px-3.5 py-2"
  >
    <span className="text-body text-text-default flex min-w-0 items-center gap-2">
      <SettledIcon settled={settled} />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{settled.line}</span>
      {settled.kind === "unknown" && onOpenTable !== undefined ? (
        <span className="-my-1 -mr-2 shrink-0">
          <OpenInData onOpen={onOpenTable} />
        </span>
      ) : null}
    </span>
    {settled.kind === "failed" || settled.kind === "unknown" ? (
      <span
        className={cn(
          "text-caption pl-[22px] [overflow-wrap:anywhere]",
          settled.kind === "failed" ? "text-failed-text" : "text-text-subtle"
        )}
      >
        {settled.detail}
      </span>
    ) : null}
  </div>
);

const SourceLine = ({ write, source }: Pick<WriteApprovalCardProps, "write" | "source">) => {
  const tone = LABEL_TONES[source?.label.colour ?? "none"];

  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="data-write-source">
      {source === undefined ? null : (
        <span className={cn(KICKER, "shrink-0", tone.text)}>{kickerText(source)}</span>
      )}
      <span className="text-caption text-text-subtle min-w-0 truncate font-mono">
        {[write.target.sourceName, write.target.engine, write.target.database].join(" · ")}
      </span>
    </div>
  );
};

/** "Dry run · rolled back · 214 rows"; unpreviewed, its reason in the needs-you tone and what it can't show. */
const Kicker = ({
  write,
  showing,
}: {
  readonly write: DataWrite;
  readonly showing: string | null;
}) =>
  notPreviewed(write) ? (
    <div className="flex flex-col gap-1" data-testid="data-write-unpreviewed">
      <span className="flex items-center gap-1.5">
        <PixelAlertIcon size={12} className="text-needs-you shrink-0" aria-hidden />
        <span className={cn(KICKER, "text-needs-you-text")} data-testid="data-write-kicker">
          {dryRunKicker(write)}
        </span>
      </span>
      <p className="text-body text-text-default">{notPreviewedWarning(write)}</p>
    </div>
  ) : (
    <div className="flex items-baseline gap-2">
      <span className={cn(KICKER, "text-text-subtle")} data-testid="data-write-kicker">
        {dryRunKicker(write)}
      </span>
      <span className="flex-1" />
      {showing === null ? null : (
        <span className="text-caption text-text-subtle tabular">{showing}</span>
      )}
    </div>
  );

const DenyField = ({
  requestId,
  onDeny,
}: {
  readonly requestId: string;
  readonly onDeny: (decision: ApprovalDecision, reason: string) => void;
}) => {
  const { draft, asked } = useDeny(requestId);
  const field = useRef<HTMLTextAreaElement>(null);
  const decision = denyDecision(draft);

  // Opened here or asked from the inbox, ⌘⇧D or a notification: the field takes focus.
  useEffect(() => field.current?.focus(), [asked]);

  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeDeny(requestId);

    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();

    if (decision !== null) onDeny(decision, draft.trim());
  };

  return (
    <div className="flex flex-col gap-2" data-testid="data-write-deny">
      <Textarea
        ref={field}
        value={draft}
        onChange={(e) => setDenyDraft(requestId, e.target.value)}
        onKeyDown={keys}
        placeholder="Tell the agent why, so it can try another way"
        aria-label={DENY_PROMPT}
        className="max-h-32"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="text-caption text-text-subtle mr-auto">
          {decision === null ? "A reason is required" : "The agent reads this"}
        </span>
        <Button variant="ghost" className="rounded-full" onClick={() => closeDeny(requestId)}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          className="rounded-full"
          disabled={decision === null}
          onClick={() => decision !== null && onDeny(decision, draft.trim())}
          data-testid="data-write-deny-send"
        >
          Deny
        </Button>
      </div>
    </div>
  );
};

export const WriteApprovalCard = ({
  hostKey,
  request,
  write,
  who,
  source,
  outcome,
  entry,
  onOpenTable,
}: WriteApprovalCardProps) => {
  const [sent, setSent] = useState<WriteOutcome | null>(null);
  const deny = useDeny(request.id);
  const shown = useShownApproval(request.id);
  const ended = outcome ?? sent;

  // Opened with nothing else focused, the card takes focus so ⌘↵ runs it.
  const shownRef = useCallback(
    (element: HTMLElement | null) => {
      if (element !== null && (document.activeElement ?? document.body) === document.body)
        element.focus({ preventScroll: true });

      return shown(element);
    },
    [shown]
  );

  if (ended !== null)
    return <SettledWrite settled={settledLine(write, ended, entry)} onOpenTable={onOpenTable} />;

  const answer = (decision: ApprovalDecision, as: WriteOutcome) => {
    setSent(as);
    void decide({ hostKey, sessionId: request.sessionId, request }, decision).then((ok) => {
      if (!ok) setSent(null);
      else closeDeny(request.id);
    });
  };

  const run = () => answer(runDecision(), { kind: "allowed" });

  const keys = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || deny.open) return;
    event.preventDefault();
    run();
  };

  const bar = topBarColour(source);
  const params = paramsLine(write);
  const showing = showingLine(write);
  const note = noteLine(write);
  const unpreviewed = notPreviewed(write);

  return (
    <section
      ref={shownRef}
      tabIndex={-1}
      data-testid="data-write"
      data-surface="raised"
      aria-label={runLabel(write)}
      onKeyDown={keys}
      className="rounded-card border-hairline bg-surface-raised focus-visible:outline-starlight flex w-full max-w-[640px] flex-col overflow-clip border outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {bar === null ? null : (
        <div
          className={cn("h-[3px] shrink-0", LABEL_TONES[bar].fill)}
          data-testid="data-write-bar"
          data-colour={bar}
        />
      )}
      <div className="flex flex-col gap-1.5 px-[18px] pt-4 pb-3">
        <SourceLine write={write} source={source} />
        <h3 className="text-heading text-text-strong font-medium [overflow-wrap:anywhere]">
          {`${who} ${writeWants(write)}`}
        </h3>
      </div>
      <div className="flex flex-col gap-3 px-[18px] pb-3.5">
        <div className="flex flex-col gap-3" data-approval-part="statement">
          <SqlStatement sql={write.sql} />
          {params.length === 0 ? null : (
            <p
              className="text-code-inline text-text-subtle -mt-1.5 font-mono [overflow-wrap:anywhere]"
              data-testid="data-write-params"
            >
              {params.join(" · ")}
            </p>
          )}
          <Kicker write={write} showing={showing} />
        </div>
        {unpreviewed ? null : <BeforeAfter write={write} />}
        {note === null ? null : (
          <p className="text-caption text-text-subtle" data-testid="data-write-note">
            {note}
          </p>
        )}
        <div className="flex flex-col gap-1">
          <span className={cn(KICKER, "text-text-faint")}>Why</span>
          <p className="text-body text-text-default [overflow-wrap:anywhere] whitespace-pre-wrap">
            {write.reason.trim() === "" ? "The agent gave no reason." : write.reason}
          </p>
        </div>
      </div>
      <div className="border-hairline border-t px-[18px] py-3" data-approval-part="run">
        {deny.open ? (
          <DenyField
            requestId={request.id}
            onDeny={(decision, reason) => answer(decision, { kind: "denied", reason })}
          />
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              className="rounded-full"
              onClick={() => openDeny(request.id)}
              data-testid="data-write-deny-open"
            >
              {DENY_PROMPT}
            </Button>
            <Button
              variant={unpreviewed ? "secondary" : "primary"}
              className="rounded-full"
              onClick={run}
              data-testid="data-write-run"
            >
              {runLabel(write)}
              <Kbd variant="plain">{cmShortcut("Mod-Enter")}</Kbd>
            </Button>
          </div>
        )}
      </div>
    </section>
  );
};
