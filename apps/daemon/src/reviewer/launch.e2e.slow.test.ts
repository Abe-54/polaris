/**
 * A Reviewer whose Harness couldn't run (ENG-758): its sandbox didn't start, or its binary isn't
 * installed. The Risk Summary's agent layer fails with why, never "Reviewed".
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Workspace } from "@polaris/protocol";
import { Effect } from "effect";
import { probeClaudeSandbox, unsandboxedReviewerNote } from "../harness/claude/sandbox.ts";
import { makeCodexDriver } from "../harness/codex/CodexDriver.ts";
import { shortHostName } from "../service/hostName.ts";
import { Reviewer } from "./index.ts";
import {
  checkoutId,
  cleanupReviewerTests,
  context,
  ended,
  openReview,
  reviewerLayer,
  run,
  scenario,
  subject,
  summaryWhen,
} from "./testing.ts";

afterEach(cleanupReviewerTests);

const openRequest = (workspace: Workspace) => ({
  workspaceId: workspace.id,
  subject,
  checkoutId,
  since: null,
  refresh: false,
  context,
});

const host = shortHostName();

const CODEX = "/home/lucas/.codex/packages/standalone/releases/0.164.0/bin/codex";

describe("a Reviewer that couldn't run", () => {
  test.each([
    [
      "bwrap can't run the Harness inside the sandbox",
      `bwrap: execvp ${CODEX}: No such file or directory`,
      `sandbox on ${host} couldn't start ${CODEX}, which it can't see.`,
    ],
    [
      "bwrap can't make its namespaces",
      "bwrap: setting up uid map: Permission denied",
      `sandbox didn't start on ${host} (bwrap: setting up uid map: Permission denied). Check that \`bwrap --ro-bind / / true\` runs there`,
    ],
  ])(
    "fails when its sandbox didn't start, keeping what it found: %s",
    async (_, output, note) => {
      const s = await scenario();

      const { layer } = reviewerLayer({
        ready: true,
        reviewerCommands: [
          { output, exitCode: 1 },
          { output, exitCode: 1 },
        ],
      });

      await run(
        layer,
        Effect.gen(function* () {
          const reviewer = yield* Reviewer;
          const workspace = yield* openReview(s.user, s.v1);
          const done = yield* summaryWhen((yield* reviewer.run(openRequest(workspace))).id, ended);

          expect(done.layers.agent.status).toBe("failed");
          expect(done.layers.agent.note).toStartWith(
            "The reviewer couldn't run commands: Claude Code's "
          );
          expect(done.layers.agent.note).toContain(note);
          // What it found from the diff alone still shows.
          expect(done.findings).toHaveLength(1);
        })
      );
    },
    60_000
  );

  // The reviewed change controls its scripts' output: printing bwrap's words mustn't fail the review.
  test.each([
    [
      "bwrap's line followed by the script's own output",
      [
        {
          output: `bwrap: execvp ${CODEX}: No such file or directory\nnpm ERR! test failed`,
          exitCode: 1,
        },
      ],
    ],
    [
      "bwrap's line beside a command that ran",
      [
        { output: `bwrap: execvp ${CODEX}: No such file or directory`, exitCode: 1 },
        { output: "a1b2c3d Add the feature", exitCode: 0 },
      ],
    ],
  ])(
    "completes when a command only looks like a sandbox failure: %s",
    async (_, commands) => {
      const s = await scenario();
      const { layer } = reviewerLayer({ ready: true, reviewerCommands: commands });

      await run(
        layer,
        Effect.gen(function* () {
          const reviewer = yield* Reviewer;
          const workspace = yield* openReview(s.user, s.v1);
          const done = yield* summaryWhen((yield* reviewer.run(openRequest(workspace))).id, ended);

          expect(done.layers.agent.status).toBe("completed");
          // Only this Host's own shell note, if any: Linux without socat and Windows have one.
          expect(done.layers.agent.note).toBe(unsandboxedReviewerNote(probeClaudeSandbox(), host));
          expect(done.findings).toHaveLength(1);
        })
      );
    },
    60_000
  );

  test("fails when its Harness isn't installed, naming where the Daemon looked", async () => {
    const s = await scenario();

    // The real Codex driver, as the registry builds it when `codex` isn't on the PATH.
    const codex = await Effect.runPromise(
      Effect.scoped(makeCodexDriver({ codexPath: null, spawnAppServer: false }))
    );

    const { layer } = reviewerLayer({ ready: true, open: codex.open });

    await run(
      layer,
      Effect.gen(function* () {
        const reviewer = yield* Reviewer;
        const workspace = yield* openReview(s.user, s.v1);
        const done = yield* summaryWhen((yield* reviewer.run(openRequest(workspace))).id, ended);

        expect(done.layers.agent.status).toBe("failed");
        expect(done.layers.agent.note).toContain(
          `Codex isn't installed on ${host}: there's no codex in the daemon's PATH (${process.env.PATH}).`
        );
        expect(done.findings).toHaveLength(0);
      })
    );
  }, 60_000);
});
