/**
 * What Review on iPhone shows of a Risk Summary (Paper M5; DESIGN.md Review): which findings stay
 * listed, the four-cell tally, each file's badges, and whether Accept is paused.
 */
import {
  FindingSource,
  type RiskFinding,
  type RiskSummary,
  SEVERITY_RANK,
  type Severity,
} from "@polaris/protocol";
import type { Loaded } from "./useReview.ts";

export const SEVERITIES: ReadonlyArray<Severity> = ["critical", "high", "medium", "low"];

/**
 * Open findings, and a dismissed Critical: no verdict or Risk Memory rule hides one. A resolved
 * finding is gone, whatever its severity.
 */
export const isListed = (finding: RiskFinding): boolean =>
  finding.status === "open" || (finding.status === "dismissed" && finding.severity === "critical");

/** A dismissed Critical stays listed, folded with a "dismissed" note, out of every tally. */
export const isDismissed = (finding: RiskFinding): boolean => finding.status === "dismissed";

/**
 * Ranked as the protocol's `rankFindings`, which uses `toSorted`: Hermes lacks it. Dismissed
 * findings follow the open ones.
 */
export const listedFindings = (findings: ReadonlyArray<RiskFinding>): ReadonlyArray<RiskFinding> =>
  findings
    .filter(isListed)
    .sort(
      (a, b) =>
        Number(isDismissed(a)) - Number(isDismissed(b)) ||
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.confidence - a.confidence ||
        FindingSource.literals.indexOf(a.source) - FindingSource.literals.indexOf(b.source)
    );

/** Non-Critical findings under 50% confidence are dimmed; a Critical one never is. */
export const isDimmed = (finding: RiskFinding): boolean =>
  finding.severity !== "critical" && finding.confidence < 0.5;

export type Tally = Readonly<Record<Severity, number>>;

/** Open findings by severity: a dismissed one is listed but not counted. */
export const tally = (findings: ReadonlyArray<RiskFinding>): Tally => {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const finding of findings) if (finding.status === "open") counts[finding.severity] += 1;

  return counts;
};

/** A file's distinct severities among its open findings, the most severe first. */
export const fileSeverities = (
  findings: ReadonlyArray<RiskFinding>,
  path: string
): ReadonlyArray<Severity> =>
  SEVERITIES.filter((severity) =>
    findings.some((f) => f.path === path && f.severity === severity && f.status === "open")
  );

/** The most severe of `severities`, or null. */
export const highest = (severities: ReadonlyArray<Severity>): Severity | null =>
  [...severities].sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0] ?? null;

export type AcceptState =
  | { readonly kind: "ready" }
  /** Ready, but open Critical findings (a dismissed one doesn't count) ask first (MX-T). */
  | { readonly kind: "paused"; readonly critical: number }
  /** The risk summary is loading or still reading, so a Critical may yet arrive. */
  | { readonly kind: "checking" }
  /** No risk summary: it couldn't load, or it failed. */
  | { readonly kind: "unchecked"; readonly reason: string }
  | { readonly kind: "working" }
  | { readonly kind: "accepted" }
  | { readonly kind: "sending" };

export interface AcceptInput {
  readonly risk: Loaded<RiskSummary>;
  readonly turnEnded: boolean;
  readonly accepted: boolean;
  readonly sending: boolean;
}

/** Accept waits until the reviewed Turn's risk summary has finished; open Criticals then ask first. */
export const acceptState = (input: AcceptInput): AcceptState => {
  if (input.accepted) return { kind: "accepted" };
  const { risk } = input;
  const findings = risk.kind === "ready" ? risk.value.findings : [];

  if (!input.turnEnded) return { kind: "working" };

  if (risk.kind === "loading") return { kind: "checking" };

  if (risk.kind === "failed") return { kind: "unchecked", reason: risk.message };

  if (risk.value.status === "running") return { kind: "checking" };

  if (risk.value.status === "failed")
    return { kind: "unchecked", reason: risk.value.note ?? "The risk summary failed" };

  if (input.sending) return { kind: "sending" };

  const critical = findings.filter((f) => f.severity === "critical" && f.status === "open").length;

  return critical > 0 ? { kind: "paused", critical } : { kind: "ready" };
};
