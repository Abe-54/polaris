import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CommitMessageRequest,
  HARNESS_CATALOGUE,
  HarnessAvailability,
  HostHarnesses,
  type HarnessStatus,
} from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { Availability } from "../harness/availability/Availability.ts";
import { newTempDir } from "../platform/tempDir.testing.ts";

export const git = (cwd: string, ...args: Array<string>) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

/** A repository with one commit per subject, and nothing staged. */
export const repo = (subjects: ReadonlyArray<string> = []) => {
  const root = newTempDir("pi-commit-message-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");

  for (const [index, subject] of subjects.entries()) {
    writeFileSync(join(root, `history-${index}.txt`), subject);
    git(root, "add", "-A");
    git(root, "commit", "-q", "--no-verify", "-m", subject);
  }

  return root;
};

export const stageFile = (root: string, name: string, content: string) => {
  writeFileSync(join(root, name), content);
  git(root, "add", name);
};

export const request = (cwd: string, model: string | null = null) =>
  CommitMessageRequest.make({ cwd, harness: "claude", model, effort: null });

/** Every catalogue Harness reports `status`; `statuses` lets a refresh answer differently. */
export const availability = (...statuses: ReadonlyArray<HarnessStatus>) => {
  let asked = 0;

  const report = () => {
    const status = statuses[Math.min(asked++, statuses.length - 1)] ?? "ready";

    return new HostHarnesses({
      harnesses: HARNESS_CATALOGUE.map(
        (entry) =>
          new HarnessAvailability({
            harness: entry.kind,
            status,
            version: null,
            minVersion: entry.minVersion,
            olderThanTested: null,
            signInKind: null,
            detail: null,
            signInArgv: null,
          })
      ),
      checkedAt: new Date(0).toISOString(),
    });
  };

  return Layer.succeed(Availability)(
    Availability.of({ get: () => Effect.sync(report), changes: Stream.empty })
  );
};
