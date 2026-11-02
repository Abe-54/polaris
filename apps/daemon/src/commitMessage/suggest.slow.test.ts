import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  type CommitMessage,
  type CommitMessageError,
  type CommitMessageStreamItem,
  CommitMessageStreamItem as Item,
} from "@polaris/protocol";
import { Deferred, Effect, Fiber, Layer, Result, Stream } from "effect";
import { HarnessError } from "../harness/HarnessDriver.ts";
import { claudeArgs } from "../inline/claude.ts";
import type { StructuredJob } from "../inline/structured.ts";
import type { MessageBackend } from "./backend.ts";
import { benchMessage } from "./bench.ts";
import { instructions, messageJsonSchema } from "./prompt.ts";
import { suggest } from "./suggest.ts";
import { availability, repo, request, stageFile } from "./testing.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tracked = (subjects: ReadonlyArray<string> = []) => {
  const root = repo(subjects);
  roots.push(root);

  return root;
};

const recording = (output: CommitMessage) => {
  const jobs: Array<StructuredJob> = [];

  const backend: MessageBackend = (_harness, job, _cwd, progress) =>
    Effect.as(progress("thinking"), output).pipe(
      Effect.tap(() => Effect.sync(() => jobs.push(job)))
    );

  return { jobs, backend };
};

const run = (
  stream: Stream.Stream<CommitMessageStreamItem, CommitMessageError>
): Promise<Result.Result<ReadonlyArray<CommitMessageStreamItem>, CommitMessageError>> =>
  Effect.runPromise(stream.pipe(Stream.runCollect, Effect.result));

const reason = (result: Result.Result<unknown, CommitMessageError>) =>
  Result.isFailure(result) ? result.failure.reason : null;

test("nothing staged is refused before any Harness runs", async () => {
  const root = tracked(["feat: start"]);
  const { jobs, backend } = recording({ subject: "x", body: "" });

  const result = await run(
    suggest(request(root), backend).pipe(Stream.provide(availability("ready")))
  );

  expect(reason(result)).toBe("nothing-staged");
  expect(jobs).toHaveLength(0);
});

test("a folder outside git is refused", async () => {
  const { backend } = recording({ subject: "x", body: "" });

  const result = await run(
    suggest(request("/"), backend).pipe(Stream.provide(availability("ready")))
  );

  expect(reason(result)).toBe("not-a-repository");
});

test("streams progress, then one tidied message; recent subjects are the style examples", async () => {
  const root = tracked(["feat(git): stage from the tab", "fix(desktop): keep the ring"]);
  stageFile(root, "a.ts", "export const a = 1;\n");
  const { jobs, backend } = recording({ subject: " Add a.\nSecond line ", body: "Why.\n" });

  const result = await run(
    suggest(request(root), backend).pipe(Stream.provide(availability("ready")))
  );

  const items = Result.getOrThrow(result);

  expect(items[0]).toEqual(Item.cases.Delta.make({ text: "thinking" }));
  expect(items[1]).toMatchObject({
    message: { subject: "Add a", body: "Second line\n\nWhy." },
    truncated: false,
  });
  expect(jobs[0]?.prompt).toContain(
    "- fix(desktop): keep the ring\n- feat(git): stage from the tab"
  );
  expect(jobs[0]?.prompt).toContain("+export const a = 1;");
  expect(jobs[0]?.read).toBe(false);
});

test("an unborn branch has no style examples and still describes the index", async () => {
  const root = tracked();
  stageFile(root, "first.ts", "1\n");
  const { jobs, backend } = recording({ subject: "Start", body: "" });

  await run(suggest(request(root), backend).pipe(Stream.provide(availability("ready"))));

  expect(jobs[0]?.prompt).toContain("no earlier commits");
  expect(jobs[0]?.prompt).toContain("first.ts");
});

test("a diff over the budget is cut with a note, and the message says it was", async () => {
  const root = tracked(["init"]);
  stageFile(root, "big.txt", `${"line of text\n".repeat(2000)}`);
  stageFile(root, "small.txt", "tail\n");
  const { jobs, backend } = recording({ subject: "Add files", body: "" });

  const result = await run(
    suggest(request(root), backend, 4000).pipe(Stream.provide(availability("ready")))
  );

  expect(Result.getOrThrow(result).at(-1)).toMatchObject({ truncated: true });
  expect(jobs[0]?.prompt).toContain("[diff truncated at 4 KB: 2 of 2 files");
  expect(jobs[0]?.prompt).toContain("small.txt");
  expect(jobs[0]?.prompt.length).toBeLessThan(6000);
});

test("a Harness that isn't signed in is reported as such", async () => {
  const root = tracked(["init"]);
  stageFile(root, "a.ts", "a\n");
  const { backend } = recording({ subject: "x", body: "" });

  const refused = await run(
    suggest(request(root), backend).pipe(Stream.provide(availability("needs-sign-in")))
  );

  expect(reason(refused)).toBe("needs-sign-in");

  const failing: MessageBackend = (harness) =>
    Effect.fail(new HarnessError({ harness, message: "401" }));

  const failed = await run(
    suggest(request(root), failing).pipe(Stream.provide(availability("ready", "not-installed")))
  );

  expect(reason(failed)).toBe("harness-missing");
});

test("a stale cached refusal is checked again before giving up", async () => {
  const root = tracked(["init"]);
  stageFile(root, "a.ts", "a\n");
  const { jobs, backend } = recording({ subject: "Add a", body: "" });

  const result = await run(
    suggest(request(root), backend).pipe(Stream.provide(availability("needs-sign-in", "ready")))
  );

  expect(Result.isSuccess(result)).toBe(true);
  expect(jobs).toHaveLength(1);
});

test("output that isn't a message is an invalid message, other failures are the Harness's", async () => {
  const root = tracked(["init"]);
  stageFile(root, "a.ts", "a\n");

  const invalid = await run(
    suggest(request(root, 'bench:{"message":"not json"}'), benchMessage).pipe(
      Stream.provide(availability("ready"))
    )
  );

  expect(reason(invalid)).toBe("invalid-message");

  const bench = await run(
    suggest(request(root, 'bench:{"fail":"boom"}'), benchMessage).pipe(
      Stream.provide(availability("ready"))
    )
  );

  expect(reason(bench)).toBe("harness-failed");
});

test("the bench Harness drafts from the file list; closing the stream cancels it", async () => {
  const root = tracked(["init"]);
  stageFile(root, "notes.md", "hello\n");

  const result = await run(
    suggest(request(root), benchMessage).pipe(Stream.provide(availability("ready")))
  );

  expect(Result.getOrThrow(result).at(-1)).toMatchObject({
    message: { subject: "Update notes.md", body: "" },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();

        const fiber = yield* Effect.forkScoped(
          suggest(request(root, 'bench:{"delayMs":60000}'), benchMessage).pipe(
            Stream.provide(Layer.fresh(availability("ready"))),
            Stream.runForEach(() => Deferred.succeed(started, undefined))
          )
        );

        yield* Deferred.await(started);
        const before = performance.now();
        yield* Fiber.interrupt(fiber);

        expect(performance.now() - before).toBeLessThan(1000);
      })
    )
  );
});

test("Claude Code gets no tools at all: the diff is in the prompt", () => {
  const args = claudeArgs({
    instructions,
    schema: messageJsonSchema,
    model: "claude-haiku-5-5",
    effort: null,
    read: false,
  });

  expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
  expect(args).not.toContain("--allowedTools");
  expect(args).toContain("--no-session-persistence");
});
