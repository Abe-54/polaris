import { expect, test } from "bun:test";
import {
  ConstellationFinding,
  ConstellationRejected,
  ReviewAction,
  SetConstellationStateAction,
} from "@polaris/protocol";
import { FriendlyAnswer, FriendlyReview } from "./inputs.ts";
import { Effect, Schema } from "effect";
import { constellationTools } from "./index.ts";
import { WORKER_TOOL_NAMES, fakeCommands, leadBinding, workerBinding } from "../testing.ts";

const invoke = <A>(tools: ReturnType<typeof constellationTools>, name: string, input: A) => {
  const tool = tools.find((entry) => entry.name === name);

  if (!tool) throw new Error(`No ${name} tool`);

  return tool.call(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(input))
  );
};

test("worker tools cannot forge role, Constellation, Attempt or operator authority", async () => {
  const fake = fakeCommands();
  const tools = constellationTools(workerBinding, fake.commands);
  expect(tools.map((tool) => tool.name)).toEqual(WORKER_TOOL_NAMES);

  for (const fields of [
    { role: "lead" },
    { attemptId: "other" },
    { constellationId: "other" },
    { authority: "may_decide_and_continue" },
  ]) {
    const result = await invoke(tools, "progress", { note: "forged", ...fields });
    expect(result.isError).toBe(true);
  }

  expect(fake.calls).toHaveLength(0);
  const result = await invoke(tools, "progress", { note: "Checks passed", completed: 1, total: 2 });
  expect(result.content[0]?.text).toEndWith(
    "Next: Continue the assignment; report the next useful milestone."
  );
  expect(fake.calls[0]?.binding).toEqual({ kind: "session", sessionId: workerBinding.sessionId });
  expect(fake.calls[0]?.command).toMatchObject({
    constellationId: workerBinding.constellationId,
    attemptId: workerBinding.attemptId,
  });
});

test("block binds the worker and validates nonempty reasons and Task ids", async () => {
  const fake = fakeCommands();
  const tools = constellationTools(workerBinding, fake.commands);
  expect((await invoke(tools, "block", { on: ["feed"], reason: "" })).isError).toBe(true);
  expect((await invoke(tools, "block", { on: [""], reason: "Wait" })).isError).toBe(true);
  expect(
    (await invoke(tools, "block", { on: [], reason: "Wait", attemptId: "other" })).isError
  ).toBe(true);
  expect(fake.calls).toHaveLength(0);
  await invoke(tools, "block", { on: ["feed"], reason: "Waiting for the feed" });
  expect(fake.calls[0]?.command._tag).toBe("WorkerBlock");
  expect(fake.calls[0]?.command).toMatchObject({
    constellationId: workerBinding.constellationId,
    attemptId: workerBinding.attemptId,
    on: ["feed"],
    reason: "Waiting for the feed",
  });
});

test("Lead dispatch resolves Host, model and worker names; review requires revision", async () => {
  const fake = fakeCommands();
  const tools = constellationTools(leadBinding, fake.commands);
  await invoke(tools, "dispatch", {
    tasks: [
      { taskId: "A1", worker: { host: "devbox", selection: { harness: "codex", model: "Sol" } } },
      { taskId: "A2", worker: { session: "helper" } },
    ],
  });
  expect(fake.references).toEqual(["host:devbox", "model:Sol", "session:helper"]);
  expect(fake.calls[0]?.command).toMatchObject({
    tasks: [
      { taskId: "A1", worker: { hostId: "host-devbox", selection: { model: "model-Sol" } } },
      { taskId: "A2", worker: { sessionId: "session-helper" } },
    ],
  });
  expect(
    (
      await invoke(tools, "review", {
        task: "A1",
        action: ReviewAction.cases.Stop.make({ reason: "Stop" }),
      })
    ).isError
  ).toBe(true);
  await invoke(tools, "review", {
    task: "A1",
    revision: 7,
    action: ReviewAction.cases.Stop.make({ reason: "Stop" }),
  });
  expect(fake.calls[1]?.command).toMatchObject({ attemptId: "attempt-A1", revision: 7 });
});

test("Lead dispatch supplies a resolved default worker for all ready Tasks", async () => {
  const fake = fakeCommands();

  const result = await invoke(constellationTools(leadBinding, fake.commands), "dispatch", {
    defaultWorker: { host: "local" },
  });

  expect(result.isError).not.toBe(true);
  expect(fake.references).toEqual(["host:local"]);
  expect(fake.calls[0]?.command).toMatchObject({
    constellationId: leadBinding.constellationId,
    tasks: [],
    defaultWorker: { hostId: "host-local" },
  });
});

test("domain rejections retain every finding and current revision", async () => {
  const fake = fakeCommands();

  const findings = [
    new ConstellationFinding({
      code: "E-DEP-CYCLE",
      message: "Cycle",
      fix: "Remove a dependency.",
    }),
    new ConstellationFinding({ code: "E-REVISION", message: "Old revision", fix: "Read status." }),
  ];

  const commands = {
    ...fake.commands,
    command: () => Effect.fail(new ConstellationRejected({ findings, revision: 12, graph: null })),
  };

  const result = await invoke(constellationTools(workerBinding, commands), "progress", {
    note: "Ready",
  });

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("E-DEP-CYCLE");
  expect(result.content[0]?.text).toContain("E-REVISION");
  expect(result.content[0]?.text).toContain("Revision: 12");
  expect(result.structuredContent).toEqual({ findings, revision: 12, graph: null });
  expect(result.content[0]?.text).toMatch(/Next: .+$/);
});

test("tool JSON schemas include referenced Claim definitions", () => {
  const tool = constellationTools(workerBinding, fakeCommands().commands).find(
    (entry) => entry.name === "claim"
  );

  expect(tool?.inputSchema).toHaveProperty("$defs.ConstellationClaimEncoded");
});

test("status emits JSON only when asked and every result ends in Next", async () => {
  const tools = constellationTools(workerBinding, fakeCommands().commands);
  const plain = await invoke(tools, "status", {});
  const json = await invoke(tools, "status", { json: true });
  expect(plain.content[0]?.text).not.toContain('"constellation"');
  expect(json.content[0]?.text).toContain('"constellation"');
  expect(json.content[0]?.text).toEndWith("Next: Review the Claim.");
});

test("review shares friendly worker placement with dispatch and keeps merge-conflict base", async () => {
  const fake = fakeCommands();
  const tools = constellationTools(leadBinding, fake.commands);

  const result = await invoke(tools, "review", {
    task: "A1",
    revision: 3,
    action: FriendlyReview.cases.SendBack.make({
      reason: "Rebase the claimed head",
      mergeConflictBase: "new-base",
      worker: { host: "local", selection: { model: "Sol" } },
    }),
  });

  expect(result.isError).not.toBe(true);
  expect(result.content[0]?.text).toStartWith("Review recorded.\nRevision: 7\n");
  expect(fake.references).toEqual(["host:local", "model:Sol", "attempt:A1"]);
  expect(fake.calls[0]?.command).toMatchObject({
    attemptId: "attempt-A1",
    revision: 3,
    action: {
      worker: { hostId: "host-local", selection: { model: "model-Sol" } },
      mergeConflictBase: "new-base",
    },
  });
});

test("ambiguous placement and Lead approval arguments fail without submitting a command", async () => {
  const fake = fakeCommands();
  const tools = constellationTools(leadBinding, fake.commands);

  const result = await invoke(tools, "dispatch", {
    tasks: [{ taskId: "A1", worker: { session: "helper", host: "local" } }],
  });

  expect(result.isError).toBe(true);
  expect(result.structuredContent?.revision).toBe(7);
  expect(result.structuredContent?.findings?.[0]?.code).toBe("E-INPUT");
  expect(
    (
      await invoke(tools, "review", {
        task: "A1",
        revision: 1,
        action: ReviewAction.cases.Approve.make({}),
      })
    ).isError
  ).toBe(true);
  expect(fake.calls).toHaveLength(0);
});

test("answer resolves the short Task and handover resolves the requested model", async () => {
  const fake = fakeCommands();
  const tools = constellationTools(leadBinding, fake.commands);
  await invoke(tools, "answer", {
    action: FriendlyAnswer.cases.Question.make({ task: "A1", questionId: "q", text: "Use main" }),
  });
  await invoke(tools, "set_state", {
    action: SetConstellationStateAction.cases.HandOver.make({
      summary: "Claims and Gate remain",
      interrupt: false,
      selection: { model: "Sol" },
    }),
  });
  expect(fake.references).toEqual(["attempt:A1", "model:Sol"]);
  expect(fake.calls[0]?.command).toMatchObject({
    action: { attemptId: "attempt-A1", questionId: "q", text: "Use main" },
  });
  expect(fake.calls[1]?.command).toMatchObject({ action: { selection: { model: "model-Sol" } } });
});
