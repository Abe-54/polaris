import { expect, test } from "bun:test";
import { ConstellationFinding, ConstellationRejected, SessionId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { fakeCommands, leadBinding, workerBinding } from "../testing.ts";
import { RETRY_WINDOW_MS, idempotency } from "./idempotency.ts";
import { constellationTools } from "./index.ts";

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const call = (
  tools: ReturnType<typeof constellationTools>,
  name: string,
  input: Readonly<Record<string, typeof Schema.Json.Type | undefined>>
) => {
  const tool = tools.find((entry) => entry.name === name);

  if (!tool) throw new Error(`No ${name} tool`);

  return tool.call(json(JSON.stringify(input)));
};

const S = SessionId.make("s1");

const Properties = Schema.decodeUnknownSync(
  Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) })
);

test("every mutating tool takes requestId; status doesn't", () => {
  const { commands } = fakeCommands();

  for (const binding of [leadBinding, workerBinding])
    for (const tool of constellationTools(binding, commands)) {
      const properties = Object.keys(Properties(tool.inputSchema).properties);

      expect([tool.name, properties.includes("requestId")]).toEqual([
        tool.name,
        ![
          "status",
          "read_worker",
          "wait_for_command",
          // A retried call asks again; the user sees one card per call.
          "request_secret",
          "sessions",
          "search_history",
          "read_history",
          "data_sources",
          "describe",
          "query",
          "traces",
          "trace",
          "span",
          // Its input is exactly VisualizeInput; a retry only shows the page again.
          "visualize",
        ].includes(tool.name),
      ]);
    }
});

test("a retried call with the same requestId commits under the same id", async () => {
  const fake = fakeCommands();
  const tools = constellationTools(workerBinding, fake.commands);
  const note = { note: "Checks passed", requestId: "r-1" };

  await call(tools, "progress", note);
  await call(tools, "progress", note);
  await call(tools, "progress", { ...note, requestId: "r-2" });
  await call(tools, "progress", { ...note, note: "Other note" });

  const [first, retry, other, changed] = fake.calls.map((c) => c.id);

  expect(retry).toBe(first);
  expect(other).not.toBe(first);
  expect(changed).not.toBe(first);
  expect(fake.calls[0]?.command).not.toHaveProperty("requestId");
});

test("requestId ids are stable across catalogs and Daemon restarts", async () => {
  const one = fakeCommands();
  const two = fakeCommands();
  const input = { to: "all", text: "Rebase on main", requestId: "m-1" };

  await call(constellationTools(leadBinding, one.commands), "message", input);
  await call(constellationTools(leadBinding, two.commands), "message", input);

  expect(one.calls[0]?.id).toBe(two.calls[0]?.id ?? "");
});

test("a malformed requestId is an input error and commits nothing", async () => {
  const fake = fakeCommands();
  const tools = constellationTools(workerBinding, fake.commands);

  for (const requestId of ["", 7, "x".repeat(201)]) {
    const result = await call(tools, "progress", { note: "n", requestId });

    expect(result.isError).toBe(true);
  }

  expect(fake.calls).toHaveLength(0);
});

test("without a key, an identical call inside the retry window reuses the id", () => {
  let now = 0;
  const ids = idempotency(() => now);
  const first = ids.begin(S, "progress", undefined, { note: "a" });

  expect(ids.begin(S, "progress", undefined, { note: "a" }).id).toBe(first.id);
  expect(ids.begin(S, "progress", undefined, { note: "b" }).id).not.toBe(first.id);
  expect(ids.begin(SessionId.make("s2"), "progress", undefined, { note: "a" }).id).not.toBe(
    first.id
  );
  expect(ids.begin(S, "ask", undefined, { note: "a" }).id).not.toBe(first.id);

  now += RETRY_WINDOW_MS + 1;
  expect(ids.begin(S, "progress", undefined, { note: "a" }).id).not.toBe(first.id);
});

test("key order doesn't change the id", () => {
  const ids = idempotency();
  const a = ids.begin(S, "plan", "k", { operations: [], resources: { a: 1, b: 2 } });
  const b = ids.begin(S, "plan", "k", { resources: { b: 2, a: 1 }, operations: [] });

  expect(a.id).toBe(b.id);
});

test("a rejected call is forgotten, so trying again acts", async () => {
  const fake = fakeCommands();
  const ids: Array<string> = [];
  let reject = true;

  const busy = new ConstellationRejected({
    findings: [new ConstellationFinding({ code: "E-BUSY", message: "Busy", fix: "Wait" })],
    graph: null,
    revision: 1,
  });

  const tools = constellationTools(workerBinding, {
    ...fake.commands,
    command: (binding, id, command) => {
      ids.push(id);

      return reject ? Effect.fail(busy) : fake.commands.command(binding, id, command);
    },
  });

  expect((await call(tools, "progress", { note: "n" })).isError).toBe(true);
  reject = false;
  await call(tools, "progress", { note: "n" });
  await call(tools, "progress", { note: "n" });

  expect(ids[1]).not.toBe(ids[0]);
  expect(ids[2]).toBe(ids[1]);
});
