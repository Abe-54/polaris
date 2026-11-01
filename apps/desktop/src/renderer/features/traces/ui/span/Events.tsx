/**
 * The Events tab: each event with its time from the span's start. An `exception` shows its type,
 * message and stack, the checkout's own frames first, each opening in the Editor.
 */
import type { Span } from "@polaris/protocol";
import { Button } from "@polaris/ui";
import { useState } from "react";
import { FileLink } from "../../../editor-links/index.ts";
import { type ExceptionView, exceptionOf, type StackFrame } from "../../model/span/code.ts";
import { fieldText } from "../../model/span/fields.ts";
import { FieldRow, offsetLabel, Quiet, Value } from "./parts.tsx";

/** Frames shown before "n more frames"; the checkout's own are always all shown. */
const OTHER_FRAMES = 3;

const Frame = ({ frame }: { readonly frame: StackFrame }) => (
  <li
    className="text-code-inline flex min-w-0 gap-2 font-mono"
    data-testid="span-frame"
    data-in-project={frame.inProject || undefined}
  >
    <span className={frame.inProject ? "text-text-default" : "text-text-faint"}>
      {frame.fn ?? "<anonymous>"}
    </span>
    {frame.inProject ? (
      <FileLink
        path={frame.location.path}
        line={frame.location.line}
        column={frame.location.column}
        className="text-text-subtle"
      />
    ) : (
      <span className="text-text-faint min-w-0 truncate" title={frame.location.path}>
        {frame.location.path}:{frame.location.line}
      </span>
    )}
  </li>
);

const Exception = ({ exception }: { readonly exception: ExceptionView }) => {
  const [all, setAll] = useState(false);
  const own = exception.frames.filter((f) => f.inProject).length;
  const limit = all ? exception.frames.length : own + OTHER_FRAMES;
  const hidden = exception.frames.length - limit;

  return (
    <div className="flex flex-col gap-1.5 pr-4 pl-[30px]" data-testid="span-exception">
      {exception.type === null ? null : (
        <span className="text-code-inline text-severity-critical-text font-mono">
          {exception.type}
        </span>
      )}
      {exception.message === null ? null : <Value text={exception.message} />}
      {exception.frames.length === 0 ? null : (
        <ol className="flex flex-col gap-0.5 pt-1">
          {exception.frames.slice(0, limit).map((f, i) => (
            <Frame key={i} frame={f} />
          ))}
        </ol>
      )}
      {hidden > 0 ? (
        <Button variant="ghost" size="xs" className="self-start" onClick={() => setAll(true)}>
          {hidden} more {hidden === 1 ? "frame" : "frames"}
        </Button>
      ) : null}
    </div>
  );
};

type SpanEvent = Span["events"][number];

const EXCEPTION_KEYS = new Set(["exception.type", "exception.message", "exception.stacktrace"]);

const Event = ({
  event,
  span,
  checkout,
}: {
  readonly event: SpanEvent;
  readonly span: Span;
  readonly checkout: string;
}) => {
  const exception = exceptionOf(event, checkout);

  const rest = Object.entries(event.attributes).filter(
    ([k]) => exception === null || !EXCEPTION_KEYS.has(k)
  );

  return (
    <li className="border-hairline flex flex-col gap-1 border-b py-2" data-testid="span-event">
      <div className="text-code-inline flex items-center gap-2 px-4 font-mono">
        <span className="text-text-strong">{event.name}</span>
        <span className="text-text-faint tabular">
          {offsetLabel(span.startTimeUnixNano, event.timeUnixNano)}
        </span>
      </div>
      {exception === null ? null : <Exception exception={exception} />}
      {rest.map(([k, v]) => (
        <FieldRow key={k} name={k}>
          <Value text={fieldText(v)} />
        </FieldRow>
      ))}
    </li>
  );
};

export const Events = ({ span, checkout }: { readonly span: Span; readonly checkout: string }) =>
  span.events.length === 0 ? (
    <Quiet>This span recorded no events.</Quiet>
  ) : (
    <ul className="flex flex-col">
      {span.events.map((e, i) => (
        <Event key={i} event={e} span={span} checkout={checkout} />
      ))}
    </ul>
  );
