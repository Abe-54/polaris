/**
 * Settings → Usage (DESIGN.md, SR-05): Plan limits and Tokens over 7 / 30 / 90 days as in 0.5.0
 * (`UsageTokens.tsx`), then By constellation (`UsageByConstellation.tsx`).
 */
import { cn, Dither, hueVar, InstrumentCard, SettingsPage, Tile } from "@polaris/ui";
import { useState } from "react";
import { useNow } from "../../../shell/useNow.ts";
import { useRunningHarnesses } from "../../harness/index.ts";
import { type LimitRow, type LimitWindow, limitRows, METER_CELLS } from "../model/planLimits.ts";
import { sectionInfo } from "../model/sections.ts";
import { pricedEstimate, type RangeDays, usageSummary } from "../model/usage.ts";
import { UsageByConstellation } from "./UsageByConstellation.tsx";
import { CARD_CAPTION, TokensCard } from "./UsageTokens.tsx";
import { useUsage } from "./useUsage.ts";

/** Paper S2's meter: 40 cells of 4×10px with 1px gaps. */
const CELL = 4;

const PITCH = CELL + 1;

const METER_WIDTH = METER_CELLS * PITCH - 1;

const cellFill = (harness: string, i: number, filled: number) =>
  i < filled ? hueVar(harness) : "light-dark(#0000000f, #ffffff12)";

/**
 * What's left as discrete cells: filled in the Harness hue, empty as faint
 * tracks. One SVG with crisp edges (`pixelated`), so the 1px gaps survive a
 * fractional x. The pace marker is one of the cells in `text-strong`, a pixel
 * taller each way: where the fill would end if used evenly. Never a signal colour.
 */
const Meter = ({
  harness,
  filled,
  pace,
}: {
  readonly harness: string;
  readonly filled: number;
  readonly pace: number | null;
}) => (
  <svg
    aria-hidden
    width={METER_WIDTH}
    height={12}
    viewBox={`0 0 ${METER_WIDTH} 12`}
    className="pixelated block shrink-0"
    data-testid="plan-meter"
    data-filled={filled}
    data-pace={pace ?? undefined}
  >
    {Array.from({ length: METER_CELLS }, (_, i) =>
      i === pace ? (
        <rect
          key={i}
          x={i * PITCH}
          width={CELL}
          height={12}
          style={{ fill: "var(--color-text-strong)" }}
        />
      ) : (
        <rect
          key={i}
          x={i * PITCH}
          y={1}
          width={CELL}
          height={10}
          style={{ fill: cellFill(harness, i, filled) }}
        />
      )
    )}
  </svg>
);

const WindowCell = ({ harness, win }: { readonly harness: string; readonly win: LimitWindow }) => (
  <div
    className="flex min-w-0 flex-col gap-1.5"
    style={{ flex: `1 0 ${METER_WIDTH}px` }}
    data-testid="plan-window"
  >
    <div className="flex justify-between gap-2" style={{ maxWidth: METER_WIDTH }}>
      <span className="text-caption text-text-subtle truncate">{win.label}</span>
      <span className="text-caption text-text-default tabular shrink-0">{win.left ?? ""}</span>
    </div>
    <Meter harness={harness} filled={win.filledCells} pace={win.pace?.cell ?? null} />
    <span className="text-caption text-text-subtle flex flex-col">
      <span>{win.note}</span>
      {win.pace === null ? null : <span data-testid="plan-forecast">{win.pace.words}</span>}
      {win.pace?.sessions == null ? null : <span>{win.pace.sessions}</span>}
    </span>
  </div>
);

const HarnessTile = ({ harness, size }: { readonly harness: string; readonly size: 28 | 40 }) => (
  <Tile hue={harness} size={size}>
    <Dither hue={harness} size={size === 40 ? 20 : 12} />
  </Tile>
);

const LimitRowView = ({ row }: { readonly row: LimitRow }) => (
  <div
    className={cn(
      "px-panel gap-section flex py-3.5",
      row.windows.length > 2 ? "items-start" : "items-center"
    )}
  >
    <div className="flex w-[184px] shrink-0 items-center gap-2.5">
      <HarnessTile harness={row.harness} size={28} />
      <span className="flex min-w-0 flex-col">
        <span className="text-label text-text-default truncate">{row.name}</span>
        <span className="text-caption text-text-subtle truncate">{row.caption}</span>
      </span>
    </div>
    {/* Windows wrap to another line rather than clip: two fit beside the label, a third goes under. */}
    <div className="gap-x-section flex min-w-0 flex-1 flex-wrap gap-y-3">
      {row.windows.map((win) => (
        <WindowCell key={win.key} harness={row.harness} win={win} />
      ))}
    </div>
  </div>
);

/** OpenCode reports a limit only when a provider refuses work, so its absence needs saying (Paper S2). */
const OPENCODE_ASIDE = "OpenCode reports a limit only once you reach it";

const PlanLimits = ({
  rows,
  harnesses,
}: {
  readonly rows: ReadonlyArray<LimitRow>;
  /** Harnesses with Usage in the range. */
  readonly harnesses: ReadonlyArray<string>;
}) => {
  const quietOpenCode =
    harnesses.includes("opencode") && !rows.some((r) => r.harness === "opencode");

  if (rows.length === 0) {
    return (
      <p className={CARD_CAPTION}>
        No plan limits reported yet. A harness reports its limits as it runs.
      </p>
    );
  }

  return (
    <InstrumentCard
      aria-label="Plan limits"
      className="w-full"
      header={{
        title: "Plan limits",
        control: <span className={CARD_CAPTION}>What's left in each window, counting down</span>,
      }}
      wells={[
        <div key="rows" className="divide-hairline flex flex-col divide-y">
          {rows.map((row) => (
            <LimitRowView key={row.harness} row={row} />
          ))}
        </div>,
      ]}
      footer={{
        status: rows.map((row) => `${row.name} ${row.fresh}`).join(" · "),
        action: quietOpenCode ? <span className={CARD_CAPTION}>{OPENCODE_ASIDE}</span> : undefined,
      }}
    />
  );
};

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" strokeLinecap="round" />
  </svg>
);

export const UsagePage = () => {
  const [days, setDays] = useState<RangeDays>(30);
  const data = useUsage(days);
  const now = useNow();
  const running = useRunningHarnesses();
  const info = sectionInfo("usage");
  const summary = usageSummary({ buckets: data.buckets, days, now, estimate: pricedEstimate });

  return (
    <SettingsPage
      title={info.title}
      blurb="Tokens from every harness on every host, read from their own logs."
      scope="All hosts"
      scopeIcon={<ScreenGlyph />}
    >
      {data.hostCount === 0 ? (
        <p className="text-caption text-text-subtle">No connected host reports usage yet.</p>
      ) : (
        <>
          <PlanLimits rows={limitRows(data.limits, now, running)} harnesses={summary.harnesses} />
          <TokensCard
            summary={summary}
            now={now}
            hostCount={data.hostCount}
            indexing={data.indexing}
            days={days}
            onDays={setDays}
          />
          {summary.tokens === 0 ? null : (
            <UsageByConstellation
              buckets={data.buckets}
              now={now}
              estimate={pricedEstimate}
              days={days}
              total={summary.cost}
            />
          )}
        </>
      )}
    </SettingsPage>
  );
};
