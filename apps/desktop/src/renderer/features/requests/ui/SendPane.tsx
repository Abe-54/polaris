/**
 * The send pane's slot (DESIGN.md, Requests → Send pane), U2's to fill: status and duration, the
 * response, then TRACE and DATA. Until then, the latest send's status line or how to make one.
 */
import { commandShortcut } from "../../../../shared/keymap.ts";
import type { SendPaneProps } from "./slots.ts";

const statusLine = (latest: NonNullable<SendPaneProps["latest"]>) =>
  latest.status === undefined
    ? latest.outcome
    : `${latest.status}${latest.statusText === undefined ? "" : ` ${latest.statusText}`}`;

export const SendPane = ({ latest, sending }: SendPaneProps) => (
  <section
    aria-label="Response"
    className="flex w-[500px] max-w-[45%] shrink-0 flex-col"
    data-testid="requests-send-pane"
  >
    {latest === null ? (
      <p className="text-caption text-text-subtle px-panel pt-4">
        {sending ? "Sending…" : `Send it with ${commandShortcut("requests.send")}`}
      </p>
    ) : (
      <div className="px-panel flex items-baseline gap-2 pt-3.5 pb-2.5">
        <span className="text-heading-sm text-text-strong font-mono font-semibold">
          {statusLine(latest)}
        </span>
        <span className="text-caption text-text-subtle font-mono">
          {`${Math.round(latest.durationMs)} ms`}
        </span>
      </div>
    )}
  </section>
);
