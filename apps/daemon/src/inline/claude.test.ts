import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Fiber, Result, Stream } from "effect";
import { claudeArgs, claudeInline } from "./claude.ts";
import { instructions, patchJsonSchema } from "./patch.ts";
import { propose } from "./proposal.ts";
import { request } from "./testing.ts";
import { npmFake } from "../harness/testing/shellFake.ts";
import { isRunning } from "../platform/processes.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

const roots: Array<string> = [];

// Windows holds the fake's node.exe for a moment after the stream ends.
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempDirSettled(root);
});

/** A claude installed by npm: on Windows its `.cmd` shim, which can't be handed JSON. */
const fake = (source: string) => {
  const root = newTempDir("pi-inline-claude-");
  roots.push(root);

  return { root, binary: npmFake(root, "claude", source) };
};

test("Claude print mode only exposes Read and uses an isolated structured-output request", async () => {
  const patch = { replacements: [{ from: 7, to: 9, text: "replacement" }], summary: "Change" };

  const { root, binary } = fake(`
const input = await Bun.stdin.text();
await Bun.write('input.json', input);
await Bun.write('argv.json', JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:'stream_event',event:{delta:{partial_json:'proposal'}}}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:${JSON.stringify(patch)}}));
`);

  const items = await Effect.runPromise(
    propose(request(), root, claudeInline(binary)).pipe(Stream.runCollect)
  );

  expect(items).toHaveLength(2);
  expect(items[1]).toMatchObject({ patch });
  expect(await Bun.file(join(root, "input.json")).text()).toContain(
    request().content.replaceAll("\r", "\\r").replaceAll("\n", "\\n")
  );
  // The JSON schema, the JSON configs and the prompt reach claude whole, shim or not.
  expect(await Bun.file(join(root, "argv.json")).json()).toEqual(
    claudeArgs({
      instructions,
      schema: patchJsonSchema,
      model: request().model,
      effort: request().effort,
      read: true,
    })
  );

  const args = claudeArgs({
    instructions: "",
    schema: {},
    model: "model",
    effort: "high",
    read: true,
  });

  expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
    "--tools",
    "Read",
  ]);
  expect(args).toContain("--no-session-persistence");
  expect(args).toContain("--restricted");
  expect(args).toContain("--strict-mcp-config");
});

test("cancelling Claude kills the print process", async () => {
  const { root, binary } = fake(`
// Renamed into place: until a write lands, a reader finds the file empty, and pid 0 is alive.
await Bun.write('started.tmp', String(process.pid));
require('node:fs').renameSync('started.tmp', 'started');
setInterval(() => {}, 1000);
`);

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(
          propose(request(), root, claudeInline(binary)).pipe(Stream.runDrain)
        );

        while (!(yield* Effect.promise(() => Bun.file(join(root, "started")).exists())))
          yield* Effect.sleep(10);

        const pid = Number(yield* Effect.promise(() => Bun.file(join(root, "started")).text()));
        yield* Fiber.interrupt(fiber);

        expect(isRunning(pid)).toBe(false);
      })
    )
  );
});

test("Claude exiting before structured output reports a typed Harness failure", async () => {
  const { root, binary } = fake("process.exit(42);");

  const result = await Effect.runPromise(
    propose(request(), root, claudeInline(binary)).pipe(Stream.runCollect, Effect.result)
  );

  expect(Result.isFailure(result) && result.failure.reason).toBe("harness-failed");
});
