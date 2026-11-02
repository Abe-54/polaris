/**
 * When the Reviewer's Harness couldn't run anything: its sandbox didn't start, so every command
 * it tried failed before running. Whatever it then replied, the layer fails.
 */
import { harnessEntry, type HarnessKind, type TurnItem } from "@polaris/protocol";
import { Predicate } from "effect";
import { shortHostName } from "../service/hostName.ts";
import type { TurnOutcome } from "./session.ts";

/** The sandbox's own diagnostics, never the command's: bubblewrap's, Codex's, macOS's. */
const LAUNCH_FAILURE = /^(?:bwrap: |error building bubblewrap command: |sandbox-exec: ).+$/m;

/** The first line in which a failed command says its sandbox didn't start; null when none did. */
export const sandboxLaunchFailure = (items: ReadonlyArray<TurnItem>): string | null => {
  for (const item of items) {
    if (!Predicate.isTagged(item, "CommandExecution")) continue;
    const failed = item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0);
    const line = failed ? LAUNCH_FAILURE.exec(item.output)?.[0] : undefined;

    if (line !== undefined) return line.trim();
  }

  return null;
};

const nameOf = (harness: HarnessKind) => harnessEntry(harness)?.name ?? harness;

const MISSING_FILE = /execvp (\S+): No such file or directory/;

/** "The reviewer couldn't run commands: …", with what to do about it. */
export const sandboxFailureNote = (options: {
  readonly harness: HarnessKind;
  readonly host: string;
  readonly line: string;
}): string => {
  const name = nameOf(options.harness);
  const missing = MISSING_FILE.exec(options.line)?.[1];

  if (missing !== undefined)
    return `The reviewer couldn't run commands: ${name}'s sandbox on ${options.host} couldn't start ${missing}, which it can't see. Update bubblewrap and ${name} there, then review again.`;
  const bubblewrap = !options.line.startsWith("sandbox-exec");

  return `The reviewer couldn't run commands: ${name}'s sandbox didn't start on ${options.host} (${options.line}).${
    bubblewrap ? " Check that `bwrap --ro-bind / / true` runs there, then review again." : ""
  }`;
};

/**
 * Why a Turn gave no review: its sandbox didn't start (whatever it replied, it ran nothing), or
 * the Turn ended without a reply. Null when its reply can be read.
 */
export const turnFailure = (
  harness: HarnessKind,
  outcome: Pick<TurnOutcome, "reply" | "status" | "error" | "sandboxFailure">,
  host: string = shortHostName()
): string | null => {
  if (outcome.sandboxFailure !== null)
    return sandboxFailureNote({ harness, host, line: outcome.sandboxFailure });

  if (outcome.reply !== null) return null;

  return `The Reviewer's Turn ${outcome.status === "interrupted" ? "was interrupted" : "failed"}${
    outcome.error === null ? "." : `: ${outcome.error}`
  }`;
};
