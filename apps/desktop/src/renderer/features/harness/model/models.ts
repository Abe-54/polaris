/**
 * The Model and effort picker over `harness.models`. Claude Code lists a
 * `default` row meaning "whatever Claude Code picks"; the picker hides it and
 * shows a session whose Model is null as "Default" instead. A Model that takes
 * effort is always sent a concrete one.
 */
import type { Model } from "@polaris/protocol";
import type { Plain } from "../../../../shared/api.ts";

export type ModelData = Plain<Model>;

export interface ModelChoice {
  readonly model: string | null;
  /** Always concrete when the Model takes effort: the pick, else its default. */
  readonly effort: string | null;
  readonly serviceTier?: "default" | "priority" | null;
}

const CLAUDE_DEFAULT_ROW = "default";

/** What Polaris sends when a Harness doesn't say a Model's default effort. */
export const FALLBACK_EFFORT = "medium";

/** The rows the picker offers for a Harness. */
export const pickableModels = (
  harness: string,
  models: ReadonlyArray<ModelData>
): ReadonlyArray<ModelData> =>
  harness === "claude" ? models.filter((m) => m.id !== CLAUDE_DEFAULT_ROW) : models;

/** How many Models the picker shows before "More models". */
export const SHORTLIST = 4;

export interface Lineage {
  /** "opus", "gpt sol": the name without its version. */
  readonly family: string;
  /** [5, 5] for "Opus 5.5"; null when the name carries none. */
  readonly version: readonly number[] | null;
}

/** A Model's family and version, read from its name as the Harness shows it. */
export const lineage = (name: string): Lineage => {
  const match = /\d+(?:\.\d+)*/.exec(name);

  const family = name
    .replace(match?.[0] ?? "", " ")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();

  return { family, version: match === null ? null : match[0].split(".").map(Number) };
};

/** Whether version `a` is newer than `b` ([5, 5] over [5] over [4, 8]). */
const newer = (a: readonly number[] | null, b: readonly number[] | null): boolean => {
  if (a === null || b === null) return a !== null && b === null;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);

    if (d !== 0) return d > 0;
  }

  return false;
};

const sameVersion = (a: readonly number[] | null, b: readonly number[] | null) =>
  !newer(a, b) && !newer(b, a);

/** Whether a newer Model of the same family is listed, or the same one is listed earlier. */
const superseded = (lines: ReadonlyArray<Lineage>, i: number): boolean => {
  const self = lines[i];

  return lines.some(
    (other, j) =>
      j !== i &&
      self !== undefined &&
      other.family === self.family &&
      (newer(other.version, self.version) || (j < i && sameVersion(other.version, self.version)))
  );
};

export interface Shortlist {
  /** The newest Model of each family, in the Harness's order, at most SHORTLIST. */
  readonly top: ReadonlyArray<ModelData>;
  /** Everything else the Harness lists, in its order. */
  readonly more: ReadonlyArray<ModelData>;
}

/**
 * The picker's Models: a Model a newer one of its family supersedes moves to "More models", and
 * the first four left, in the Harness's own order, are shown. The Harness's default always is.
 */
export const shortlist = (harness: string, models: ReadonlyArray<ModelData>): Shortlist => {
  const pickable = pickableModels(harness, models);
  const lines = pickable.map((m) => lineage(m.name));
  const newest = pickable.filter((_, i) => !superseded(lines, i));
  const top = newest.slice(0, SHORTLIST);
  const fallback = pickable.find((m) => m.isDefault);

  if (fallback !== undefined && !top.includes(fallback)) top.splice(SHORTLIST - 1, 1, fallback);

  return { top, more: pickable.filter((m) => !top.includes(m)) };
};

/** The effort a Model runs with when none is picked: its default, else medium, else its first. */
export const defaultEffort = (model: ModelData): string | null => {
  if (model.defaultEffort !== null) return model.defaultEffort;

  if (model.efforts.includes(FALLBACK_EFFORT)) return FALLBACK_EFFORT;

  return model.efforts[0] ?? null;
};

/** The effort to send with a Model: the chosen one if it supports it, else its default. */
export const effortFor = (model: ModelData, chosen: string | null): string | null => {
  if (chosen !== null && model.efforts.includes(chosen)) return chosen;

  return defaultEffort(model);
};

/** Said beside the efforts when the Harness gave no default and Polaris picked one. */
export const effortNote = (harnessName: string, model: ModelData): string | null => {
  const picked = defaultEffort(model);

  if (model.defaultEffort !== null || picked === null) return null;

  return `${harnessName} doesn't say ${model.name}'s default effort; Polaris sends ${picked}.`;
};

export const choose = (model: ModelData, chosen: string | null = null): ModelChoice => ({
  model: model.id,
  effort: effortFor(model, chosen),
});

/** A Model id's lineage: "claude-opus-5-5" is family "claude opus", version [5, 5]. */
const idLineage = (id: string): Lineage => {
  const parts = id
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p !== "");

  // An 8-digit part is a snapshot date ("claude-opus-4-1-20250805"), not a version.
  const numbers = parts.filter((p) => /^\d{1,4}$/.test(p)).map(Number);
  const words = parts.filter((p) => /^[a-z]+$/.test(p));

  return { family: words.join(" "), version: numbers.length === 0 ? null : numbers };
};

const rowLineage = (m: ModelData): Lineage => {
  const named = lineage(m.name);

  return named.version === null ? { ...named, version: idLineage(m.id).version } : named;
};

const sameFamily = (id: string, row: string) => id === row || id.endsWith(` ${row}`);

/**
 * The listed row for a saved Model: its id, else the one row of its lineage, so a full id
 * ("claude-opus-5-5") finds the alias the Harness lists ("opus", named "Opus 5.5").
 */
export const findModel = (
  models: ReadonlyArray<ModelData>,
  model: string | null
): ModelData | undefined => {
  if (model === null) return undefined;
  const exact = models.find((m) => m.id === model);

  if (exact !== undefined) return exact;
  const want = idLineage(model);

  if (want.family === "") return undefined;
  const kin = models.filter((m) => sameFamily(want.family, rowLineage(m).family));
  const same = kin.filter((m) => sameVersion(rowLineage(m).version, want.version));

  if (same.length === 1) return same[0];
  const unversioned = kin.filter((m) => rowLineage(m).version === null);

  return same.length === 0 && unversioned.length === 1 ? unversioned[0] : undefined;
};

const nameOf = (models: ReadonlyArray<ModelData>, model: string | null) => {
  if (model === null || model === CLAUDE_DEFAULT_ROW) return "Default";

  return findModel(models, model)?.name ?? model;
};

/** The label for a Model and effort, as the Harness names them ("Opus 5 · high"). */
export const modelLabel = (
  models: ReadonlyArray<ModelData>,
  model: string | null,
  effort: string | null
): string => {
  const name = nameOf(models, model);

  return effort === null ? name : `${name} · ${effort}`;
};

/** The Model a new session starts on when the user doesn't pick: the Harness's default row. */
export const defaultChoice = (
  harness: string,
  models: ReadonlyArray<ModelData>
): ModelChoice | null => {
  if (harness === "claude") return null;
  const model = models.find((m) => m.isDefault) ?? models[0];

  return model === undefined ? null : choose(model);
};

export type ModelChange =
  /** `SetModel` for the next Turns. */
  | { readonly kind: "set" }
  /** The Harness can't switch mid-session: a Fork on the new Model. */
  | { readonly kind: "fork" }
  /** Nothing can change now; `reason` says why. */
  | { readonly kind: "blocked"; readonly reason: string };

export interface ChangeContext {
  /** The Harness reports it can switch Model mid-session (`switchesModel`). */
  readonly switchesModel: boolean;
  /** The Daemon has `session.set-model`. */
  readonly canSetModel: boolean;
  readonly canFork: boolean;
  /** A Turn is in flight: `SetModel` waits until it ends. */
  readonly turnInFlight: boolean;
  /** A finished Turn exists to fork from. */
  readonly hasFinishedTurn: boolean;
}

/** How picking another Model in a session takes effect. */
export const modelChange = (ctx: ChangeContext): ModelChange => {
  if (ctx.switchesModel && ctx.canSetModel) {
    return ctx.turnInFlight
      ? { kind: "blocked", reason: "Switch Model once this turn ends" }
      : { kind: "set" };
  }

  if (ctx.canFork && ctx.hasFinishedTurn) return { kind: "fork" };

  return { kind: "blocked", reason: "This harness can't switch model in a session yet" };
};
