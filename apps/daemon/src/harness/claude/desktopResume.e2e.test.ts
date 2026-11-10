/**
 * Computer use turned on mid-session, against the installed `claude` and a fake Messages API:
 * opened while Off, the session offers only request_computer_use; reopened from its cursor once
 * Ready, it offers polaris_desktop's tools and keeps the conversation. Opt in with
 * `POLARIS_E2E_CLAUDE_DESKTOP=1 bun test desktopResume.e2e`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ComputerUseState, SessionId, TurnId } from "@polaris/protocol";
import { Effect, Exit, Scope, Stream } from "effect";
import { removeTempDir, tempDir } from "../../git/testing.ts";
import { DesktopMcp } from "../desktop/index.ts";
import { fakeDeps, fakeHost, fakeRunner, OFF, READY } from "../desktop/testing.ts";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { fakeAnthropic } from "./fakeAnthropic.testing.ts";

const enabled = process.env.POLARIS_E2E_CLAUDE_DESKTOP === "1";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const SESSION = SessionId.make("e2e-desktop");

describe.skipIf(!enabled)("Claude Code: computer use turned on between Turns", () => {
  test("the next Turn resumes the conversation with polaris_desktop's tools", async () => {
    const base = tempDir("polaris-e2e-desktop-");
    cleanup.push(() => removeTempDir(base));
    const cwd = join(base, "work");
    const config = join(base, "config");
    mkdirSync(cwd);
    mkdirSync(config);
    const fake = fakeAnthropic([]);
    cleanup.push(fake.stop);
    let state: ComputerUseState = OFF;

    const desktop = Effect.runSync(
      Effect.provide(
        Effect.gen(function* () {
          return yield* DesktopMcp;
        }),
        DesktopMcp.layerWith(
          fakeDeps(fakeRunner({}).runner, {
            host: fakeHost({ state: Effect.sync(() => state) }),
          })
        )
      )
    );

    const driver = makeClaudeDriver({ desktop });

    /** Opens the session (from `cursor`), runs one Turn, closes it; answers its cursor. */
    const oneTurn = async (cursor: string | null, prompt: string) => {
      const scope = Effect.runSync(Scope.make());

      const session = await Effect.runPromise(
        driver
          .open({
            sessionId: SESSION,
            cwd,
            permissionMode: "supervised",
            model: null,
            effort: null,
            resumeCursor: cursor,
            environment: {
              ANTHROPIC_API_KEY: "sk-ant-fake",
              ANTHROPIC_BASE_URL: fake.url,
              CLAUDE_CONFIG_DIR: config,
            },
          })
          .pipe(Scope.provide(scope))
      );

      const events: Array<HarnessEvent> = [];
      Effect.runFork(Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e))));
      const turnId = TurnId.make(`e2e-desktop-${prompt.length}`);
      await Effect.runPromise(
        session.sendTurn({ turnId, prompt, attachments: [], model: null, effort: null })
      );
      const ended = (e: HarnessEvent) => HarnessEvent.$is("TurnEnded")(e) && e.turnId === turnId;

      const deadline = Date.now() + 120_000;

      while (!events.some(ended) && Date.now() < deadline) await Bun.sleep(20);
      await Effect.runPromise(Scope.close(scope, Exit.void));

      return events
        .flatMap((e) => (HarnessEvent.$is("CursorAssigned")(e) ? [e.cursor] : []))
        .at(-1);
    };

    const cursor = await oneTurn(null, "Fill in the quarterly report in Numbers.");
    const offFirst = fake.bodies.at(-1) ?? "";
    state = READY;
    await oneTurn(cursor ?? null, "Carry on.");
    const nextTools = fake.bodies.at(-1) ?? "";

    expect(cursor).toBeDefined();
    expect(offFirst).toContain("mcp__polaris_desktop__request_computer_use");
    expect(offFirst).not.toContain("mcp__polaris_desktop__snapshot");
    expect(nextTools).toContain("mcp__polaris_desktop__snapshot");
    // The same conversation: Turn 2's request carries Turn 1's prompt.
    expect(nextTools).toContain("Fill in the quarterly report in Numbers.");
  }, 180_000);
});
