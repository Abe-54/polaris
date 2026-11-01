/** The Logs tab: the log records written during the Span, newest first, at most 20 of `count`. */
import type { LogRecord } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { fieldText } from "../../model/span/fields.ts";
import { plural } from "../../../session/model/format.ts";
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

export const Logs = ({
  logs,
  count,
  start,
}: {
  readonly logs: ReadonlyArray<LogRecord>;
  readonly count: number;
  /** The Span's start, for each record's offset. */
  readonly start: string;
}) =>
  logs.length === 0 ? (
    <Quiet>No logs were written during this span.</Quiet>
  ) : (
    <>
      <ul className="flex flex-col">
        {logs.map((log) => (
          <Log key={log.id} log={log} start={start} />
        ))}
      </ul>
      {count > logs.length ? (
        <Quiet>
          The newest {logs.length} of {plural(count, "log record")}
        </Quiet>
      ) : null}
    </>
  );
