/**
 * The anatomy every remembered approval card shares (DESIGN.md, Data → approval; Requests →
 * States): the lock and question, who asks, the exact target in a well, a scope to pick, a note,
 * and the Host that remembers it beside Deny and Approve. Data Sources and Origin Approvals use it.
 */
import { Button, cn, LockIcon } from "@polaris/ui";
import { type ReactNode, type Ref, useId } from "react";

/** Label and value rows in a well; also what a failed Send shows it sent. */
export const ApprovalWell = ({
  rows,
  testId,
  className = "mx-3.5",
}: {
  readonly rows: ReadonlyArray<readonly [label: string, value: string]>;
  readonly testId: string;
  readonly className?: string;
}) => (
  <dl
    data-testid={testId}
    className={cn(
      "border-hairline bg-well gap-gap flex flex-col rounded-[12px] border px-3.5 py-3",
      className
    )}
  >
    {rows.map(([label, value]) => (
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

export interface ScopeOption<S extends string> {
  readonly scope: S;
  readonly label: string;
  /** Said after the label, quieter: " · branches too". */
  readonly note: string | null;
}

export const ApprovalScope = <S extends string>({
  options,
  value,
  disabled,
  onChange,
}: {
  readonly options: ReadonlyArray<ScopeOption<S>>;
  readonly value: S;
  readonly disabled: boolean;
  readonly onChange: (scope: S) => void;
}) => {
  const name = useId();

  return (
    <fieldset disabled={disabled} className="px-row-x flex flex-col gap-0.5 pt-3 pb-1">
      <legend className="sr-only">Who it covers</legend>
      {options.map(({ scope, label, note }) => (
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
      ))}
    </fieldset>
  );
};

export interface ApprovalFrameProps {
  readonly title: string;
  readonly body: string;
  /** "Remembered on Mac Studio". */
  readonly remembered: string;
  /** What this device decided, until the Daemon resolves the request; null while open. */
  readonly settled: string | null;
  readonly onDeny: () => void;
  readonly onApprove: () => void;
  /** The `data-testid` prefix: `<p>`, `<p>-approve`, `<p>-settled`. */
  readonly testId: string;
  readonly shownRef: Ref<HTMLElement>;
  /** The well, the scope and the note, in order. */
  readonly children: ReactNode;
}

export const ApprovalFrame = ({
  title,
  body,
  remembered,
  settled,
  onDeny,
  onApprove,
  testId,
  shownRef,
  children,
}: ApprovalFrameProps) => (
  <section
    ref={shownRef}
    data-testid={testId}
    data-surface="raised"
    aria-label={title}
    className="rounded-card border-hairline bg-surface-raised flex w-full max-w-[400px] flex-col overflow-clip border"
  >
    <div className="flex flex-col gap-1.5 px-[18px] pt-[18px] pb-3.5">
      <div className="gap-gap flex items-center">
        <LockIcon size={14} className="text-needs-you shrink-0" />
        <h3 className="text-heading text-text-strong min-w-0 font-medium [overflow-wrap:anywhere]">
          {title}
        </h3>
      </div>
      <p className="text-body text-text-subtle [overflow-wrap:anywhere]">{body}</p>
    </div>
    {children}
    <div className="border-hairline gap-gap flex items-center border-t py-3 pr-3.5 pl-[18px]">
      <span className="text-text-subtle min-w-0 flex-1 truncate font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase">
        {remembered}
      </span>
      {settled === null ? (
        <>
          <Button variant="ghost" className="rounded-full" onClick={onDeny}>
            Deny
          </Button>
          <Button
            variant="secondary"
            className="rounded-full"
            onClick={onApprove}
            data-testid={`${testId}-approve`}
          >
            Approve
          </Button>
        </>
      ) : (
        <p
          role="status"
          data-testid={`${testId}-settled`}
          className="text-caption text-text-subtle"
        >
          {settled}
        </p>
      )}
    </div>
  </section>
);

/** The quiet line under the scope. */
export const ApprovalNote = ({ children }: { readonly children: string }) => (
  <p className="text-caption text-text-subtle px-[18px] pt-1 pb-3.5">{children}</p>
);
