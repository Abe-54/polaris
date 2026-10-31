import { expect, test } from "bun:test";
import { SubagentId, TurnId, TurnItem } from "@polaris/protocol";
import { HarnessEvent } from "./HarnessDriver.ts";
import { ItemClock } from "./itemClock.ts";

const turnId = TurnId.make("t1");

const base = Date.UTC(2026, 9, 11, 10, 0, 0);

const at = (ms: number) => new Date(base + ms).toISOString();

const command = (id: string) =>
  TurnItem.cases.CommandExecution.make({
    id,
    command: id,
    cwd: "/repo",
    output: "",
    exitCode: null,
    status: "running",
  });

const startOf = (event: HarnessEvent) =>
  HarnessEvent.$is("ItemUpdated")(event) || HarnessEvent.$is("ItemCompleted")(event)
    ? event.item.startedAt
    : undefined;

test("an item keeps the time it was first seen through to its completion", () => {
  let now = base + 1_000;
  const clock = new ItemClock(() => now);

  expect(startOf(clock.stamp(HarnessEvent.ItemUpdated({ turnId, item: command("sleep") })))).toBe(
    at(1_000)
  );
  now = base + 9_000;
  clock.stamp(HarnessEvent.ItemCompleted({ turnId, item: command("quick") }));
  now = base + 30_000;

  expect(startOf(clock.stamp(HarnessEvent.ItemCompleted({ turnId, item: command("sleep") })))).toBe(
    at(1_000)
  );
});

test("a streamed message is stamped at its first delta", () => {
  let now = base + 2_000;
  const clock = new ItemClock(() => now);
  clock.stamp(HarnessEvent.ItemDelta({ turnId, itemId: "m", field: "text", text: "Hel" }));
  now = base + 5_000;

  const done = clock.stamp(
    HarnessEvent.ItemCompleted({
      turnId,
      item: TurnItem.cases.AssistantMessage.make({ id: "m", text: "Hello" }),
    })
  );

  expect(startOf(done)).toBe(at(2_000));
});

test("a reply completed again with its stats keeps the stamp it completed with", () => {
  let now = base + 1_000;
  const clock = new ItemClock(() => now);
  const reply = TurnItem.cases.AssistantMessage.make({ id: "m:0", text: "Done." });

  clock.stamp(HarnessEvent.ItemCompleted({ turnId, item: reply }));
  now = base + 4_000;
  const again = clock.stamp(HarnessEvent.ItemCompleted({ turnId, item: reply }));

  expect(startOf(again)).toBe(at(1_000));
});

test("items seen in the same millisecond keep their order", () => {
  const clock = new ItemClock(() => base + 4_000);

  const stamps = ["a", "b", "c"].map((id) =>
    startOf(clock.stamp(HarnessEvent.ItemUpdated({ turnId, item: command(id) })))
  );

  expect(stamps).toEqual([at(4_000), at(4_001), at(4_002)]);
});

test("a Harness's own start time is kept when it doesn't go back in time", () => {
  const clock = new ItemClock(() => base + 9_000);

  const reasoning = TurnItem.cases.Reasoning.make({
    id: "r",
    text: "",
    startedAt: at(8_500),
    endedAt: null,
  });

  expect(startOf(clock.stamp(HarnessEvent.ItemUpdated({ turnId, item: reasoning })))).toBe(
    at(8_500)
  );
});

test("a Subagent's item is told apart from the Turn's with the same id", () => {
  let now = base + 1_000;
  const clock = new ItemClock(() => now);
  clock.stamp(HarnessEvent.ItemUpdated({ turnId, item: command("x") }));
  now = base + 2_000;

  const own = clock.stamp(
    HarnessEvent.ItemUpdated({ turnId, item: command("x"), subagentId: SubagentId.make("s1") })
  );

  expect(startOf(own)).toBe(at(2_000));
});
