/**
 * Runs one tiny real Turn against the installed `codex` (uses the user's own
 * Codex sign-in and quota). Opt in with:
 *
 *   POLARIS_E2E_CODEX=1 bun test apps/daemon/src/harness/codex/e2e.test.ts
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ApprovalDecision, SessionId, TurnId, TurnItem } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { defaultStateFile, stopAppServer } from "./AppServer.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const enabled = process.env.POLARIS_E2E_CODEX === "1";

test.skipIf(!enabled)(
  "a real Codex Turn: reply with the word ok",
  async () => {
    const repo = newTempDir("polaris-codex-e2e-");
    // Short, so it fits the Unix socket path limit.
    const socketDir = newTempDir("pcx-", { short: true });
    await Bun.$`git init -q && git commit -q --allow-empty -m init`.cwd(repo);

    try {
      const program = Effect.gen(function* () {
        const driver = yield* makeCodexDriver({ socketPath: join(socketDir, "s.sock") });
        const probe = yield* driver.probe;
        expect(probe.available).toBe(true);

        const session = yield* driver.open({
          sessionId: SessionId.make("e2e"),
          cwd: repo,
          permissionMode: "supervised",
          model: null,
          effort: null,
          resumeCursor: null,
        });

        const turnId = TurnId.make("turn-1");
        yield* session.sendTurn({
          turnId,
          prompt: "Reply with just the word ok. Do not run commands or edit files.",
          attachments: [],
          model: null,
          effort: null,
        });

        const events = yield* session.events.pipe(
          Stream.takeUntil(HarnessEvent.$is("TurnEnded")),
          Stream.runCollect
        );

        const terminal = yield* session.terminalCommand;

        return { events: Array.from(events), terminal };
      });

      const { events, terminal } = await Effect.runPromise(Effect.scoped(program));

      const cursor = events.find(HarnessEvent.$is("CursorAssigned"));
      expect(cursor).toBeDefined();
      const ended = events.find(HarnessEvent.$is("TurnEnded"));
      expect(ended).toMatchObject({ turnId: "turn-1", status: "completed", error: null });

      const reply = events
        .filter(HarnessEvent.$is("ItemCompleted"))
        .flatMap(({ item }) => (TurnItem.guards.AssistantMessage(item) ? [item.text] : []));

      expect(reply.join(" ").toLowerCase()).toContain("ok");
      expect(terminal.slice(1)).toEqual([
        "resume",
        cursor?.cursor ?? "",
        "--remote",
        `unix://${join(socketDir, "s.sock")}`,
      ]);
    } finally {
      // The app-server outlives its Daemon by design; this test owns this one.
      const socketPath = join(socketDir, "s.sock");
      await Effect.runPromise(
        stopAppServer({ stateFile: defaultStateFile(socketPath), socketPath })
      );
      removeTempDir(repo);
      removeTempDir(socketDir);
    }
  },
  180_000
);

test.skipIf(!enabled)(
  "a real Codex session in plan mode plans without editing",
  async () => {
    const repo = newTempDir("polaris-codex-plan-e2e-");
    const socketDir = newTempDir("pcx-", { short: true });
    await Bun.$`git init -q && git commit -q --allow-empty -m init`.cwd(repo);
    await Bun.write(join(repo, "README.md"), "# Greeter\n\nPrints a greeting.\n");

    try {
      const program = Effect.gen(function* () {
        const driver = yield* makeCodexDriver({ socketPath: join(socketDir, "s.sock") });

        const session = yield* driver.open({
          sessionId: SessionId.make("e2e-plan"),
          cwd: repo,
          permissionMode: "plan",
          model: null,
          effort: null,
          resumeCursor: null,
        });

        yield* session.sendTurn({
          turnId: TurnId.make("turn-plan"),
          prompt: "Create greeting.txt containing the word hello.",
          attachments: [],
          model: null,
          effort: "low",
        });

        const events = yield* session.events.pipe(
          Stream.tap((e) =>
            HarnessEvent.$is("ApprovalRequested")(e)
              ? session.respond(e.requestId, ApprovalDecision.cases.Deny.make({ reason: null }))
              : Effect.void
          ),
          Stream.takeUntil(HarnessEvent.$is("TurnEnded")),
          Stream.runCollect
        );

        return Array.from(events);
      });

      const events = await Effect.runPromise(Effect.scoped(program));

      const reply = events
        .filter(HarnessEvent.$is("ItemCompleted"))
        .flatMap(({ item }) => (TurnItem.guards.AssistantMessage(item) ? [item.text] : []));

      expect(events.find(HarnessEvent.$is("TurnEnded"))).toMatchObject({ status: "completed" });
      expect(existsSync(join(repo, "greeting.txt"))).toBe(false);
      // Codex's plan collaboration mode, not only the read-only sandbox, kept it from editing.
      expect(reply.join("\n")).toMatch(/plan mode/i);
    } finally {
      const socketPath = join(socketDir, "s.sock");
      await Effect.runPromise(
        stopAppServer({ stateFile: defaultStateFile(socketPath), socketPath })
      );
      removeTempDir(repo);
      removeTempDir(socketDir);
    }
  },
  240_000
);
