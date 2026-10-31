import { Schema } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export const DataWriteTraceStep = Schema.Struct({
  action: Schema.Literals(["preview", "approve", "deny", "execute", "retry", "end"]),
  affected: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  value: Schema.Int,
  phase: Schema.Literals(["pending", "approved", "denied", "completed", "failed"]),
});

export const DataWriteTrace = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Literal("data-queries-write"),
  steps: Schema.Array(DataWriteTraceStep).check(Schema.isMaxLength(1000)),
});

function actions(step: typeof DataWriteTraceStep.Type) {
  switch (step.action) {
    case "preview":
      return `.then(dryRun(${step.affected})).then(request)`;
    case "approve":
      return ".then(allow)";
    case "deny":
      return ".then(deny)";
    case "execute":
      return `.then(claim).then(execute(${step.affected}))`;
    case "end":
      return ".then(endTurn)";
    case "retry":
      return ".then(retry)";
  }
}

export async function replayDataWrite(input: typeof DataWriteTrace.Type) {
  const trace = Schema.decodeUnknownSync(DataWriteTrace)(input);
  const root = resolve(import.meta.dir, "../..");
  const directory = await mkdtemp(join(tmpdir(), "data-write-replay-"));

  try {
    await writeFile(join(directory, "polaris.qnt"), await readFile(join(root, "polaris.qnt")));

    const steps = trace.steps
      .map(
        (step) =>
          `${actions(step)}.expect(write.value == ${step.value} and write.phase == "${step.phase}" and safety)`
      )
      .join("\n");

    const path = join(directory, "replay.qnt");
    await writeFile(
      path,
      `module write_replay {\nimport data_writes.* from "./polaris"\nrun actualWriteTest = init\n${steps}\n}\n`
    );

    const child = Bun.spawn(
      [join(root, "node_modules/.bin/quint"), "test", path, "--main=write_replay"],
      { stdout: "pipe", stderr: "pipe" }
    );

    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (code !== 0) throw new Error(`Data write replay rejected: ${output}${error}`);

    return { steps: trace.steps.length, output };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
