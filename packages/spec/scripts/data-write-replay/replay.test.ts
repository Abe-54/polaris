import { expect, test } from "bun:test";
import { DataWriteTrace, replayDataWrite } from "./index.ts";

const trace: typeof DataWriteTrace.Type = {
  version: 1,
  source: "data-queries-write",
  steps: [
    { action: "preview", affected: 1, value: 0, phase: "pending" },
    { action: "approve", affected: 1, value: 0, phase: "approved" },
    { action: "execute", affected: 1, value: 1, phase: "completed" },
    { action: "retry", affected: 1, value: 1, phase: "completed" },
  ],
};

test("write replay rejects execution without approval and a retry that writes again", async () => {
  expect((await replayDataWrite(trace)).steps).toBe(4);
  await Promise.resolve(
    expect(
      replayDataWrite({ ...trace, steps: [trace.steps[0]!, trace.steps[2]!] })
    ).rejects.toThrow("Data write replay rejected")
  );
  await Promise.resolve(
    expect(
      replayDataWrite({
        ...trace,
        steps: [
          ...trace.steps.slice(0, 3),
          { action: "retry", affected: 1, value: 2, phase: "completed" },
        ],
      })
    ).rejects.toThrow("Data write replay rejected")
  );
}, 30000);
