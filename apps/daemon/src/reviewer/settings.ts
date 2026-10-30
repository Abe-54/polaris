/**
 * Settings → Harnesses → Reviewer (ENG-222), kept on the Host because the
 * Daemon runs Reviews on its own: a default and per-Workspace overrides in
 * `~/.polaris/reviewer-settings.json`, resolved against what is installed.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AUTO_REVIEWERS,
  type HostHarnesses,
  ResolvedReviewer,
  ReviewerChoice,
  ReviewerSettings,
  type WorkspaceId,
} from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";
import { polarisHome } from "../paths.ts";
import { ServiceError } from "../services.ts";

export const RULES_ONLY_NOTE =
  "Rules only: no Reviewer is available on this Host. Install or sign in to Claude Code or Codex.";

export const EMPTY_SETTINGS = ReviewerSettings.make({ default: null, workspaces: {} });

const SettingsJson = Schema.fromJsonString(ReviewerSettings);

const decode = Schema.decodeUnknownOption(SettingsJson);

const encode = Schema.encodeSync(SettingsJson);

export const settingsPath = (): string => join(polarisHome(), "reviewer-settings.json");

const failed = (message: string) => (cause: unknown) =>
  new ServiceError({ service: "ReviewerSettings", message, cause });

/** The settings file, or empty settings when it is missing or unreadable. */
export const loadSettings = (path: string) =>
  Effect.promise(() => readFile(path, "utf8").catch(() => null)).pipe(
    Effect.map((text) => {
      if (text === null) return EMPTY_SETTINGS;

      return Option.getOrElse(decode(text), () => EMPTY_SETTINGS);
    })
  );

/** Written to a temporary file and renamed, so a crash never leaves half a file. */
export const saveSettings = (path: string, settings: ReviewerSettings) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, encode(settings));
      await rename(temporary, path);
    },
    catch: failed("Could not save the Reviewer settings"),
  });

const isReady = (harnesses: HostHarnesses, choice: ReviewerChoice): boolean =>
  harnesses.harnesses.some((h) => h.harness === choice.harness && h.status === "ready");

/** The Reviewer for `workspaceId` (or the Host default for null) given what is ready. */
export const resolveReviewer = (
  settings: ReviewerSettings,
  workspaceId: WorkspaceId | null,
  harnesses: HostHarnesses
): ResolvedReviewer => {
  const override = workspaceId === null ? undefined : settings.workspaces[workspaceId];

  if (override !== undefined) {
    return ResolvedReviewer.make({ choice: override, source: "workspace", note: null });
  }

  if (settings.default !== null) {
    return ResolvedReviewer.make({ choice: settings.default, source: "settings", note: null });
  }

  const auto = AUTO_REVIEWERS.find((choice) => isReady(harnesses, choice)) ?? null;

  return ResolvedReviewer.make({
    choice: auto,
    source: "auto",
    note: auto === null ? RULES_ONLY_NOTE : null,
  });
};
