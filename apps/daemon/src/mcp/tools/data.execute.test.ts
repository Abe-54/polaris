import { expect, test } from "bun:test";
import { DataWriteResult, RequestId } from "@polaris/protocol";
import { Effect } from "effect";
import { DataApprovalRequired } from "../../data/approvalRequired.ts";
import { bindings, toolsWithData } from "./data.testing.ts";

const required = new DataApprovalRequired({
  approvalId: RequestId.make("write-approval"),
  sourceId: "app",
  sourceName: "app",
});

const result = new DataWriteResult({ queryId: "write-query", affected: 1, elapsedMs: 2 });

const input = {
  source: "app",
  sql: "UPDATE items SET v=1",
  reason: "Repair item",
  requestId: "repair-once",
};

for (const binding of bindings) {
  test(`${binding._tag} execute binds identity, waits for approval and returns the committed result`, async () => {
    let approved = false;
    let received: unknown;

    const execute = toolsWithData(
      {
        execute: (value) =>
          Effect.suspend(() => {
            received = value;

            return approved ? Effect.succeed(result) : Effect.fail(required);
          }),
        awaitApproval: () => {
          approved = true;

          return Effect.succeed({ status: "approved" });
        },
      },
      binding
    )("execute");

    expect(execute.annotations?.readOnlyHint).toBe(false);
    expect(execute.annotations?.destructiveHint).toBe(true);
    const answer = await execute.call(input);
    expect(received).toEqual({ ...input, sessionId: binding.sessionId });
    expect(answer.structuredContent).toEqual({ queryId: "write-query", affected: 1, elapsedMs: 2 });
    const forged = await execute.call({ ...input, sessionId: "other" });
    expect(forged.structuredContent?.code).toBe("E-INPUT");
  });
}

test("execute denial returns the user's reason without a second execution", async () => {
  let attempts = 0;

  const answer = await toolsWithData({
    execute: () => {
      attempts++;

      return Effect.fail(required);
    },
    awaitApproval: () => Effect.succeed({ status: "denied", reason: "Use staging" }),
  })("execute").call(input);

  expect(answer.structuredContent).toMatchObject({ code: "E-DATA-DENIED", message: "Use staging" });
  expect(attempts).toBe(1);
});

test("execute rejects malformed retry keys before invoking the service", async () => {
  for (const requestId of ["", 7, "x".repeat(201)]) {
    const result = await toolsWithData()("execute").call({ ...input, requestId });
    expect(result.structuredContent?.code).toBe("E-INPUT");
  }
});
