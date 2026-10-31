/**
 * Times as Traces writes them: durations that fit a 40px lane ("840 ms", "3.1 s"), wall-clock
 * starts to the millisecond ("14:02:11.204"), short ids ("4f1c…9a2e") and the ruler's ticks.
 */

const SECOND = 1000;

const MINUTE = 60 * SECOND;

/** At most six characters, for the sidebar's 40px lane and the bars' labels. */
export const durationLabel = (ms: number): string => {
  if (ms < 1) return ms <= 0 ? "0 ms" : "<1 ms";

  if (ms < 10) return `${(Math.round(ms * 10) / 10).toString()} ms`;

  if (ms < 999.5) return `${Math.round(ms)} ms`;

  if (ms < 9.95 * SECOND) return `${(ms / SECOND).toFixed(1)} s`;

  if (ms < 599.5 * SECOND) return `${Math.round(ms / SECOND)} s`;

  return `${Math.round(ms / MINUTE)} min`;
};

const pad = (n: number, width = 2) => n.toString().padStart(width, "0");

/** Local wall-clock time of exact Unix nanoseconds, to the millisecond. */
export const clockLabel = (unixNs: bigint): string => {
  const at = new Date(Number(unixNs / 1_000_000n));

  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
};

/** "4f1c…9a2e": enough of an id to tell it apart, with the whole id in its title. */
export const shortHex = (id: string): string =>
  id.length <= 9 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;

export interface Tick {
  /** Milliseconds after the trace's start. */
  readonly at: number;
  readonly label: string;
}

const STEPS = [1, 2, 5] as const;

/** The smallest 1-2-5 step that gives at most `most` ticks over `span` ms. */
const stepFor = (span: number, most: number) => {
  for (let power = -3; power < 9; power++)
    for (const step of STEPS) {
      const size = step * 10 ** power;

      if (Math.floor(span / size) + 1 <= most) return size;
    }

  return span;
};

const tickLabel = (at: number) => {
  if (at === 0) return "0";

  if (at >= SECOND) return `${Number((at / SECOND).toFixed(3)).toString()} s`;

  return `${Number(at.toFixed(3)).toString()} ms`;
};

/** Round ticks across [from, to] ms, at most `most` of them, labelled in one unit. */
export const rulerTicks = (from: number, to: number, most = 5): ReadonlyArray<Tick> => {
  const span = to - from;

  if (!(span > 0)) return [{ at: from, label: tickLabel(from) }];
  const step = stepFor(span, most);
  const ticks: Array<Tick> = [];

  for (let i = Math.ceil(from / step); i * step <= to + step * 1e-9; i++)
    ticks.push({ at: i * step, label: tickLabel(i * step) });

  return ticks;
};
