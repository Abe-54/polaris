import { expect, test } from "bun:test";
import { Schema } from "effect";
import { HarnessModels, Turn, TurnItem } from "./index.ts";

const at = "2026-10-20T00:00:00.000Z";

test("an older Daemon's Turn and command item decode as not the user's shell command", () => {
  const turn = Schema.decodeUnknownSync(Turn)({
    id: "t",
    sessionId: "s",
    index: 0,
    prompt: "hi",
    attachments: [],
    model: null,
    effort: null,
    status: "completed",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: at,
    endedAt: at,
  });

  const { origin: _, ...older } = Schema.encodeSync(TurnItem.cases.CommandExecution)(
    TurnItem.cases.CommandExecution.make({
      id: "c",
      command: "ls",
      cwd: "/r",
      output: "",
      exitCode: 0,
      status: "completed",
      origin: "user",
    })
  );

  const item = Schema.decodeUnknownSync(TurnItem)(older);

  expect(turn.shellCommand).toBeNull();
  expect(item).toMatchObject({ origin: null });
});

test("an older Daemon's models say its Harness runs no shell commands", () => {
  const models = Schema.decodeUnknownSync(HarnessModels)({
    harness: "claude",
    models: [],
    switchesModel: true,
    fetchedAt: at,
  });

  expect(models.runsShellCommands).toBe(false);
});
