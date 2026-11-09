import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { graphResult } from "../../constellation/service.ts";
import { listed, mixedRecord } from "../../constellation/statusView.testing.ts";
import { fakeCommands, leadBinding } from "../testing.ts";
import { constellationTools } from "./index.ts";

const tools = () => {
  const { commands } = fakeCommands();

  return constellationTools(leadBinding, {
    ...commands,
    status: (_binding, _id, json, view) =>
      Effect.succeed(graphResult(mixedRecord(), null, json, undefined, undefined, undefined, view)),
  });
};

interface StatusInput {
  readonly json?: boolean;
  readonly task?: string;
  readonly openOnly?: boolean;
}

const status = async (input: StatusInput) => {
  const tool = tools().find((entry) => entry.name === "status")!;
  const result = await tool.call(Schema.decodeUnknownSync(Schema.Json)(input));

  return result.content[0]?.text ?? "";
};

const graphJson = (text: string) =>
  Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        constellation: Schema.Struct({
          tasks: Schema.Array(Schema.Struct({ id: Schema.String })),
          attempts: Schema.Array(Schema.Struct({ id: Schema.String })),
        }),
      })
    )
  )(text.split("\n").find((line) => line.startsWith("{"))!);

test("status passes task and openOnly through to the outline", async () => {
  expect(listed(await status({ task: "P" }))).toEqual(["P", "P1", "P2"]);
  expect(listed(await status({ openOnly: true }))).toEqual(["B", "P", "P2"]);
});

test("status JSON keeps only each Task's latest Attempt", async () => {
  const { constellation } = graphJson(await status({ json: true }));

  expect(constellation.attempts.map((a) => a.id)).toEqual(["a1", "b1", "p1"]);
  expect(graphJson(await status({ json: true, task: "B" })).constellation.tasks).toEqual([
    expect.objectContaining({ id: "B" }),
  ]);
});
