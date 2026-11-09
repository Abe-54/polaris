/** The Logs tab: the Span's log records, newest first, 20 at a time with "Show older" past them. */
import type { LogRecord } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { fieldText } from "../../model/span/fields.ts";
import { plural } from "../../../session/model/format.ts";
import type { OlderLogs } from "../../data/hooks.tsx";
import { offsetLabel, Quiet, Value } from "./parts.tsx";

/** OTLP severity numbers: 17 and up are ERROR or FATAL, 13–16 WARN. */
const severityTone = (n: number) =>
  n >= 17
    ? "text-severity-critical-text"
    : n >= 13
      ? "text-severity-medium-text"
      : "text-text-subtle";

const severityName = (log: LogRecord) => {
  if (log.severityText !== "") return log.severityText.toUpperCase();

  return log.severityNumber > 0 ? `SEV ${log.severityNumber}` : "LOG";
};

const Log = ({ log, start }: { readonly log: LogRecord; readonly start: string }) => (
  <li className="border-hairline flex flex-col gap-1 border-b px-4 py-2" data-testid="span-log">
    <div className="text-code-inline flex items-center gap-2 font-mono">
      <span className={cn("shrink-0", severityTone(log.severityNumber))}>{severityName(log)}</span>
      <span className="text-text-faint tabular shrink-0">
        {offsetLabel(start, log.timeUnixNano)}
      </span>
    </div>
    <Value text={fieldText(log.body)} />
    {Object.keys(log.attributes).length === 0 ? null : (
      <p className="text-code-inline text-text-subtle font-mono [overflow-wrap:anywhere]">
        {Object.entries(log.attributes).map(([k, v], i) => (
          <span key={k}>
            {i === 0 ? "" : " · "}
            {k}=<Value text={fieldText(v)} className="text-text-subtle" />
          </span>
        ))}
      </p>
    )}
  </li>
);

const More = ({
  shown,
  count,
  older,
}: {
  readonly shown: ReadonlyArray<LogRecord>;
  readonly count: number;
  readonly older: OlderLogs;
}) => (
  <div className="flex items-center gap-3 px-4 py-3" data-testid="span-logs-more">
    <p className="text-caption text-text-subtle min-w-0 flex-1">
      {older.error === null
        ? `The newest ${shown.length.toLocaleString("en-US")} of ${plural(count, "log record")}`
        : `Couldn't read older logs: ${older.error.message}`}
    </p>
    <button
      type="button"
      disabled={older.reading}
      onClick={() => older.more(shown)}
      data-testid="span-logs-older"
      className="text-caption text-text-subtle hover:text-text-default focus-visible:ring-starlight rounded-control shrink-0 cursor-default px-1 outline-none focus-visible:ring-2 disabled:opacity-60"
    >
      {older.reading ? "Reading…" : "Show older"}
    </button>
  </div>
);

export const Logs = ({
  logs,
  count,
  start,
  older,
}: {
  readonly logs: ReadonlyArray<LogRecord>;
  readonly count: number;
  /** The Span's start, for each record's offset. */
  readonly start: string;
  readonly older: OlderLogs;
}) => {
  const shown = older.logs.length === 0 ? logs : [...logs, ...older.logs];

  return shown.length === 0 ? (
    <Quiet>No logs were written during this span.</Quiet>
  ) : (
    <>
      <ul className="flex flex-col">
        {shown.map((log) => (
          <Log key={log.id} log={log} start={start} />
        ))}
      </ul>
      {count > shown.length ? <More shown={shown} count={count} older={older} /> : null}
    </>
  );
};
