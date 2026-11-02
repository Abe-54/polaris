/**
 * When the Reviewer's Harness couldn't run anything: its sandbox didn't start, so every command
 * it tried failed before running. The layer fails; the Findings it still returned are kept.
 */
import { harnessEntry, type HarnessKind, type TurnItem } from "@polaris/protocol";
import { Predicate } from "effect";
import { shortHostName } from "../service/hostName.ts";
import type { TurnOutcome } from "./session.ts";

/**
 * A sandbox's own setup error and the exit code it dies with: bubblewrap's `die()` and Codex's
 * bubblewrap builder exit 1, `sandbox-exec` 65 (a bad profile) or 71 (it couldn't apply or exec).
 */
const SETUP_FAILURES: ReadonlyArray<{
  readonly prefix: string;
  readonly exitCodes: ReadonlyArray<number>;
}> = [
  { prefix: "bwrap: ", exitCodes: [1] },
  { prefix: "error building bubblewrap command: ", exitCodes: [1] },
  { prefix: "sandbox-exec: ", exitCodes: [65, 71] },
];

type Command = Extract<TurnItem, { readonly _tag: "CommandExecution" }>;

/**
 * The sandbox's line when it is all the command printed and it exited as the sandbox does. A
 * reviewed script can mimic that, so the layer keeps its Findings (ADR 0055).
 */
const setupFailure = (command: Command): string | null => {
  const output = command.output.trim();

  if (output === "" || output.includes("\n") || command.exitCode === null) return null;
  const exitCode = command.exitCode;

  return SETUP_FAILURES.some(
    ({ prefix, exitCodes }) => output.startsWith(prefix) && exitCodes.includes(exitCode)
  )
    ? output
    : null;
};

/**
 * The sandbox's line when every command the Turn ran failed to start in it; null when any ran,
 * or none was tried. One command that ran means the sandbox worked.
 */
export const sandboxLaunchFailure = (items: ReadonlyArray<TurnItem>): string | null => {
  const ran = items.filter(
    (item): item is Command =>
      Predicate.isTagged(item, "CommandExecution") &&
      (item.status === "completed" || item.status === "failed")
  );

  const failures = ran.map(setupFailure);
  const first = failures[0];

  return first === undefined || failures.some((line) => line === null) ? null : first;
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

/** The note that fails the layer when its sandbox never started; null when it did. */
export const sandboxNote = (
  harness: HarnessKind,
  outcome: Pick<TurnOutcome, "sandboxFailure">,
  host: string = shortHostName()
): string | null =>
  outcome.sandboxFailure === null
    ? null
    : sandboxFailureNote({ harness, host, line: outcome.sandboxFailure });

/**
 * Why a Turn gave no reply: its sandbox didn't start, or the Turn failed or was interrupted.
 * Null when it replied.
 */
export const turnFailure = (
  harness: HarnessKind,
  outcome: Pick<TurnOutcome, "reply" | "status" | "error" | "sandboxFailure">,
  host: string = shortHostName()
): string | null => {
  if (outcome.reply !== null) return null;

  return (
    sandboxNote(harness, outcome, host) ??
    `The Reviewer's Turn ${outcome.status === "interrupted" ? "was interrupted" : "failed"}${
      outcome.error === null ? "." : `: ${outcome.error}`
    }`
  );
};
