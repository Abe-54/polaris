/**
 * What a session row shows (Paper MX-I) as data: its meta line in two parts, without the Harness
 * name, and how its celestial looks in each Session State.
 */
import type { SessionState } from "@polaris/protocol";
import { Match } from "effect";
import type { MobileColours } from "../../theme/index.ts";
import type { SessionRow } from "../model/home.ts";
import { approvalDetail, askLine, hasUnreviewedTurns, quickQuestion } from "../model/lines.ts";

/** `default` is a done row's state word: text-default, not a signal. */
export type MetaTone = "needs-you" | "failed" | "default";

export interface MetaLine {
  /** The state word in its colour ("Wants to run a command", "Failed"); null for a plain line. */
  readonly lead: { readonly text: string; readonly tone: MetaTone } | null;
  /** The rest, subtle, joined with " · ". */
  readonly rest: string;
}

const join = (...parts: ReadonlyArray<string | null | undefined>) =>
  parts.filter((part): part is string => part != null && part !== "").join(" · ");

const firstLine = (text: string | null | undefined): string | null =>
  text
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "") ?? null;

const turnWord = (row: SessionRow): string | null => {
  const { session } = row;

  return session.turnCount > 0
    ? `turn ${session.currentUserTurn?.number ?? session.turnCount}`
    : null;
};

const needsYouLine = (row: SessionRow, host: string | null): MetaLine => {
  const { approval } = row;

  if (approval === null)
    return { lead: { text: "Needs you", tone: "needs-you" }, rest: join(turnWord(row), host) };

  const what = Match.value(approval.kind).pipe(
    Match.when("question", () => quickQuestion(approval)?.text ?? approval.title),
    // A Secret Request's title is the agent's label; its detail is the reason.
    Match.when("secret", () => approval.title),
    Match.orElse(() => firstLine(approvalDetail(approval, row.session.cwd)?.text))
  );

  return {
    lead: { text: askLine(approval), tone: "needs-you" },
    rest: join(firstLine(what), host),
  };
};

const plain = (rest: string): MetaLine => ({ lead: null, rest });

/** The line under a row's title; `withHost` adds the Host when there are several. */
export const metaLine = (row: SessionRow, withHost: boolean): MetaLine => {
  const { session } = row;
  const host = withHost ? row.hostName : null;
  const turn = turnWord(row);

  if (row.approval !== null || session.state === "needs-you") return needsYouLine(row, host);

  switch (session.state) {
    case "failed":
      return {
        lead: { text: "Failed", tone: "failed" },
        rest: join(firstLine(session.lastError), host),
      };
    case "starting":
    case "working":
      return plain(join(firstLine(row.replyPreview) ?? "Working", turn, host));
    case "limited":
      return plain(join("At its usage limit", host));
    case "in-terminal":
      return plain(join("In the terminal", turn, host));
    case "dormant":
      return plain(join("Dormant", "resumes on reply", host));
    default:
      return {
        lead: {
          text: hasUnreviewedTurns(session) ? "Ready to review" : "Idle",
          tone: "default",
        },
        rest: join(turn, host),
      };
  }
};

export interface CelestialLook {
  /** Working animates inside the body and lays the dither wash on the row. */
  readonly working: boolean;
  /** Dormant and archived bodies draw at 45% (MX-I). */
  readonly dormant: boolean;
}

export const celestialLook = (state: SessionState): CelestialLook => ({
  working: state === "working",
  dormant: state === "dormant" || state === "archived",
});

const HUES: ReadonlyMap<string, keyof MobileColours> = new Map([
  ["claude", "harnessClaudeCode"],
  ["codex", "harnessCodex"],
  ["opencode", "harnessOpencode"],
]);

/** A Harness's hue in the theme; an unknown kind is neutral. */
export const harnessHue = (colours: MobileColours, harness: string): string =>
  colours[HUES.get(harness) ?? "textSubtle"];

/** The header badge's count, capped as "99+". */
export const badgeCount = (count: number): string => (count > 99 ? "99+" : String(count));
