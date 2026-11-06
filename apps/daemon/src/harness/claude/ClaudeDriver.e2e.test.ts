/**
 * One real, tiny Turn against the installed `claude`, using its own sign-in.
 * Opt in with `POLARIS_E2E_CLAUDE=1 bun test ClaudeDriver.e2e`.
 */
import { tempDir } from "../../platform/tempDir.testing.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalDecision, SessionId, TurnId, TurnItem } from "@polaris/protocol";
import { Effect, Exit, Scope, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";

const enabled = process.env.POLARIS_E2E_CLAUDE === "1";

describe.skipIf(!enabled)("Claude driver against the real claude", () => {
  test(
    "runs one Turn and hands over a resumable cursor",
    async () => {
      const driver = makeClaudeDriver();
      const probe = await Effect.runPromise(driver.probe);
      expect(probe.available).toBe(true);

      const cwd = tempDir("polaris-e2e-claude-");
      const scope = Effect.runSync(Scope.make());

      const session = await Effect.runPromise(
        driver
          .open({
            sessionId: SessionId.make("e2e"),
            cwd,
            permissionMode: "supervised",
            model: "haiku",
            effort: null,
            resumeCursor: null,
          })
          .pipe(Scope.provide(scope))
      );

      const events: HarnessEvent[] = [];

      const done = Effect.runPromise(
        Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e)))
      );

      await Effect.runPromise(
        session.sendTurn({
          turnId: TurnId.make("e2e-turn"),
          prompt: "Reply with the single word ok and nothing else. Do not use any tools.",
          attachments: [],
          model: null,
          effort: null,
        })
      );

      for (let i = 0; i < 1200 && !events.some(HarnessEvent.$is("TurnEnded")); i++)
        await Bun.sleep(100);

      const ended = events.find(HarnessEvent.$is("TurnEnded"));
      expect(ended).toMatchObject({ status: "completed" });

      const text = events
        .filter(HarnessEvent.$is("ItemCompleted"))
        .flatMap(({ item }) => (TurnItem.guards.AssistantMessage(item) ? [item.text] : []))
        .join("");

      expect(text.toLowerCase()).toContain("ok");
      const cursor = events.find(HarnessEvent.$is("CursorAssigned"));
      expect(cursor).toBeDefined();
      const argv = await Effect.runPromise(session.terminalCommand);
      expect(argv.slice(0, 2)).toEqual(["claude", "--resume"]);

      await Effect.runPromise(Scope.close(scope, Exit.void));
      await done;
      expect(events.at(-1)).toEqual(HarnessEvent.Exited({ error: null }));
      console.log("e2e events:", events.map((e) => e._tag).join(" "), "|", text);
    },
    { timeout: 180_000 }
  );

  test(
    "suggests the title Claude Code generates for the session",
    async () => {
      const driver = makeClaudeDriver();
      const cwd = tempDir("polaris-e2e-claude-title-");
      const scope = Effect.runSync(Scope.make());

      const session = await Effect.runPromise(
        driver
          .open({
            sessionId: SessionId.make("e2e-title"),
            cwd,
            permissionMode: "supervised",
            model: "haiku",
            effort: null,
            resumeCursor: null,
          })
          .pipe(Scope.provide(scope))
      );

      const events: HarnessEvent[] = [];
      Effect.runFork(Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e))));
      await Effect.runPromise(
        session.sendTurn({
          turnId: TurnId.make("e2e-title-turn"),
          prompt:
            "I want to plan a migration of a Postgres database from version 14 to 16. For now, reply with the single word ok and nothing else. Do not use any tools.",
          attachments: [],
          model: null,
          effort: null,
        })
      );

      for (let i = 0; i < 1200 && !events.some(HarnessEvent.$is("TitleSuggested")); i++)
        await Bun.sleep(100);

      const title = events.find(HarnessEvent.$is("TitleSuggested"))?.title ?? "";
      expect(title.toLowerCase()).toContain("postgres");
      expect(title).not.toContain("I want to plan");
      await Effect.runPromise(Scope.close(scope, Exit.void));
      console.log("e2e title:", title);
    },
    { timeout: 180_000 }
  );

  test(
    "lists a Workspace's own Skill and command, and runs the command from its /name",
    async () => {
      const driver = makeClaudeDriver();
      const cwd = tempDir("polaris-e2e-claude-commands-");

      await mkdir(join(cwd, ".claude/commands"), { recursive: true });
      await mkdir(join(cwd, ".claude/skills/polaris-probe-skill"), { recursive: true });
      await writeFile(
        join(cwd, ".claude/commands/polaris-probe.md"),
        "---\ndescription: Answers the probe\n---\nReply with exactly PROBE-OK and nothing else. Do not use any tools.\n"
      );
      await writeFile(
        join(cwd, ".claude/skills/polaris-probe-skill/SKILL.md"),
        "---\nname: polaris-probe-skill\ndescription: A probe Skill\n---\nSay hi.\n"
      );
      const listCommands = driver.listCommands;

      const commands = listCommands === undefined ? [] : await Effect.runPromise(listCommands(cwd));
      const byName = (name: string) => commands.find((c) => c.name === name);

      expect(byName("polaris-probe")).toMatchObject({
        kind: "command",
        source: "project",
        run: "text",
      });
      expect(byName("polaris-probe-skill")).toMatchObject({ kind: "skill", source: "project" });
      expect(byName("model")).toMatchObject({ run: "polaris", action: "model" });
      expect(byName("color")).toBeUndefined();

      const scope = Effect.runSync(Scope.make());

      const session = await Effect.runPromise(
        driver
          .open({
            sessionId: SessionId.make("e2e-commands"),
            cwd,
            permissionMode: "supervised",
            model: "haiku",
            effort: null,
            resumeCursor: null,
          })
          .pipe(Scope.provide(scope))
      );

      const events: HarnessEvent[] = [];

      const done = Effect.runPromise(
        Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e)))
      );

      // What the composer sends for the chip: its sigil and name, as Claude Code reads it.
      await Effect.runPromise(
        session.sendTurn({
          turnId: TurnId.make("e2e-command-turn"),
          prompt: "/polaris-probe",
          attachments: [],
          model: null,
          effort: null,
        })
      );

      for (let i = 0; i < 1200 && !events.some(HarnessEvent.$is("TurnEnded")); i++)
        await Bun.sleep(100);

      expect(events.find(HarnessEvent.$is("TurnEnded"))).toMatchObject({ status: "completed" });

      const text = events
        .filter(HarnessEvent.$is("ItemCompleted"))
        .flatMap(({ item }) => (TurnItem.guards.AssistantMessage(item) ? [item.text] : []))
        .join("");

      expect(text).toContain("PROBE-OK");
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await done;
      console.log("e2e command:", commands.length, "listed |", text);
    },
    { timeout: 180_000 }
  );

  test(
    "plans without editing: a session started in plan mode writes no file and asks before it would",
    async () => {
      const driver = makeClaudeDriver();
      const cwd = tempDir("polaris-e2e-claude-plan-");
      await writeFile(join(cwd, "README.md"), "# Greeter\n\nPrints a greeting.\n");
      const scope = Effect.runSync(Scope.make());

      const session = await Effect.runPromise(
        driver
          .open({
            sessionId: SessionId.make("e2e-plan"),
            cwd,
            permissionMode: "plan",
            model: "haiku",
            effort: null,
            resumeCursor: null,
          })
          .pipe(Scope.provide(scope))
      );

      const events: HarnessEvent[] = [];

      const done = Effect.runPromise(
        Stream.runForEach(session.events, (e) =>
          Effect.gen(function* () {
            events.push(e);

            if (HarnessEvent.$is("ApprovalRequested")(e))
              yield* session.respond(
                e.requestId,
                ApprovalDecision.cases.Deny.make({ reason: null })
              );
          })
        )
      );

      await Effect.runPromise(
        session.sendTurn({
          turnId: TurnId.make("e2e-plan-turn"),
          prompt: "Create greeting.txt containing the word hello.",
          attachments: [],
          model: null,
          effort: null,
        })
      );

      for (let i = 0; i < 1800 && !events.some(HarnessEvent.$is("TurnEnded")); i++)
        await Bun.sleep(100);
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await done;

      const asked = events.filter(HarnessEvent.$is("ApprovalRequested"));
      console.log("e2e plan approvals:", asked.map((e) => `${e.kind}:${e.title}`).join(" | "));
      expect(events.find(HarnessEvent.$is("TurnEnded"))).toMatchObject({ status: "completed" });
      expect(existsSync(join(cwd, "greeting.txt"))).toBe(false);
      // It put a plan to the user (ExitPlanMode) instead of editing.
      expect(asked.map((e) => e.title)).toContain("Approve the plan");
    },
    { timeout: 240_000 }
  );
});
