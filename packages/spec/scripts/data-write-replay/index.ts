import { Schema } from "effect";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { DataWriteTrace, observationActions } from "./observations.ts";

export { DataWriteTrace, DataWriteTraceStep } from "./observations.ts";

export async function replayDataWrite(input: typeof DataWriteTrace.Type) {
  const trace = Schema.decodeUnknownSync(DataWriteTrace)(input);
  const root = resolve(import.meta.dir, "../..");
  const directory = await mkdtemp(join(tmpdir(), "data-write-replay-"));

  try {
    for (const file of await readdir(root)) {
      if (file.endsWith(".qnt")) await copyFile(join(root, file), join(directory, file));
    }

    const steps = trace.steps
      .map(
        (step, i) =>
          `${observationActions(step, trace.steps[i - 1])}.expect(write.value == ${step.value} and write.external == ${step.external} and write.phase == "${step.status}" and safety)`
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
