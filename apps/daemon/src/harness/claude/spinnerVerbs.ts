/**
 * Claude Code's `spinnerVerbs` setting, for `harness.spinnerVerbs`: read-only
 * from the user's and the project's settings files, in Claude Code's order
 * (user < project < project local). Each file is parsed again only when its
 * mtime or size changes; nothing watches or polls, so an idle Daemon stays idle.
 */
import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SpinnerVerbs } from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";

/** What one settings file says, when it sets `spinnerVerbs`. */
export interface Setting {
  readonly mode: "replace" | "append";
  readonly verbs: ReadonlyArray<string>;
}

const MAX_VERBS = 100;

const MAX_LENGTH = 80;

/** Only the key Polaris reads; every other setting is left alone. */
const SettingsFile = Schema.Struct({
  spinnerVerbs: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(Schema.String),
      verbs: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    })
  ),
});

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(SettingsFile));

const CONTROL = /\p{Cc}/gu;

const isString = Schema.is(Schema.String);

/** Strings only, one line each, trimmed, capped; blanks dropped. */
const clean = (verbs: ReadonlyArray<unknown>) =>
  verbs
    .flatMap((v) => {
      const verb = isString(v)
        ? Array.from(v.replace(CONTROL, " ").trim()).slice(0, MAX_LENGTH)
        : [];

      return verb.length === 0 ? [] : [verb.join("")];
    })
    .slice(0, MAX_VERBS);

/**
 * The file's `spinnerVerbs`, or null when it doesn't set them (or isn't valid JSON). Claude
 * Code's default mode is `append`; an empty `replace` list can't replace anything.
 */
export const parseSetting = (text: string): Setting | null => {
  const setting = Option.getOrNull(decode(text))?.spinnerVerbs;

  if (setting === undefined) return null;

  const verbs = clean(setting.verbs ?? []);
  const mode = setting.mode === "replace" && verbs.length > 0 ? "replace" : "append";

  return verbs.length === 0 && mode === "append" ? null : { mode, verbs };
};

/** The files that can set it, lowest precedence first. */
const settingsFiles = (home: string, cwd: string | null): ReadonlyArray<string> => [
  join(home, ".claude", "settings.json"),
  ...(cwd === null
    ? []
    : [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")]),
];

interface Cached {
  readonly key: string;
  readonly setting: Setting | null;
}

export interface ReaderInput {
  readonly home?: string;
}

/** `harness.spinnerVerbs`: the highest-precedence file that sets them wins, whole. */
export const spinnerVerbsHandler = ({ home = homedir() }: ReaderInput = {}) => {
  const cache = new Map<string, Cached>();

  /** Re-parsed only when the file changed since the last ask. */
  const read = async (path: string): Promise<Setting | null> => {
    const info = await stat(path).catch(() => null);

    if (info === null || !info.isFile()) {
      cache.delete(path);

      return null;
    }

    const key = `${info.mtimeMs}:${info.size}`;
    const hit = cache.get(path);

    if (hit?.key === key) return hit.setting;

    const setting = parseSetting(await readFile(path, "utf8").catch(() => ""));

    cache.set(path, { key, setting });

    return setting;
  };

  return Effect.fn("harness.spinnerVerbs")(function* ({ cwd }: { readonly cwd: string | null }) {
    const files = settingsFiles(home, cwd);
    const settings = yield* Effect.promise(() => Promise.all(files.map(read)));

    const at = settings.findLastIndex((s) => s !== null);
    const winner = settings[at];

    return winner === undefined || winner === null
      ? null
      : new SpinnerVerbs({ mode: winner.mode, verbs: [...winner.verbs], source: files[at] ?? "" });
  });
};
