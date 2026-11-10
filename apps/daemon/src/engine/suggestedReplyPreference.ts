/**
 * The Host's Suggested Reply preference (ENG-884, ADR 0106), in
 * `~/.polaris/suggested-replies.json`: read by the RPCs, the Harness drivers and the
 * fallback writer, and resolved against the Harnesses ready on this Host.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AUTO_SUGGESTED_REPLY_FALLBACKS,
  DEFAULT_SUGGESTED_REPLY_SETTINGS,
  FileError,
  HostHarnesses,
  ResolvedSuggestedReplyFallback,
  type SuggestedReplyFallback,
  SuggestedReplySettings,
} from "@polaris/protocol";
import { Context, Effect, Layer, Option, Schema, type Stream, SubscriptionRef } from "effect";
import { Availability } from "../harness/availability/Availability.ts";
import { paths } from "../paths.ts";

const SettingsJson = Schema.fromJsonString(SuggestedReplySettings);

const decode = Schema.decodeUnknownOption(SettingsJson);

const encode = Schema.encodeSync(SettingsJson);

/** The settings file, or the defaults when it is missing or unreadable. */
export const loadSuggestedReplySettings = (path: string) =>
  Effect.promise(() => readFile(path, "utf8").catch(() => null)).pipe(
    Effect.map((text) =>
      text === null
        ? DEFAULT_SUGGESTED_REPLY_SETTINGS
        : Option.getOrElse(decode(text), () => DEFAULT_SUGGESTED_REPLY_SETTINGS)
    )
  );

/** Written to a temporary file and renamed, so a crash never leaves half a file. */
const saveSettings = (path: string, settings: SuggestedReplySettings) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, encode(settings));
      await rename(temporary, path);
    },
    catch: (cause) =>
      new FileError({
        path,
        code: "EIO",
        message: `Could not save the Suggested Reply settings: ${String(cause)}`,
      }),
  });

const isReady = (harnesses: HostHarnesses, choice: SuggestedReplyFallback): boolean =>
  harnesses.harnesses.some((h) => h.harness === choice.harness && h.status === "ready");

/** The fallback the Daemon writes with: the chosen one, else the first ready automatic pick. */
export const resolveFallback = (
  settings: SuggestedReplySettings,
  harnesses: HostHarnesses
): ResolvedSuggestedReplyFallback =>
  settings.fallback === null
    ? ResolvedSuggestedReplyFallback.make({
        choice: AUTO_SUGGESTED_REPLY_FALLBACKS.find((c) => isReady(harnesses, c)) ?? null,
        source: "auto",
      })
    : ResolvedSuggestedReplyFallback.make({ choice: settings.fallback, source: "settings" });

const NO_HARNESSES = HostHarnesses.make({ harnesses: [], checkedAt: new Date(0).toISOString() });

const defaultPath = () => join(paths().root, "suggested-replies.json");

const make = (path: string) =>
  Effect.gen(function* () {
    const availability = yield* Effect.serviceOption(Availability);
    const ref = yield* SubscriptionRef.make(yield* loadSuggestedReplySettings(path));
    const current = SubscriptionRef.get(ref);

    const harnesses = Option.isSome(availability)
      ? availability.value.get(false)
      : Effect.succeed(NO_HARNESSES);

    return SuggestedReplyPreference.of({
      current,
      enabledNow: () => SubscriptionRef.getUnsafe(ref).enabled,
      // The ref replays its latest value, so a new subscriber starts from the current one.
      changes: SubscriptionRef.changes(ref),
      resolved: Effect.gen(function* () {
        const settings = yield* current;

        return { settings, resolved: resolveFallback(settings, yield* harnesses) };
      }),
      set: (settings) =>
        saveSettings(path, settings).pipe(Effect.andThen(SubscriptionRef.set(ref, settings))),
    });
  });

export class SuggestedReplyPreference extends Context.Service<
  SuggestedReplyPreference,
  {
    readonly current: Effect.Effect<SuggestedReplySettings>;
    /** For a driver's synchronous getter: whether Suggested Replies are on right now. */
    readonly enabledNow: () => boolean;
    /** The current preference, then each new one. */
    readonly changes: Stream.Stream<SuggestedReplySettings>;
    /** The preference and the fallback it resolves to on this Host now. */
    readonly resolved: Effect.Effect<{
      readonly settings: SuggestedReplySettings;
      readonly resolved: ResolvedSuggestedReplyFallback;
    }>;
    /** Saves the preference on the Host; `changes` follows at once. */
    readonly set: (settings: SuggestedReplySettings) => Effect.Effect<void, FileError>;
  }
>()("polaris/daemon/engine/SuggestedReplyPreference") {
  /** `path` defaults to `suggested-replies.json` in the Polaris home. */
  static readonly layer = (path?: string) =>
    Layer.effect(
      SuggestedReplyPreference,
      Effect.suspend(() => make(path ?? defaultPath()))
    );
}
