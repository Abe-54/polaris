/**
 * Settings → Reviewer as data (Paper S7; ENG-222): the Reviewer every Host runs (its
 * settings live on each Host, so the page writes them to all), each Host's readiness for
 * it, and the Workspace overrides. Null means automatic: the first of `AUTO_CHAIN` that is
 * ready on the Host, else rules only.
 */
import { AUTO_REVIEWERS, HARNESS_CATALOGUE } from "@polaris/protocol";
import type { Plain } from "../../../../shared/api.ts";
import type { ReviewerChoice, ReviewerSettings, ResolvedReviewer } from "@polaris/protocol";
import type { HostRow, ProbedHost } from "./harnesses.ts";
import { harnessGroups } from "./harnesses.ts";

export type Choice = Plain<ReviewerChoice>;

export type Settings = Plain<ReviewerSettings>;

export type Resolved = Plain<ResolvedReviewer>;

/** The user's own choice (ENG-222), one click away. */
export const SOL: Choice = { harness: "codex", model: "gpt-6.1-sol", effort: "high" };

/** What Settings knows of one Host's Reviewer. */
export type HostReviewer =
  | { readonly kind: "loading" }
  /** Offline, or its Daemon predates `review.reviewer-settings`. */
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "loaded"; readonly settings: Settings; readonly resolved: Resolved };

export const sameChoice = (a: Choice | null, b: Choice | null) =>
  a === null || b === null
    ? a === b
    : a.harness === b.harness && a.model === b.model && a.effort === b.effort;

export interface SharedDefault {
  readonly choice: Choice | null;
  readonly differs: boolean;
}

/** The default the page shows: the first loaded Host's; `differs` when another Host disagrees. */
export const sharedDefault = (hosts: ReadonlyArray<HostReviewer>): SharedDefault => {
  const loaded = hosts.flatMap((h) => (h.kind === "loaded" ? [h.settings.default] : []));
  const [first = null] = loaded;

  return { choice: first, differs: loaded.some((c) => !sameChoice(c, first)) };
};

export const harnessName = (kind: string) =>
  HARNESS_CATALOGUE.find((h) => h.kind === kind)?.name ?? kind;

const capitalised = (part: string) =>
  part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1);

/** "claude-opus-5-5-20260101" → "Opus 5.5": Claude Code lists aliases, so full ids never match. */
const claudeName = (rest: string) => {
  const parts = rest.split("-").filter((p) => !/^\d{8}$/.test(p));
  const words = parts.filter((p) => !/^\d+$/.test(p)).map(capitalised);
  const version = parts.filter((p) => /^\d+$/.test(p)).join(".");

  return [...words, version].filter((p) => p !== "").join(" ");
};

/** A Model id as a name until the Harness lists it: "gpt-6.1-sol" → "GPT-6.1-Sol". */
export const prettyModel = (id: string) =>
  id.startsWith("claude-")
    ? claudeName(id.slice("claude-".length))
    : id.split("-").map(capitalised).join("-");

/** "high" → "High", as Paper names efforts. */
export const effortLabel = (effort: string) => effort.charAt(0).toUpperCase() + effort.slice(1);

/** "Claude Code · Opus 5 · High". */
export const choiceLabel = (choice: Choice, modelName: (id: string) => string = prettyModel) =>
  [
    harnessName(choice.harness),
    choice.model === null ? null : modelName(choice.model),
    choice.effort === null ? null : effortLabel(choice.effort),
  ]
    .filter((part) => part !== null)
    .join(" · ");

/** The card's heading. */
export const reviewerTitle = (choice: Choice | null, modelName?: (id: string) => string) =>
  choice === null
    ? "Picks a reviewer automatically"
    : `Reviews with ${choiceLabel(choice, modelName)}`;

/** What automatic tries, best first, on each Host; rules only when none is ready there. */
export const AUTO_CHAIN: ReadonlyArray<Choice> = AUTO_REVIEWERS.map((choice) => ({
  harness: choice.harness,
  model: choice.model,
  effort: choice.effort,
}));

/** A link of the automatic chain: "Claude Code · Opus 5.5 high". */
export const chainLabel = (choice: Choice, modelName: (id: string) => string = prettyModel) =>
  [
    harnessName(choice.harness),
    [choice.model === null ? null : modelName(choice.model), choice.effort]
      .filter((part) => part !== null)
      .join(" "),
  ]
    .filter((part) => part !== "")
    .join(" · ");

export interface ReviewerHostRow {
  readonly hostKey: string;
  readonly hostLabel: string;
  /** The Harness its Reviews would run; null: none, rules only. */
  readonly harness: string | null;
  /** The Harness's availability there, as Settings → Harnesses says it. */
  readonly row: HostRow | null;
  readonly text: string;
  /** "Risk summaries for checkouts here run rules only" when it can't run. */
  readonly caption: string | null;
  /** "3 review checkouts" / "No checkouts". */
  readonly aside: string;
}

const RULES_ONLY = "Risk summaries for checkouts here run rules only";

const checkoutsText = (n: number) =>
  n === 0 ? "No checkouts" : `${n} review checkout${n === 1 ? "" : "s"}`;

const harnessHere = (reviewer: HostReviewer): string | null => {
  if (reviewer.kind !== "loaded") return null;

  return reviewer.settings.default?.harness ?? reviewer.resolved.choice?.harness ?? null;
};

const unavailableRow = (host: ProbedHost, text: string, aside: string): ReviewerHostRow => ({
  hostKey: host.hostKey,
  hostLabel: host.label,
  harness: null,
  row: null,
  text,
  caption: null,
  aside,
});

/** One row per Host: whether its Reviewer can run there, and its Review Checkouts. */
export const reviewerHostRows = (
  hosts: ReadonlyArray<ProbedHost>,
  reviewers: Readonly<Record<string, HostReviewer>>,
  checkouts: Readonly<Record<string, number>>
): ReadonlyArray<ReviewerHostRow> => {
  const groups = harnessGroups(hosts);

  return hosts.map((host) => {
    const reviewer = reviewers[host.hostKey] ?? { kind: "loading" };
    const aside = checkoutsText(checkouts[host.hostKey] ?? 0);

    if (reviewer.kind === "loading") return unavailableRow(host, "Checking…", aside);

    if (reviewer.kind === "unavailable") return unavailableRow(host, reviewer.reason, aside);

    const harness = harnessHere(reviewer);

    const row =
      groups.find((g) => g.kind === harness)?.rows.find((r) => r.hostKey === host.hostKey) ?? null;

    if (harness === null || row === null) {
      return {
        ...unavailableRow(host, "No reviewer here", aside),
        caption: reviewer.resolved.note ?? RULES_ONLY,
      };
    }

    return {
      hostKey: host.hostKey,
      hostLabel: host.label,
      harness,
      row,
      text: row.text,
      caption: row.ready || row.checking ? null : RULES_ONLY,
      aside,
    };
  });
};

/** "Ready on 2 of 4 hosts", as Settings → Harnesses counts. */
export const readySummary = (rows: ReadonlyArray<ReviewerHostRow>) => {
  const ready = rows.filter((r) => r.row?.ready === true).length;

  if (rows.length === 0) return "No hosts yet";

  if (ready === rows.length)
    return rows.length === 1 ? "Ready on its host" : `Ready on all ${rows.length} hosts`;

  return ready === 0 ? "Not ready on any host" : `Ready on ${ready} of ${rows.length} hosts`;
};

/** A Host's settings with a new default, its overrides kept. */
export const withDefault = (settings: Settings, choice: Choice | null): Settings => ({
  ...settings,
  default: choice,
});

/** A Host's settings with a Workspace's override set, or cleared with null. */
export const withOverride = (
  settings: Settings,
  workspaceId: string,
  choice: Choice | null
): Settings => ({
  ...settings,
  workspaces: Object.fromEntries([
    ...Object.entries(settings.workspaces).filter(([id]) => id !== workspaceId),
    ...(choice === null ? [] : [[workspaceId, choice] as const]),
  ]),
});

/** Every override on every loaded Host, keyed `hostKey/workspaceId`. */
export const overridesOf = (
  reviewers: Readonly<Record<string, HostReviewer>>
): Readonly<Record<string, Choice>> =>
  Object.fromEntries(
    Object.entries(reviewers).flatMap(([hostKey, r]) =>
      r.kind === "loaded"
        ? Object.entries(r.settings.workspaces).map(
            ([id, choice]) => [`${hostKey}/${id}`, choice] as const
          )
        : []
    )
  );

/** "When it runs" (Paper S7): host-wide, written to every Host like the default. */
export interface RunPolicy {
  readonly onPullRequests: boolean;
  readonly onSessions: boolean;
  /** Ask first above this many changed lines; null never asks. */
  readonly askAboveLines: number | null;
}

export const DEFAULT_POLICY: RunPolicy = {
  onPullRequests: true,
  onSessions: true,
  askAboveLines: 2000,
};

/** The first loaded Host's policy, as `sharedDefault` does for the Reviewer. */
export const sharedPolicy = (hosts: ReadonlyArray<HostReviewer>): RunPolicy => {
  const first = hosts.find((h) => h.kind === "loaded");

  return first?.kind === "loaded"
    ? {
        onPullRequests: first.settings.onPullRequests,
        onSessions: first.settings.onSessions,
        askAboveLines: first.settings.askAboveLines,
      }
    : DEFAULT_POLICY;
};

export const withPolicy = (settings: Settings, patch: Partial<RunPolicy>): Settings => ({
  ...settings,
  ...patch,
});

/** The "Ask first for large changes" choices; null never asks. */
export const THRESHOLDS: ReadonlyArray<number | null> = [500, 1000, 2000, 5000, 10_000, null];

export const thresholdLabel = (lines: number | null) =>
  lines === null ? "Never" : `Over ${lines.toLocaleString("en-US")} lines`;

/** The walkthrough (OVERVIEW.md): on unless switched off; the reviewer's model unless set. */
export interface WalkthroughPrefs {
  readonly enabled: boolean;
  /** Null: the same Harness, Model and Effort as the reviewer. */
  readonly choice: Choice | null;
}

const prefsOf = (settings: Settings): WalkthroughPrefs => {
  const w = settings.walkthrough;

  return {
    enabled: w?.enabled ?? true,
    choice:
      w === undefined || w.harness === null
        ? null
        : { harness: w.harness, model: w.model, effort: w.effort },
  };
};

/** The first loaded Host's, as `sharedPolicy` does. */
export const sharedWalkthrough = (hosts: ReadonlyArray<HostReviewer>): WalkthroughPrefs => {
  const first = hosts.find((h) => h.kind === "loaded");

  return first?.kind === "loaded" ? prefsOf(first.settings) : { enabled: true, choice: null };
};

export const withWalkthrough = (settings: Settings, patch: Partial<WalkthroughPrefs>): Settings => {
  const next = { ...prefsOf(settings), ...patch };

  return {
    ...settings,
    walkthrough: {
      enabled: next.enabled,
      harness: next.choice?.harness ?? null,
      model: next.choice?.model ?? null,
      effort: next.choice?.effort ?? null,
    },
  };
};
