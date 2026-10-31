/**
 * The Data Source Approval card (DESIGN.md, Data; Paper "Let agents read analytics?"): the exact
 * target in a well, the scope, Deny and Approve, and the Host that remembers it. A Needs You.
 * Every view of one request shares its scope and shows a decision made in any of them.
 */
import type { ApprovalDecision, ApprovalRequest } from "@polaris/protocol";
import { Button, cn, LockIcon } from "@polaris/ui";
import { useEffect, useId } from "react";
import { useShownApproval } from "../../../shell/approvalInView.ts";
import { decide as send } from "../../needs-you/respond.ts";
import { setApprovalScope, settleOnce, useApprovalScope, useDecidedHere } from "./decide.ts";
import {
  approvalBody,
  approvalTitle,
  approveDecision,
  DATA_APPROVAL_FOOTNOTE,
  type DataScope,
  type DataSourceTarget,
  denyDecision,
  rememberedOn,
  SCOPES,
  scopeNote,
  targetRows,
} from "./model.ts";

export interface DataSourceApprovalCardProps {
  readonly hostKey: string;
  readonly request: ApprovalRequest;
  readonly target: DataSourceTarget;
  /** The asking Agent Session's title, "Backfill currency", in every view. */
  readonly who: string;
  readonly hostLabel: string;
  /** The target is approved already (another session's request, another device): it settles. */
  readonly alreadyApproved: boolean;
}

const SETTLED = {
  approved: "Approved. Agents can read it now.",
  denied: "Denied. No agent can reach it.",
} as const;

const Well = ({ target }: { readonly target: DataSourceTarget }) => (
  <dl
    data-testid="data-approval-target"
    className="border-hairline bg-well gap-gap mx-3.5 flex flex-col rounded-[12px] border px-3.5 py-3"
  >
    {targetRows(target).map(([label, value]) => (
      <div key={label} className="flex min-w-0 gap-3">
        <dt className="text-text-faint w-[72px] shrink-0 font-mono text-[11px] leading-4 tracking-[0.06em] uppercase">
          {label}
        </dt>
        <dd className="text-caption text-text-default min-w-0 truncate font-mono" title={value}>
          {value}
        </dd>
      </div>
    ))}
  </dl>
);

const Scope = ({
  target,
  value,
  disabled,
  onChange,
}: {
  target: DataSourceTarget;
  value: DataScope;
  disabled: boolean;
  onChange: (scope: DataScope) => void;
}) => {
  const name = useId();

  return (
    <fieldset disabled={disabled} className="px-row-x flex flex-col gap-0.5 pt-3 pb-1">
      <legend className="sr-only">Who it covers</legend>
      {SCOPES.map(({ scope, label }) => {
        const note = scopeNote(target, scope);

        return (
          <label
            key={scope}
            className={cn(
              "text-body flex h-[34px] shrink-0 cursor-default items-center gap-row-x rounded-row px-gap",
              value === scope
                ? "bg-fill-selected text-text-strong"
                : "text-text-default hover:bg-fill-hover"
            )}
          >
            <input
              type="radio"
              name={name}
              value={scope}
              checked={value === scope}
              onChange={() => onChange(scope)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className={cn(
                "peer-focus-visible:outline-starlight size-3.5 shrink-0 rounded-full peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1",
                value === scope ? "border-starlight border-4" : "border-text-faint border-[1.5px]"
              )}
            />
            <span>
              {label}
              {note === null ? null : <span className="text-text-subtle">{` · ${note}`}</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
};

export const DataSourceApprovalCard = ({
  hostKey,
  request,
  target,
  who,
  hostLabel,
  alreadyApproved,
}: DataSourceApprovalCardProps) => {
  const scope = useApprovalScope(request.id);
  const decided = useDecidedHere(request.id);
  const shownRef = useShownApproval(request.id);

  const decide = (decision: ApprovalDecision) =>
    void send({ hostKey, sessionId: request.sessionId, request }, decision);

  // Approved already, the request only holds the agent up: answering it lets it go on.
  useEffect(() => {
    if (alreadyApproved && decided === null && settleOnce(request.id))
      void send({ hostKey, sessionId: request.sessionId, request }, approveDecision("target"));
  }, [alreadyApproved, decided, hostKey, request]);

  return (
    <section
      ref={shownRef}
      data-testid="data-approval"
      data-surface="raised"
      aria-label={approvalTitle(target)}
      className="rounded-card border-hairline bg-surface-raised flex w-full max-w-[400px] flex-col overflow-clip border"
    >
      <div className="flex flex-col gap-1.5 px-[18px] pt-[18px] pb-3.5">
        <div className="gap-gap flex items-center">
          <LockIcon size={14} className="text-needs-you shrink-0" />
          <h3 className="text-heading text-text-strong min-w-0 font-medium [overflow-wrap:anywhere]">
            {approvalTitle(target)}
          </h3>
        </div>
        <p className="text-body text-text-subtle">{approvalBody(who, target)}</p>
      </div>
      <Well target={target} />
      <Scope
        target={target}
        value={scope}
        disabled={decided !== null}
        onChange={(s) => setApprovalScope(request.id, s)}
      />
      <p className="text-caption text-text-subtle px-[18px] pt-1 pb-3.5">
        {DATA_APPROVAL_FOOTNOTE}
      </p>
      <div className="border-hairline gap-gap flex items-center border-t py-3 pr-3.5 pl-[18px]">
        <span className="text-text-subtle min-w-0 flex-1 truncate font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase">
          {rememberedOn(hostLabel)}
        </span>
        {decided === null ? (
          <>
            <Button variant="ghost" className="rounded-full" onClick={() => decide(denyDecision())}>
              Deny
            </Button>
            <Button
              variant="secondary"
              className="rounded-full"
              onClick={() => decide(approveDecision(scope))}
              data-testid="data-approval-approve"
            >
              Approve
            </Button>
          </>
        ) : (
          <p
            role="status"
            data-testid="data-approval-settled"
            className="text-caption text-text-subtle"
          >
            {SETTLED[decided]}
          </p>
        )}
      </div>
    </section>
  );
};
