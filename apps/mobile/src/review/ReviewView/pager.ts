/**
 * The severity pager (Paper MX-O's tinted pills on MX-N's readout): each severity's open
 * findings in the order Review shows them, and where a tap on its pill goes next.
 */
import type { RiskFinding, Severity } from "@polaris/protocol";
import { SEVERITIES } from "../model.ts";

/** The finding each severity's pill last moved to, as an index into that severity's findings. */
export type PagerPositions = Readonly<Record<Severity, number | null>>;

export const NO_POSITIONS: PagerPositions = { critical: null, high: null, medium: null, low: null };

export const ofSeverity = (
  findings: ReadonlyArray<RiskFinding>,
  severity: Severity
): ReadonlyArray<RiskFinding> =>
  findings.filter((f) => f.severity === severity && f.status === "open");

/** The next finding of `severity` after the last one visited, cycling; null when it has none. */
export const pageTo = (
  findings: ReadonlyArray<RiskFinding>,
  positions: PagerPositions,
  severity: Severity
): { readonly finding: RiskFinding; readonly positions: PagerPositions } | null => {
  const list = ofSeverity(findings, severity);

  if (list.length === 0) return null;
  const last = positions[severity];
  const index = last === null || last + 1 >= list.length ? 0 : last + 1;
  const finding = list[index];

  return finding === undefined ? null : { finding, positions: { ...positions, [severity]: index } };
};

/** "2", or "1/2" once the pill has paged to one of them. */
export const pillCount = (count: number, position: number | null): string =>
  position === null || position >= count ? `${count}` : `${position + 1}/${count}`;

/** Positions kept only where they still point inside their severity's findings. */
export const keepPositions = (
  findings: ReadonlyArray<RiskFinding>,
  positions: PagerPositions
): PagerPositions => {
  const kept = { ...NO_POSITIONS };

  for (const severity of SEVERITIES) {
    const at = positions[severity];
    kept[severity] = at !== null && at < ofSeverity(findings, severity).length ? at : null;
  }

  return kept;
};
