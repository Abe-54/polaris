import { tempDir } from "../../platform/tempDir.testing.ts";
import { describe, expect, test } from "bun:test";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionId } from "@polaris/protocol";
import { Effect, Exit, Scope, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { FakeClaude } from "./fakeClaude.ts";
import { readTranscriptTitle } from "./title.ts";

/** Transcript lines shaped as Claude Code 2.1.310 writes them (other entries trimmed). */
const aiTitle = (title: string) =>
  `${JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: "claude-session-1" })}\n`;

const customTitle = (title: string) =>
  `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId: "claude-session-1" })}\n`;

const prompt = `${JSON.stringify({
  type: "user",
  message: { role: "user", content: "Help me plan a Postgres 14 to 16 migration" },
  sessionId: "claude-session-1",
})}\n`;

const transcript = async (content: string) => {
  const path = join(tempDir("polaris-claude-title-"), "session.jsonl");
  await writeFile(path, content);

  return path;
};

const titlesOf = (events: ReadonlyArray<HarnessEvent>) =>
  events.flatMap((e) => (HarnessEvent.$is("TitleSuggested")(e) ? [e.title] : []));

describe("Claude Code's session title", () => {
  test("the driver suggests the title Claude Code generated, once, and the user's rename", async () => {
    const fake = new FakeClaude();
    const driver = makeClaudeDriver({ query: fake.query, claudePath: () => "/opt/bin/claude" });
    const scope = Effect.runSync(Scope.make());

    const session = await Effect.runPromise(
      driver
        .open({
          sessionId: SessionId.make("session-1"),
          cwd: "/work/repo",
          permissionMode: "supervised",
          model: null,
          effort: null,
          resumeCursor: null,
        })
        .pipe(Scope.provide(scope))
    );

    const events: HarnessEvent[] = [];

    const done = Effect.runPromise(
      Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e)))
    );

    const path = await transcript(`${aiTitle("Postgres 14 to 16 migration")}${prompt}`);

    await fake.stop(path);
    await fake.stop(path);
    await appendFile(path, customTitle("DB upgrade"));
    await fake.stop(path);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await done;

    expect(titlesOf(events)).toEqual(["Postgres 14 to 16 migration", "DB upgrade"]);
  });

  test.each([
    ["the last generated title", aiTitle("First") + prompt + aiTitle("Second"), "Second"],
    ["a rename over the generated one", customTitle("Mine") + aiTitle("Claude's"), "Mine"],
    [
      "a title only at the start of a long transcript",
      aiTitle("Early") + prompt.repeat(1500),
      "Early",
    ],
    ["no title yet", prompt, null],
  ])("reads %s", async (_, content, expected) => {
    expect(await readTranscriptTitle(await transcript(content))).toBe(expected);
  });

  test("a missing transcript has no title", async () => {
    expect(await readTranscriptTitle("/nonexistent/polaris/session.jsonl")).toBeNull();
  });
});
