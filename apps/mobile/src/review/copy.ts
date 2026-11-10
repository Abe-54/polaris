/** Review's words on iPhone (Paper M5), kept in one place so the model tests can read them. */
import type { RiskFinding, RiskSummary, VerdictReason } from "@polaris/protocol";
import type { AcceptState } from "./model.ts";

const SOURCE: Readonly<Record<RiskFinding["source"], string>> = {
  rule: "Rule",
  classifier: "Classifier",
  agent: "Reviewer",
};

/** "Rule · 97%". */
export const findingMeta = (finding: RiskFinding): string =>
  `${SOURCE[finding.source]} · ${Math.round(finding.confidence * 100)}%`;

/** ENG-225's fixed reasons; "Other" needs a note, which the phone doesn't take yet. */
export const VERDICT_REASONS: ReadonlyArray<{
  readonly reason: VerdictReason;
  readonly label: string;
}> = [
  { reason: "false-positive", label: "False positive" },
  { reason: "not-important", label: "Not important" },
  { reason: "intended", label: "Intended" },
  { reason: "already-handled", label: "Already handled" },
  { reason: "wrong-severity", label: "Wrong severity" },
  { reason: "out-of-scope", label: "Out of scope" },
];

/** `withTurn` false at accessibility sizes: Accept drops the number, which the header names. */
export const acceptLabel = (state: AcceptState, turnNumber: number, withTurn = true): string => {
  switch (state.kind) {
    case "checking":
      return "Accept waits for the risk summary";
    case "unchecked":
      return "Accept needs a risk summary";
    case "working":
      return `Turn ${turnNumber} is still working`;
    case "accepted":
      return `Turn ${turnNumber} accepted`;
    case "sending":
      return "Accepting…";
    case "ready":
    case "paused":
      return withTurn ? `Accept turn ${turnNumber}` : "Accept";
  }
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const ago = (iso: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));

  if (minutes < 1) return "just now";

  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);

  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

/** The risk summary's caption: "Read 3 files at 9be04d · 1m ago". */
export const summaryCaption = (summary: RiskSummary | null, files: number, now: number): string => {
  if (summary === null) return `Reading ${plural(files, "file")}…`;

  const head = summary.key.head.slice(0, 6);

  if (summary.status === "running") return `Reading ${plural(files, "file")} at ${head}…`;

  if (summary.status === "failed") return summary.note ?? "The risk summary failed";

  return `Read ${plural(files, "file")} at ${head} · ${ago(summary.endedAt ?? summary.startedAt, now)}`;
};
