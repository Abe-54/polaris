/**
 * Runs one tiny real Turn, with one command approval, against the installed
 * `opencode` on OpenCode Zen's free tier (no credentials). The server runs with
 * throwaway XDG directories, so it never sees the user's config or sign-ins.
 * Opt in with:
 *
 *   POLARIS_E2E_OPENCODE=1 bun test apps/daemon/src/harness/opencode/e2e.test.ts
 *
 * `POLARIS_OPENCODE` picks the binary; `POLARIS_E2E_OPENCODE_MODEL` the Model
 * (default `opencode/big-pickle`, free; Zen's free tier needs OpenCode ≥ 1.18).
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalDecision, SessionId, TurnId, TurnItem } from "@polaris/protocol";
import { Effect, Schema, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeOpenCodeDriver, scratchXdg } from "./OpenCodeDriver.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const enabled = process.env.POLARIS_E2E_OPENCODE === "1";

const decodeState = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int }))
);

const model = process.env.POLARIS_E2E_OPENCODE_MODEL ?? "opencode/big-pickle";

test.skipIf(!enabled)(
  "a real OpenCode Turn: run one approved command and reply",
  async () => {
    const root = newTempDir("polaris-opencode-e2e-");
    const repo = join(root, "repo");
    mkdirSync(repo);
    await Bun.$`git init -q`.cwd(repo).quiet();
    writeFileSync(join(repo, "a.txt"), "starlight\n");
    const stateFile = join(root, "state", "opencode-server.json");
    let serverPid = 0;

    try {
      const program = Effect.gen(function* () {
        const driver = yield* makeOpenCodeDriver({
          opencodePath: () => process.env.POLARIS_OPENCODE || Bun.which("opencode"),
          env: { ...process.env, ...scratchXdg(join(root, "xdg")) },
          stateDir: join(root, "state"),
          logFile: join(root, "state", "opencode.log"),
          modelsDirectory: join(root, "models"),
        });

        const probe = yield* driver.probe;
        expect(probe.available).toBe(true);
        const models = yield* driver.listModels ?? Effect.succeed([]);
        expect(models.map((m) => m.id)).toContain(model);

        const events = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* driver.open({
              sessionId: SessionId.make("e2e"),
              cwd: repo,
              permissionMode: "supervised",
              model,
              effort: null,
              resumeCursor: null,
            });

            serverPid = decodeState(readFileSync(stateFile, "utf8")).pid;
            yield* session.sendTurn({
              turnId: TurnId.make("turn-1"),
              prompt:
                "Run the shell command `cat a.txt` (nothing else), then reply with just the word it printed.",
              attachments: [],
              model,
              effort: null,
            });

            return yield* session.events.pipe(
              Stream.tap((event) =>
                HarnessEvent.$is("ApprovalRequested")(event)
                  ? session.respond(
                      event.requestId,
                      ApprovalDecision.cases.Allow.make({ remember: false })
                    )
                  : Effect.void
              ),
              Stream.takeUntil(HarnessEvent.$is("TurnEnded")),
              Stream.runCollect
            );
          })
        );

        return Array.from(events);
      });

      const events = await Effect.runPromise(Effect.scoped(program));

      expect(events.find(HarnessEvent.$is("CursorAssigned"))?.cursor).toStartWith("ses_");
      expect(events.find(HarnessEvent.$is("ApprovalRequested"))).toMatchObject({
        turnId: "turn-1",
        kind: "command",
      });
      expect(events.find(HarnessEvent.$is("TurnEnded"))).toMatchObject({
        turnId: "turn-1",
        status: "completed",
        error: null,
      });

      const items = events.filter(HarnessEvent.$is("ItemCompleted")).map(({ item }) => item);
      const command = items.find(TurnItem.guards.CommandExecution);
      expect(command).toMatchObject({ command: "cat a.txt", status: "completed", exitCode: 0 });
      expect(command?.output).toContain("starlight");

      const reply = items.flatMap((item) =>
        TurnItem.guards.AssistantMessage(item) ? [item.text] : []
      );

      expect(reply.join(" ").toLowerCase()).toContain("starlight");
      // The server stops once its last session closes.
      expect(existsSync(stateFile)).toBe(false);
      expect(() => process.kill(serverPid, 0)).toThrow();
    } finally {
      removeTempDir(root);
    }
  },
  180_000
);
