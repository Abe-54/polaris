/** What a Polaris tool row opens to: the call's well, a refusal's fix, the raw call. */
import { JsonText } from "../json.tsx";
import { CheckIcon, cn, CopyButton, harnessHue, PixelFailedIcon } from "@polaris/ui";
import { useOpenSession } from "./target.ts";
import type {
  CheckMark,
  FieldRow,
  HistoryRow,
  PolarisToolView,
  Refusal,
  Segment,
  Well,
} from "../../model/polarisTools/index.ts";

export const HueDot = ({ kind }: { readonly kind: string }) => {
  const hue = harnessHue(kind).hue;

  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", hue === null && "bg-text-faint")}
      style={hue === null ? undefined : { background: `var(--color-harness-${hue})` }}
    />
  );
};

const segmentClass = (segment: Segment) =>
  cn(
    segment.mono === true && "text-code-inline font-mono",
    segment.tone === "failed" && "text-failed-text",
    segment.tone === "faint" && "text-text-faint"
  );

export const Segments = ({
  segments,
  className,
}: {
  readonly segments: ReadonlyArray<Segment>;
  readonly className?: string;
}) =>
  segments.length === 0 ? null : (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {segments.map((segment, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1.5">
          {segment.hue === undefined ? null : <HueDot kind={segment.hue} />}
          <span className={cn("truncate", segmentClass(segment))}>{segment.text}</span>
        </span>
      ))}
    </span>
  );

const LABEL = "text-caption text-text-subtle w-24 shrink-0";

const Check = ({ check }: { readonly check: CheckMark }) => (
  <span className="text-caption text-text-default flex items-center gap-1">
    {check.state === "passed" ? <CheckIcon size={10} className="text-text-subtle" /> : null}
    {check.state === "failed" ? <PixelFailedIcon size={10} className="text-failed" /> : null}
    {check.state === "reported" ? (
      <span aria-hidden className="border-text-faint size-2 rounded-full border" />
    ) : null}
    <span className={cn(check.state === "failed" && "text-failed-text")}>{check.label}</span>
    {check.state === "reported" ? <span className="text-text-faint">reported</span> : null}
  </span>
);

const Rows = ({ rows }: { readonly rows: ReadonlyArray<FieldRow> }) =>
  rows.map((row, i) => (
    <div key={i} className="flex min-w-0 items-baseline gap-2">
      <span className={LABEL}>{row.label}</span>
      <Segments segments={row.value} className="text-caption text-text-default" />
    </div>
  ));

const Fields = ({ well }: { readonly well: Extract<Well, { kind: "fields" }> }) => (
  <>
    {well.text === null || well.text === "" ? null : (
      <p className="text-caption text-text-default wrap-anywhere whitespace-pre-wrap">
        {well.text}
      </p>
    )}
    {well.checks.length === 0 ? null : (
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={LABEL}>Checks</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {well.checks.map((check, i) => (
            <Check key={i} check={check} />
          ))}
        </span>
      </div>
    )}
    <Rows rows={well.rows} />
  </>
);

const Tasks = ({ well }: { readonly well: Extract<Well, { kind: "tasks" }> }) => (
  <>
    {well.heading === null ? null : (
      <span className="text-caption text-text-subtle">{well.heading}</span>
    )}
    {well.rows.map((row) => (
      <div key={row.id} className="text-caption flex min-w-0 items-center gap-2">
        <span className="text-code-inline text-text-default w-10 shrink-0 font-mono">{row.id}</span>
        <span
          className={cn(
            "min-w-0 truncate",
            row.struck === true ? "text-text-faint line-through" : "text-text-default"
          )}
        >
          {row.title}
        </span>
        <Segments segments={row.note} className="text-text-subtle min-w-0" />
        <span className="flex-1" />
        <Segments segments={row.change} className="text-text-subtle shrink-0" />
      </div>
    ))}
  </>
);

/** The notification as the user got it: title, the session and Host, the body. */
const Banner = ({
  well,
  from,
}: {
  readonly well: Extract<Well, { kind: "banner" }>;
  readonly from: string | null;
}) => (
  <div className="rounded-card border-hairline bg-surface-raised flex max-w-sm flex-col gap-0.5 border px-3 py-2.5 shadow-sm">
    <span className="text-body text-text-strong font-semibold">{well.title}</span>
    {from === null ? null : <span className="text-caption text-text-subtle">{from}</span>}
    {well.body === "" ? null : <span className="text-body text-text-default">{well.body}</span>}
  </div>
);

const Turns = ({ well }: { readonly well: Extract<Well, { kind: "turns" }> }) =>
  well.turns.map((turn, i) => (
    <div key={i} className="flex min-w-0 flex-col gap-0.5">
      <span className="text-caption text-text-subtle">{turn.heading}</span>
      {turn.reply === null ? null : (
        <span className="text-caption text-text-default">{turn.reply}</span>
      )}
      {turn.commands.map((command, j) => (
        <span key={j} className="text-code-inline text-text-subtle truncate font-mono">
          {command}
        </span>
      ))}
    </div>
  ));

/** A session the row names: a link to it when the row sits in a session, else its title. */
const SessionName = ({ session }: { readonly session: NonNullable<HistoryRow["session"]> }) => {
  const open = useOpenSession();

  if (open === null) return <span className="text-text-default truncate">{session.title}</span>;

  return (
    <button
      type="button"
      title={session.id}
      onClick={() => open(session.id)}
      className="text-text-strong decoration-text-faint hover:decoration-text-subtle min-w-0 cursor-pointer truncate underline underline-offset-2"
    >
      {session.title}
    </button>
  );
};

const History = ({ well }: { readonly well: Extract<Well, { kind: "history" }> }) =>
  well.rows.map((row, i) => (
    <div key={i} className="flex min-w-0 flex-col gap-0.5">
      <span className="text-caption text-text-subtle flex min-w-0 items-baseline gap-1.5">
        {row.session === null ? null : <SessionName session={row.session} />}
        <span className="shrink-0">{row.heading}</span>
      </span>
      {row.text === null ? null : (
        <span className="text-caption text-text-default wrap-anywhere">{row.text}</span>
      )}
    </div>
  ));

export const WellBody = ({ well, from }: { readonly well: Well; readonly from: string | null }) => {
  switch (well.kind) {
    case "fields":
      return <Fields well={well} />;
    case "tasks":
      return <Tasks well={well} />;
    case "tail":
      return (
        <pre className="text-code-inline text-text-default overflow-x-auto font-mono whitespace-pre">
          {well.text}
        </pre>
      );
    case "banner":
      return <Banner well={well} from={from} />;
    case "turns":
      return <Turns well={well} />;
    case "history":
      return <History well={well} />;
  }
};

/** A refusal is neutral: its code and the fix the agent reads, never red (DESIGN.md). */
export const RefusalBody = ({ refusal }: { readonly refusal: Refusal }) => (
  <>
    <div className="flex min-w-0 items-baseline gap-2">
      <span className={cn(LABEL, "text-code-inline font-mono")}>{refusal.code}</span>
      <span className="text-caption text-text-default">{refusal.message}</span>
    </div>
    {refusal.fix === null ? null : (
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={LABEL}>Fix</span>
        <span className="text-caption text-text-subtle">{refusal.fix}</span>
      </div>
    )}
  </>
);

/** A call as the Harness sent it: its real name, input and result, copyable. */
export const RawBody = ({
  raw,
  testId = "polaris-tool-raw",
}: {
  readonly raw: PolarisToolView["raw"];
  readonly testId?: string;
}) => {
  const text = [raw.name, raw.input, raw.output].filter((t) => t !== "").join("\n\n");

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <div className="flex items-center gap-2">
        <span className="text-code-inline text-text-subtle font-mono">{raw.name}</span>
        <span className="flex-1" />
        <CopyButton variant="icon" label="Copy the raw call" text={text} />
      </div>
      <pre className="text-code-inline text-text-default overflow-x-auto font-mono whitespace-pre">
        <JsonText text={raw.input} />
      </pre>
      {raw.output === "" ? null : (
        <pre className="text-code-inline text-text-subtle overflow-x-auto font-mono whitespace-pre-wrap">
          <JsonText text={raw.output} />
        </pre>
      )}
    </div>
  );
};
