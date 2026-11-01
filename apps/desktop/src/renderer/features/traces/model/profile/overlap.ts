/**
 * Where a Profile and a trace overlap in time (DESIGN.md, Traces → Profile): the range named in
 * the profile header ("60–700 ms of this trace") and marked under the ruler and on the flame chart.
 */
import type { Profile } from "@polaris/protocol";

/** A stretch of time in ms after some start (the trace's or the Profile's). */
export interface MsRange {
  readonly from: number;
  readonly to: number;
}

const NS_PER_MS = 1_000_000n;

/** When the Profile started and ended, in exact Unix nanoseconds. */
export const profileSpanNs = (profile: Pick<Profile, "startedAt" | "durationMs">) => {
  const startNs = BigInt(Date.parse(profile.startedAt)) * NS_PER_MS;

  return { startNs, endNs: startNs + BigInt(Math.round(profile.durationMs * 1_000_000)) };
};

const msBetween = (fromNs: bigint, toNs: bigint) => Number(toNs - fromNs) / 1_000_000;

/**
 * The part of [fromNs, toNs] the Profile recorded: in ms of the stretch itself (`stretch`) and
 * of the Profile (`profile`); null when they don't overlap.
 */
export const overlap = (
  profile: Pick<Profile, "startedAt" | "durationMs">,
  fromNs: bigint,
  toNs: bigint
): { readonly stretch: MsRange; readonly profile: MsRange } | null => {
  const { startNs, endNs } = profileSpanNs(profile);
  const from = startNs > fromNs ? startNs : fromNs;
  const to = endNs < toNs ? endNs : toNs;

  if (to <= from) return null;

  return {
    stretch: { from: msBetween(fromNs, from), to: msBetween(fromNs, to) },
    profile: { from: msBetween(startNs, from), to: msBetween(startNs, to) },
  };
};

const trimmed = (n: number) => Number(n.toFixed(1)).toString();

/** "60–700 ms", "1.2–3.4 s": both ends in one unit. */
export const rangeLabel = ({ from, to }: MsRange): string =>
  to < 1000
    ? `${Math.round(from)}–${Math.round(to)} ms`
    : `${trimmed(from / 1000)}–${trimmed(to / 1000)} s`;
