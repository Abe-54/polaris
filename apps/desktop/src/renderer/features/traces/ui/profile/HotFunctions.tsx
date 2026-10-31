/**
 * "Hot functions · total time" (DESIGN.md, Traces → Profile; Paper T2): the functions by total
 * time with where they are, a share of the recording beside each. One in the checkout opens its
 * file:line in the Editor.
 */
import type { ProfileDetail, ProfileFunction } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { opensInEditor, placeLabel, shareLabel } from "../../model/profile/labels.ts";

const SHOWN = 30;

const Row = ({
  fn,
  recordedMs,
  checkout,
  onOpen,
}: {
  readonly fn: ProfileFunction;
  readonly recordedMs: number;
  readonly checkout: string | null;
  readonly onOpen: (fn: ProfileFunction) => void;
}) => {
  const opens = opensInEditor(fn, checkout);
  const place = placeLabel(fn, checkout);

  const content = (
    <>
      <span className="text-code-inline text-text-default min-w-0 flex-1 truncate font-mono">
        {fn.name} <span className="text-text-faint">{place}</span>
      </span>
      <span className="text-code-inline text-text-subtle tabular w-10 shrink-0 text-right font-mono">
        {shareLabel(fn.totalMs, recordedMs)}
      </span>
    </>
  );

  const row = "flex min-h-5 w-full items-center gap-2.5 rounded-control text-left";

  return opens ? (
    <button
      type="button"
      onClick={() => onOpen(fn)}
      title={`Open ${place} in the editor`}
      data-testid="hot-function"
      className={cn(
        row,
        "hover:bg-fill-hover focus-visible:ring-starlight cursor-default outline-none focus-visible:ring-2"
      )}
    >
      {content}
    </button>
  ) : (
    <div className={row} data-testid="hot-function">
      {content}
    </div>
  );
};

export const HotFunctions = ({
  detail,
  checkout,
  onOpen,
}: {
  readonly detail: ProfileDetail;
  readonly checkout: string | null;
  readonly onOpen: (fn: ProfileFunction) => void;
}) => (
  <section aria-label="Hot functions" className="flex w-[340px] shrink-0 flex-col gap-1.5">
    <h3 className="text-text-subtle pb-0.5 font-mono text-[11px] leading-[14px] font-medium tracking-[0.06em]">
      HOT FUNCTIONS · TOTAL TIME
    </h3>
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
      {detail.hotFunctions.slice(0, SHOWN).map((fn, i) => (
        <Row
          key={i}
          fn={fn}
          recordedMs={detail.profile.durationMs}
          checkout={checkout}
          onOpen={onOpen}
        />
      ))}
    </div>
  </section>
);
