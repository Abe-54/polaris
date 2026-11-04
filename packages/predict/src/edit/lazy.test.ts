import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { Schema } from "effect";

const Probe = Schema.Struct({
  before: Schema.Array(Schema.String),
  after: Schema.Array(Schema.String),
});

test("a fresh FIM consumer loads no edit diff code until an Edit Prediction is consumed", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { createEditPredictor, createPredictor } from "./src/index.ts";
    import { Effect, Stream } from "effect";
    createPredictor();
    const loaded = () => Object.keys(require.cache).filter(p => p.replaceAll("\\\\", "/").includes("syntax-diff/src/"));
    const frame = { choices: [{ text: "<|marker_1|>abc\\n<|marker_2|>", finish_reason: "stop" }] };
    const predictor = createEditPredictor(async () => new Response("data: " + JSON.stringify(frame) + "\\n\\n"));
    const before = loaded();
    await Effect.runPromise(predictor.predict({
      buffer: "ab", cursor: 2, focus: null, history: [], context: [], path: "file.ts",
      model: "test", format: "zeta-2.1", maxTokens: 32,
      endpoint: {kind: "openai", url: "http://127.0.0.1:9999"}
    }).pipe(Stream.runDrain));
    console.log(JSON.stringify({before, after: loaded()}));
  `,
    ],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdout: "pipe", stderr: "pipe" }
  );

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(stderr).toBe("");
  expect(code).toBe(0);
  const result = Schema.decodeUnknownSync(Schema.fromJsonString(Probe))(stdout.trim());
  expect(result.before).toEqual([]);
  expect(result.after.length).toBeGreaterThan(0);
});
