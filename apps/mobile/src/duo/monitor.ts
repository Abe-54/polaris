/**
 * The half-folded Duo idle as a monitor (Paper MX-AF, after D8): agent sessions as their
 * celestials standing on the horizon above the fold, needs you items below it. Pure; `Monitor`
 * draws it.
 */
import type { ApprovalRequest, CelestialBody, HarnessKind } from "@polaris/protocol";
import { leadStar, sessionCelestial } from "@polaris/ui/celestial";
import { Match } from "effect";
import { grouped } from "../home/model/format.ts";
import type { Home, HomeRow, SessionRow } from "../home/model/home.ts";

export type StarTone = "needs-you" | "working";

/** One celestial on the horizon: needs you reads by its amber label, never a halo. */
export interface Star {
  readonly key: string;
  readonly label: string;
  readonly tone: StarTone;
  readonly body: CelestialBody;
  readonly harness: HarnessKind | null;
  /** A lead's star is drawn smaller and labelled with its task count. */
  readonly lead: { readonly hostId: string; readonly constellationId: string } | null;
  readonly working: boolean;
  /** Its centre, 0–1 across the sky. */
  readonly x: number;
}

/** The longest label that still fits its slot on the horizon. */
const LABEL_LIMIT = 18;

/** "Polaris planning" → "polaris-planning", as MX-AF labels its celestials. */
export const starLabel = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug === "") return "untitled";

  return slug.length > LABEL_LIMIT ? `${slug.slice(0, LABEL_LIMIT - 1)}…` : slug;
};

/** Each celestial's slot on the horizon is this wide at least, so labels never collide. */
export const STAR_SLOT = 120;

/** How many celestials fit a sky this wide; the rest of a busy night stays on Home. */
export const starLimit = (width: number): number => Math.max(1, Math.floor(width / STAR_SLOT));

const starOf = (row: HomeRow, tone: StarTone) =>
  row.kind === "session"
    ? {
        key: row.key,
        label: starLabel(row.session.title),
        tone,
        body: sessionCelestial(row.session.celestial),
        harness: row.session.harness,
        lead: null,
        working: row.session.state === "working",
      }
    : {
        key: row.key,
        label: starLabel(row.constellation.name),
        tone,
        body: leadStar(row.lead?.celestial),
        harness: row.lead?.harness ?? null,
        lead: { hostId: row.hostId, constellationId: String(row.constellation.id) },
        working: row.lead?.state === "working",
      };

/** Needs you first, then working, spaced evenly along the horizon. */
export const starsOf = (home: Home, limit: number): ReadonlyArray<Star> => {
  const lit = [
    ...home.sections.needsYou.map((row) => starOf(row, "needs-you")),
    ...home.sections.working.map((row) => starOf(row, "working")),
  ].slice(0, Math.max(0, limit));

  return lit.map((star, index) => ({ ...star, x: (index + 0.5) / lit.length }));
};

/** "3 working · 2 need you"; empty when nothing is going on. */
export const skyLine = (home: Home) => ({
  working: home.working === 0 ? "" : `${home.working} working`,
  needsYou: home.needsYou === 0 ? "" : `${home.needsYou} need${home.needsYou === 1 ? "s" : ""} you`,
});

/** Night is 22:00 to 6:00 on this iPhone: the targets dim, as the Duo stands on a nightstand. */
export const isNight = (hour: number): boolean => hour >= 22 || hour < 6;

/** The targets below the fold: needs you rows that can be answered here. */
export const targetsOf = (home: Home, limit: number): ReadonlyArray<SessionRow> =>
  home.sections.needsYou.filter((row) => row.approval !== null).slice(0, limit);

/** Under the targets when more need you than fit: the rest wait on Home. */
export const moreLine = (more: number): string => `${grouped(more)} more on Home`;

/** The verb before a permission's command in its well ("Wants to run cargo build"). */
export const wantsLine = (kind: Exclude<ApprovalRequest["kind"], "question" | "secret">): string =>
  Match.value(kind).pipe(
    Match.when("command", () => "Wants to run"),
    Match.when("file-change", () => "Wants to change"),
    Match.when("tool", () => "Wants to use"),
    Match.when("app", () => "Wants to use"),
    Match.when("headed-input", () => "Wants headed input in"),
    Match.exhaustive
  );

/** The detail after "Wants to run": the verb already says it's a command, so no "$ ". */
export const wantsDetail = (text: string): string => text.replace(/^\$ /, "");
