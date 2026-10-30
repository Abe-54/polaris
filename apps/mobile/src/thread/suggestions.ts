/**
 * Suggested chips above the composer: only actions the session's state
 * already implies (DESIGN.md, Mobile App, Suggested actions), never generated
 * prompts. "Fix the critical finding" while a Critical finding is open;
 * "Open review" once the latest Turn finished.
 */
import type { RiskFinding, SessionState, TurnStatus } from "@polaris/protocol";
import type { Route } from "../app/route.ts";

export type Suggestion =
  | { readonly kind: "fix"; readonly label: string; readonly finding: RiskFinding }
  | { readonly kind: "review"; readonly label: string };

export interface SuggestionContext {
  readonly state: SessionState;
  readonly lastTurn: TurnStatus | null;
  readonly findings: ReadonlyArray<RiskFinding>;
}

/** The first open Critical finding, the one the thread shows inline. */
export const openCritical = (findings: ReadonlyArray<RiskFinding>): RiskFinding | null =>
  findings.find((f) => f.severity === "critical" && f.status === "open") ?? null;

export const suggestions = (ctx: SuggestionContext): ReadonlyArray<Suggestion> => {
  const critical = openCritical(ctx.findings);
  const finished = ctx.lastTurn === "completed" && ctx.state !== "working";

  return [
    ...(critical === null
      ? []
      : [{ kind: "fix", label: "Fix the critical finding", finding: critical } as const]),
    ...(finished ? [{ kind: "review", label: "Open review" } as const] : []),
  ];
};

/** The header's Review button: there's an ended Turn to review, even while the next one runs. */
export const canReview = (turns: ReadonlyArray<TurnStatus>): boolean =>
  turns.some((status) => status !== "working");

/** What "Fix the critical finding" puts in the composer, for the user to send. */
export const fixPrompt = (finding: RiskFinding): string =>
  `Fix the critical finding "${finding.title}" at ${finding.path}:${finding.lines.start}.`;

/** What a chip does: open a screen, or fill the composer for the user to send. */
export type ChipAction =
  | { readonly kind: "open"; readonly route: Route }
  | { readonly kind: "fill"; readonly text: string };

/** "Open review" opens the session's Review at its latest ended Turn. */
export const chipAction = (chip: Suggestion, hostId: string, sessionId: string): ChipAction =>
  chip.kind === "review"
    ? { kind: "open", route: { screen: "review", hostId, sessionId, turnId: null } }
    : { kind: "fill", text: fixPrompt(chip.finding) };
